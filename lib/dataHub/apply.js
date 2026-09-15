import { planImport, fingerprintStillValid } from "./plan.js";
import ADAPTERS from "./adapters.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — APPLY. Só roda depois que:
//   1. o fingerprint do preview foi revalidado contra o estado REAL agora
//      (item 53 — concorrência otimista: se algo mudou, ABORT, nunca aplica
//      um plano velho);
//   2. o plano foi RECALCULADO do zero com a mesma função do preview (item
//      43 — nunca uma segunda lógica "de verdade" diferente da de preview).
//
// Tudo dentro de UMA `prisma.$transaction` (item 55) — se qualquer coisa
// falhar no meio, nada fica meio-aplicado. `preimages` grava o estado
// ANTERIOR de cada linha tocada, pra o undo de 24h (item 58/59) ter algo
// real pra restaurar.
// ============================================================================

export class StaleImportError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StaleImportError";
    this.code = "STALE_IMPORT";
  }
}

export async function applyImportBatch(prisma, batch) {
  const { mode, datasets, rows: rowsBySheet, resolutions } = batch;

  const staleCheck = await fingerprintStillValid(prisma, batch.planFingerprint || []);
  if (!staleCheck.valid) throw new StaleImportError(staleCheck.reason);

  const freshPlan = await planImport({ prisma, mode, datasets, rowsBySheet });

  return prisma.$transaction(async (tx) => {
    const preimages = [];
    const counts = { created: 0, updated: 0, skipped: 0, invalid: 0, deleted: 0 };

    for (const key of datasets) {
      const adapter = ADAPTERS[key];
      if (!adapter) continue;
      const bucket = freshPlan.perDataset[key];
      if (!bucket) continue;

      for (const c of bucket.creates) {
        const created = await tx[adapter.model].create({ data: c.data });
        preimages.push({ model: adapter.model, id: created.id, before: null }); // undo de um CREATE = deletar
        counts.created++;
      }

      for (const u of bucket.updates) {
        const before = await tx[adapter.model].findUnique({ where: { id: u.id } });
        await tx[adapter.model].update({ where: { id: u.id }, data: u.data });
        preimages.push({ model: adapter.model, id: u.id, before: serializePreimage(before) });
        counts.updated++;
      }

      for (const conf of bucket.conflicts) {
        const resolution = resolutions?.[conf.conflictKey];
        if (resolution !== "usar") continue; // manter | rever | ausente -> nunca aplica
        const before = await tx[adapter.model].findUnique({ where: { id: conf.id } });
        await tx[adapter.model].update({ where: { id: conf.id }, data: conf.data });
        preimages.push({ model: adapter.model, id: conf.id, before: serializePreimage(before) });
        counts.updated++;
      }

      counts.skipped += bucket.skips.length;
      counts.invalid += bucket.invalid.length;
    }

    return { counts, preimages, plan: freshPlan };
  });
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
