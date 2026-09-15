import { planImport, fingerprintStillValid } from "./plan.js";
import ADAPTERS from "./adapters.js";

// ============================================================================
// Fase 6.0.1 (Integrity Closure) — APPLY. UMA ÚNICA transação lógica contém:
// mutação financeira + ImportBatch.status=APPLIED (+ contadores/preimages) +
// DataOperation IMPORT_APPLY. Se QUALQUER parte falhar — inclusive a escrita
// do log de auditoria — a transação inteira reverte: zero efeito financeiro,
// ImportBatch continua PENDING_APPLY. Uma operação financeira não pode
// "ter acontecido" sem deixar rastro auditável; um audit-log best-effort
// (a correção anterior, Fase 6.0) permitia exatamente isso e foi corrigida.
//
// A checagem de concorrência otimista (fingerprint) roda DUAS vezes: uma
// vez antes de abrir a transação (falha rápida, sem nem tentar) e de novo
// DENTRO da transação, contra o mesmo client `tx` que vai escrever — fecha
// a janela entre "eu decidi que ia aplicar" e "eu realmente apliquei".
// ============================================================================

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export class StaleImportError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StaleImportError";
    this.code = "STALE_IMPORT";
  }
}

export async function applyImportBatch(prisma, batch) {
  const { id: batchId, mode, datasets, rows: rowsBySheet, resolutions, fileName, fileHash } = batch;

  const preCheck = await fingerprintStillValid(prisma, batch.planFingerprint || []);
  if (!preCheck.valid) throw new StaleImportError(preCheck.reason);

  return prisma.$transaction(async (tx) => {
    // Revalidação DENTRO da transação — o pre-check acima pode ter ficado
    // stale entre o momento em que rodou e o início desta transação.
    const staleCheck = await fingerprintStillValid(tx, batch.planFingerprint || []);
    if (!staleCheck.valid) throw new StaleImportError(staleCheck.reason);

    const freshPlan = await planImport({ prisma: tx, mode, datasets, rowsBySheet });

    const preimages = [];
    const counts = { created: 0, updated: 0, skipped: 0, invalid: 0, deleted: 0 };

    for (const key of datasets) {
      const adapter = ADAPTERS[key];
      if (!adapter) continue;
      const bucket = freshPlan.perDataset[key];
      if (!bucket) continue;

      for (const c of bucket.creates) {
        const created = await tx[adapter.model].create({ data: c.data });
        // undo de um CREATE = deletar; `afterUpdatedAt` é o guard de
        // concorrência do undo (item 12 da closure) — se o registro mudar
        // depois do apply, o undo detecta e aborta em vez de sobrescrever.
        preimages.push({ model: adapter.model, id: created.id, before: null, afterUpdatedAt: toIso(created.updatedAt) });
        counts.created++;
      }

      for (const u of bucket.updates) {
        const before = await tx[adapter.model].findUnique({ where: { id: u.id } });
        const updated = await tx[adapter.model].update({ where: { id: u.id }, data: u.data });
        preimages.push({ model: adapter.model, id: u.id, before: serializePreimage(before), afterUpdatedAt: toIso(updated.updatedAt) });
        counts.updated++;
      }

      for (const conf of bucket.conflicts) {
        const resolution = resolutions?.[conf.conflictKey];
        if (resolution !== "usar") continue; // manter | rever | ausente -> nunca aplica
        const before = await tx[adapter.model].findUnique({ where: { id: conf.id } });
        const updated = await tx[adapter.model].update({ where: { id: conf.id }, data: conf.data });
        preimages.push({ model: adapter.model, id: conf.id, before: serializePreimage(before), afterUpdatedAt: toIso(updated.updatedAt) });
        counts.updated++;
      }

      counts.skipped += bucket.skips.length;
      counts.invalid += bucket.invalid.length;
    }

    const now = new Date();
    const undoDeadline = new Date(now.getTime() + UNDO_WINDOW_MS);
    const conflictCount = Object.values(freshPlan.perDataset || {}).reduce((a, b) => a + (b.conflicts?.length || 0), 0);

    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: "APPLIED",
        appliedAt: now,
        undoDeadline,
        preimages,
        resolutions: resolutions || undefined,
        resultCounts: counts,
      },
    });

    // Mesma transação — se este create() falhar, TUDO acima reverte junto
    // (item 2 da closure: nunca "aplicou mas não foi auditado").
    await tx.dataOperation.create({
      data: {
        type: "IMPORT_APPLY",
        status: counts.invalid > 0 ? "PARTIAL" : "SUCCESS",
        mode,
        datasets,
        fileName,
        fileHash,
        createdCount: counts.created,
        updatedCount: counts.updated,
        skippedCount: counts.skipped,
        conflictCount,
        deletedCount: counts.deleted,
        importBatchId: batchId,
      },
    });

    return { counts, preimages, plan: freshPlan, undoDeadline };
  });
}

function toIso(v) {
  return v instanceof Date ? v.toISOString() : v ?? null;
}

// Decimal/Date não sobrevivem JSON.stringify de forma útil sem conversão —
// preimages são gravados em ImportBatch.preimages (Json), então tudo vira
// primitivo aqui, na captura, nunca na hora de ler de volta.
function serializePreimage(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v.toNumber === "function") out[k] = v.toNumber();
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}
