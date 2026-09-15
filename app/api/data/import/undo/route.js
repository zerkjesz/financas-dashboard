import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { undoImportBatch, UndoWindowExpiredError } from "@/lib/dataHub/undo";

// Fase 6.0 (Design Freeze) — DESFAZER uma importação aplicada, dentro da
// janela de 24h. Autenticado + CSRF via middleware.js.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { batchId } = body || {};
  if (!batchId) return NextResponse.json({ error: "batch_id_required" }, { status: 400 });

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) return NextResponse.json({ error: "batch_not_found" }, { status: 404 });
  if (batch.status !== "APPLIED") return NextResponse.json({ error: "not_applied", status: batch.status }, { status: 409 });

  try {
    const result = await undoImportBatch(prisma, batch);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "UNDONE", undoneAt: new Date() } });
    await prisma.dataOperation.create({
      data: {
        type: "IMPORT_UNDO",
        status: "SUCCESS",
        mode: batch.mode,
        datasets: batch.datasets,
        fileName: batch.fileName,
        fileHash: batch.fileHash,
        createdCount: result.restored,
        deletedCount: result.deleted,
        importBatchId: null, // o batch original já tem seu próprio DataOperation; este é um evento novo, solto.
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UndoWindowExpiredError) {
      return NextResponse.json({ error: "undo_window_expired", message: err.message }, { status: 409 });
    }
    console.error("[api/data/import/undo] falha ao desfazer:", err.message);
    return NextResponse.json({ error: "undo_failed", message: "Não foi possível desfazer — nada foi alterado (transação revertida)." }, { status: 500 });
  }
}
