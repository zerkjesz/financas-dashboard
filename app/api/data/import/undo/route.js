import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { undoImportBatch, UndoWindowExpiredError, UndoStaleStateError } from "@/lib/dataHub/undo";

// Fase 6.0 (Design Freeze) / 6.0.1 (Integrity Closure) — DESFAZER uma
// importação aplicada, dentro da janela de 24h. Autenticado + CSRF via
// middleware.js. As restaurações, o status=UNDONE e o DataOperation
// IMPORT_UNDO agora são escritos em UMA ÚNICA transação dentro de
// undoImportBatch (lib/dataHub/undo.js) — mesma exigência de atomicidade do
// apply.
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
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UndoWindowExpiredError) {
      return NextResponse.json({ error: "undo_window_expired", message: err.message }, { status: 409 });
    }
    if (err instanceof UndoStaleStateError) {
      return NextResponse.json({ error: "undo_stale_state", message: err.message, details: err.details }, { status: 409 });
    }
    console.error("[api/data/import/undo] falha ao desfazer (transação revertida):", err.message);
    return NextResponse.json({ error: "undo_failed", message: "Não foi possível desfazer — nada foi alterado (transação revertida)." }, { status: 500 });
  }
}
