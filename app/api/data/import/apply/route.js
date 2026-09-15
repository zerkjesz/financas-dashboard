import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applyImportBatch, StaleImportError } from "@/lib/dataHub/apply";
import { applyReplace } from "@/lib/dataHub/replace";

// Fase 6.0 (Design Freeze) / 6.0.1 (Integrity Closure) — APPLY. Autenticado +
// CSRF via middleware.js (POST, mesmo contrato de qualquer outra mutação —
// item 56 do pedido original).
//
// A mutação financeira, o status=APPLIED e o DataOperation IMPORT_APPLY
// agora são escritos em UMA ÚNICA transação dentro de applyImportBatch/
// applyReplace (lib/dataHub/apply.js, lib/dataHub/replace.js) — esta rota
// nunca mais escreve nenhum desses três passos separadamente. Se a
// transação falhar por qualquer motivo, nada foi commitado: zero efeito
// financeiro, ImportBatch continua PENDING_APPLY, e é seguro tentar de novo.
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

  // Idempotência (item 7 da closure 6.0.1) — reaplicar o MESMO batch já
  // aplicado devolve os contadores gravados NO PRÓPRIO ImportBatch
  // (`resultCounts`, escrito na mesma transação do apply original), nunca
  // reexecuta a mutação e nunca depende de reconsultar um DataOperation
  // específico (o campo importBatchId não é mais @unique — pode haver N
  // eventos de auditoria pro mesmo batch).
  if (batch.status === "APPLIED") {
    return NextResponse.json({
      alreadyApplied: true,
      counts: batch.resultCounts || null,
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

  // "Substituir" exige a frase de confirmação exata (item 45/60 do pedido
  // original) — checado aqui, servidor, nunca só no cliente.
  if (batch.mode === "replace" && String(confirmText || "").trim().toUpperCase() !== "SUBSTITUIR") {
    return NextResponse.json({ error: "confirmation_required", message: 'Escreva SUBSTITUIR pra confirmar.' }, { status: 400 });
  }

  try {
    let result;
    if (batch.mode === "replace") {
      result = await applyReplace(prisma, { id: batch.id, datasets: batch.datasets, period: body.period, rowsBySheet: batch.rows, fileName: batch.fileName, fileHash: batch.fileHash });
    } else {
      result = await applyImportBatch(prisma, {
        id: batch.id,
        mode: batch.mode,
        datasets: batch.datasets,
        rows: batch.rows,
        resolutions: resolutions || {},
        planFingerprint: batch.planFingerprint,
        fileName: batch.fileName,
        fileHash: batch.fileHash,
      });
    }

    return NextResponse.json({ ok: true, counts: result.counts, undoDeadline: result.undoDeadline });
  } catch (err) {
    if (err instanceof StaleImportError) {
      return NextResponse.json({ error: "stale_import", message: "Os dados mudaram desde a revisão. Valide novamente." }, { status: 409 });
    }
    // A transação inteira reverteu — zero efeito financeiro, ImportBatch
    // continua PENDING_APPLY. Este registro de FAILED é uma escrita nova e
    // independente (não pode fazer parte da transação que acabou de
    // reverter); best-effort é aceitável aqui porque não existe mutação
    // financeira nenhuma pra este best-effort "mentir" sobre.
    console.error("[api/data/import/apply] falha ao aplicar (transação revertida, zero efeito financeiro):", err.message);
    await prisma.dataOperation
      .create({ data: { type: "IMPORT_FAILED", status: "FAILED", mode: batch.mode, datasets: batch.datasets, fileName: batch.fileName, fileHash: batch.fileHash, errorMessage: err.message, importBatchId: batch.id } })
      .catch(() => {});
    return NextResponse.json({ error: "apply_failed", message: "A importação falhou — nada foi aplicado (transação revertida)." }, { status: 500 });
  }
}
