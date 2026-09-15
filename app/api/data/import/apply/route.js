import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyImportBatch, StaleImportError } from "@/lib/dataHub/apply";
import { applyReplace } from "@/lib/dataHub/replace";

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

// Fase 6.0 (Design Freeze) — APPLY. Autenticado + CSRF via middleware.js
// (POST, mesmo contrato de qualquer outra mutação — item 56 do pedido).
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { batchId, resolutions, confirmText } = body || {};
  if (!batchId) return NextResponse.json({ error: "batch_id_required" }, { status: 400 });

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) return NextResponse.json({ error: "batch_not_found" }, { status: 404 });

  // Idempotência (item 54) — reaplicar o MESMO batch já aplicado devolve o
  // resultado JÁ REGISTRADO (a linha de Atividade gravada na 1ª aplicação),
  // nunca reexecuta a mutação.
  if (batch.status === "APPLIED") {
    const priorOp = await prisma.dataOperation.findUnique({ where: { importBatchId: batch.id } });
    return NextResponse.json({
      alreadyApplied: true,
      counts: priorOp
        ? { created: priorOp.createdCount, updated: priorOp.updatedCount, skipped: priorOp.skippedCount, deleted: priorOp.deletedCount, invalid: 0 }
        : null,
      undoDeadline: batch.undoDeadline,
    });
  }
  if (batch.status !== "PENDING_APPLY") {
    return NextResponse.json({ error: "batch_not_pending", status: batch.status }, { status: 409 });
  }
  if (new Date() > new Date(batch.expiresAt)) {
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "EXPIRED" } }).catch(() => {});
    return NextResponse.json({ error: "batch_expired", message: "A revisão expirou. Envie o arquivo de novo." }, { status: 409 });
  }

  // "Substituir" exige a frase de confirmação exata (item 45/60) — checado
  // aqui, servidor, nunca só no cliente.
  if (batch.mode === "replace" && String(confirmText || "").trim().toUpperCase() !== "SUBSTITUIR") {
    return NextResponse.json({ error: "confirmation_required", message: 'Escreva SUBSTITUIR pra confirmar.' }, { status: 400 });
  }

  try {
    let result;
    if (batch.mode === "replace") {
      result = await applyReplace(prisma, { datasets: batch.datasets, period: body.period, rowsBySheet: batch.rows });
    } else {
      result = await applyImportBatch(prisma, { mode: batch.mode, datasets: batch.datasets, rows: batch.rows, resolutions: resolutions || {}, planFingerprint: batch.planFingerprint });
    }

    const now = new Date();
    const undoDeadline = new Date(now.getTime() + UNDO_WINDOW_MS);
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "APPLIED", appliedAt: now, undoDeadline, preimages: result.preimages, resolutions: resolutions || undefined },
    });

    // A mutação real (applyImportBatch/applyReplace) e o status=APPLIED
    // acima já estão commitados neste ponto — o registro de atividade abaixo
    // é só auditoria. Uma falha aqui NUNCA pode virar "apply_failed"/"nada
    // foi aplicado" pro cliente (isso já seria mentira: os dados já foram
    // escritos) — por isso tem seu próprio try/catch, igual ao padrão já
    // usado no registro de atividade do preview.
    await prisma.dataOperation
      .create({
        data: {
          type: "IMPORT_APPLY",
          status: result.counts.invalid > 0 ? "PARTIAL" : "SUCCESS",
          mode: batch.mode,
          datasets: batch.datasets,
          fileName: batch.fileName,
          fileHash: batch.fileHash,
          createdCount: result.counts.created,
          updatedCount: result.counts.updated || 0,
          skippedCount: result.counts.skipped,
          conflictCount: batch.mode === "replace" ? 0 : Object.values(result.plan.perDataset || {}).reduce((a, b) => a + (b.conflicts?.length || 0), 0),
          deletedCount: result.counts.deleted || 0,
          importBatchId: batch.id,
        },
      })
      .catch((err) => console.error("[api/data/import/apply] falha ao registrar atividade (dados já aplicados):", err.message));

    return NextResponse.json({ ok: true, counts: result.counts, undoDeadline });
  } catch (err) {
    if (err instanceof StaleImportError) {
      return NextResponse.json({ error: "stale_import", message: "Os dados mudaram desde a revisão. Valide novamente." }, { status: 409 });
    }
    console.error("[api/data/import/apply] falha ao aplicar:", err.message);
    await prisma.dataOperation
      .create({ data: { type: "IMPORT_FAILED", status: "FAILED", mode: batch.mode, datasets: batch.datasets, fileName: batch.fileName, fileHash: batch.fileHash, errorMessage: err.message } })
      .catch(() => {});
    return NextResponse.json({ error: "apply_failed", message: "A importação falhou — nada foi aplicado (transação revertida)." }, { status: 500 });
  }
}
