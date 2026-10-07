import { dateInRange, dbWindow, describeRange, resolveRange, rangeFromBounds, DataRangeError } from "./range.js";
import ADAPTERS from "./adapters.js";
import { planImport } from "./plan.js";
import { IMPORT_TRANSACTION_OPTIONS } from "./apply.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — SUBSTITUIR. Escopo FIXO e explícito (item 45:
// "replace nunca é apagar o banco"): só Receitas + Despesas + Transferências
// dentro do PERÍODO escolhido — exatamente o que a própria referência
// aprovada promete ("Suas transações de X a Y saem do Norte e entram as do
// arquivo. Metas, cartões e limites continuam iguais."). Nenhum outro
// dataset aceita "substituir" (ver ADAPTERS[key].modes — nenhum inclui
// "replace"; a UI não deve nem oferecer a opção pra eles, item 38).
//
// SEGURANÇA REFERENCIAL (item 46): uma Expense/Income linkada a um
// ExternalInstallment/ConfirmedCommitment/Receivable (settlement real) NUNCA
// é removida por um replace genérico — fica de fora do escopo deletável e
// é reportada explicitamente, nunca silenciosamente perdida via SetNull.
// ============================================================================

export const REPLACEABLE_DATASETS = ["incomes", "expenses", "transfers"];

async function findProtectedIds(prisma, dataset, ids) {
  if (ids.length === 0) return new Set();
  if (dataset === "expenses") {
    const [ei, cc] = await Promise.all([
      prisma.externalInstallment.findMany({ where: { expenseId: { in: ids } }, select: { expenseId: true } }),
      prisma.confirmedCommitment.findMany({ where: { expenseId: { in: ids } }, select: { expenseId: true } }),
    ]);
    return new Set([...ei.map((r) => r.expenseId), ...cc.map((r) => r.expenseId)].filter(Boolean));
  }
  if (dataset === "incomes") {
    const rec = await prisma.receivable.findMany({ where: { incomeId: { in: ids } }, select: { incomeId: true } });
    return new Set(rec.map((r) => r.incomeId).filter(Boolean));
  }
  return new Set();
}

export class ReplaceScopeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReplaceScopeError";
    this.code = code;
  }
}

// ============================================================================
// Fase 10.3 — ESCOPO DO SUBSTITUIR. Antes, o wizard mandava period="all" fixo e o apply usava `body.period` (que o
// wizard nem enviava => SEM FILTRO): substituir com um arquivo PARCIAL apagava o ledger inteiro. Agora o escopo é
// decidido NO SERVIDOR, a partir do período que o próprio arquivo declara (metadados do export), nunca de um estado
// da tela, e é guardado no plano do ImportBatch (o apply lê de lá).
//   * arquivo com período (ciclo, 90 dias, personalizado…) => escopo = esse período (ou um recorte DENTRO dele);
//   * arquivo "Período todo"                               => escopo = tudo (o arquivo declara ser completo);
//   * arquivo LEGADO (sem período)                         => exige De/Até explícitos; nunca inventa range.
// O usuário só pode ESTREITAR o escopo, nunca ampliá-lo além do que o arquivo cobre.
// ============================================================================
export function resolveReplaceScope({ exportMeta, requestedFrom, requestedTo } = {}) {
  let requested = null;
  if (requestedFrom || requestedTo) {
    try {
      requested = resolveRange({ preset: "custom", dateFrom: requestedFrom, dateTo: requestedTo });
    } catch (e) {
      if (e instanceof DataRangeError) throw new ReplaceScopeError(e.message, "scope_invalid");
      throw e;
    }
  }
  const hasFileRange = exportMeta && !exportMeta.legacy && exportMeta.hasBounds;
  if (!hasFileRange) {
    if (!requested) throw new ReplaceScopeError("Arquivo legado — período não informado. Para substituir, informe o período (De/Até) que este arquivo cobre.", "legacy_replace_requires_range");
    return { scope: requested, source: "user_range_legacy_file" };
  }
  const fileRange = exportMeta.rangePreset === "all_time" ? rangeFromBounds({ preset: "all_time" }) : rangeFromBounds({ preset: exportMeta.rangePreset, dateFrom: exportMeta.dateFrom, dateTo: exportMeta.dateTo });
  if (!requested) return { scope: fileRange, source: "file_range" };
  if (!fileRange.allTime && (requested.dateFrom < fileRange.dateFrom || requested.dateTo > fileRange.dateTo)) {
    throw new ReplaceScopeError(`O período a substituir (${describeRange(requested)}) passa do período que o arquivo cobre (${describeRange(fileRange)}).`, "scope_exceeds_file");
  }
  return { scope: requested, source: "user_narrowed" };
}

const fileRowDate = (row) => row.occurredAt ?? null;

// Retorna, por dataset: os IDs existentes no escopo, quais são protegidos (nunca removidos) e quais seriam removidos —
// MAIS o plano de CREATE do que vier do arquivo DENTRO do escopo. Linhas do arquivo fora do escopo são IGNORADAS
// (nunca entram), e linhas existentes fora do escopo NUNCA são candidatas à remoção: `outside.affected` é 0 por construção.
// `scope` (Fase 10.3, range) é o caminho de produção; `period` objeto literal ({gte,lt}) só existe para os testes antigos.
export async function planReplace({ prisma, datasets, period, scope, rowsBySheet }) {
  const scoped = datasets.filter((d) => REPLACEABLE_DATASETS.includes(d));
  const legacyRange = !scope && period && typeof period === "object" ? period : null;
  if (!scope && !legacyRange) throw new ReplaceScopeError("Escopo do substituir ausente — nada foi planejado.", "replace_scope_required");
  const perDataset = {};
  const reuseIds = {}; // dataset -> Map(índice da linha filtrada -> id existente que será removido e recriado com o MESMO id)
  const filteredRows = {};
  const outside = { existing: 0, affected: 0 };
  const ignoredOutOfScope = {};

  for (const key of scoped) {
    const adapter = ADAPTERS[key];
    const dateField = "occurredAt";
    let existing;
    if (scope) {
      const win = dbWindow(scope);
      const rows = await prisma[adapter.model].findMany({ where: win ? { [dateField]: win } : undefined, select: { id: true, [dateField]: true } });
      existing = rows.filter((r) => dateInRange(scope, r[dateField]));
      if (win) outside.existing += (await prisma[adapter.model].count()) - existing.length;
    } else {
      existing = await prisma[adapter.model].findMany({ where: { [dateField]: legacyRange }, select: { id: true } });
    }
    const allIds = existing.map((r) => r.id);
    const protectedIds = await findProtectedIds(prisma, key, allIds);
    const deletableIds = allIds.filter((id) => !protectedIds.has(id));
    perDataset[key] = { existingCount: allIds.length, protectedIds: [...protectedIds], deletableIds };

    // linhas do arquivo: só as DENTRO do escopo; a linha que trouxe o ID de um registro que está saindo é recriada
    // com o mesmo ID (antes o plano de adição a via como "já existe" e pulava, enquanto a antiga era apagada => perda).
    const deletable = new Set(deletableIds);
    const rows = rowsBySheet[key] || [];
    const kept = [];
    const reuse = new Map();
    let ignored = 0;
    for (const row of rows) {
      const d = fileRowDate(row);
      if (scope && d != null && !dateInRange(scope, d)) { ignored++; continue; }
      const rid = row.id != null ? String(row.id).trim() : row.ID != null ? String(row.ID).trim() : null;
      if (rid && deletable.has(rid)) {
        const { id: _i, ID: _I, ...rest } = row;
        reuse.set(kept.length, rid);
        kept.push(rest);
      } else kept.push(row);
    }
    filteredRows[key] = kept;
    reuseIds[key] = reuse;
    ignoredOutOfScope[key] = ignored;
  }

  const addPlan = await planImport({ prisma, mode: "add", datasets: scoped, rowsBySheet: filteredRows });
  for (const key of Object.keys(addPlan.perDataset)) {
    for (const c of addPlan.perDataset[key].creates) {
      const rid = reuseIds[key]?.get(c.row);
      if (rid) c.data = { ...c.data, id: rid };
    }
  }
  return { perDataset, addPlan, scope: scope ?? null, outside, ignoredOutOfScope };
}

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

// Fase 6.0.1 (Integrity Closure) — mesma exigência de atomicidade do apply
// normal (lib/dataHub/apply.js): mutação financeira + ImportBatch.status=
// APPLIED + DataOperation IMPORT_APPLY na MESMA transação. `planReplace` é
// recalculado de novo aqui (dentro da função, com o `prisma` recebido —
// nunca reaproveita um plano velho do preview), o que já dá ao Substituir
// uma proteção de concorrência mais forte que fingerprint pontual: o escopo
// de deleção é sempre derivado do estado REAL no instante do apply, nunca de
// uma foto tirada no preview.
export async function applyReplace(prisma, { id: batchId, datasets, period, scope, rowsBySheet, fileName, fileHash }) {
  if (scope && !scope.allTime && !(scope.dateFrom && scope.dateTo)) throw new ReplaceScopeError("Escopo do substituir inválido.", "scope_invalid");
  return prisma.$transaction(async (tx) => {
    const { perDataset, addPlan, outside, ignoredOutOfScope } = await planReplace({ prisma: tx, datasets, period, scope, rowsBySheet });

    const preimages = [];
    const counts = { created: 0, deleted: 0, skipped: 0, invalid: 0 };

    for (const key of Object.keys(perDataset)) {
      const adapter = ADAPTERS[key];
      const { deletableIds } = perDataset[key];
      if (deletableIds.length > 0) {
        const rowsBefore = await tx[adapter.model].findMany({ where: { id: { in: deletableIds } } });
        // Trava final (Fase 10.3): nada fora do escopo pode ser apagado — se alguma linha escapar, a transação inteira aborta.
        if (scope) {
          const escaped = rowsBefore.filter((r) => !dateInRange(scope, r.occurredAt));
          if (escaped.length > 0) throw new ReplaceScopeError(`Substituir abortado: ${escaped.length} registro(s) ficariam fora do período.`, "replace_outside_scope");
        }
        for (const row of rowsBefore) preimages.push({ model: adapter.model, id: row.id, before: serializePreimageRow(row), wasDeleted: true });
        await tx[adapter.model].deleteMany({ where: { id: { in: deletableIds } } });
        counts.deleted += deletableIds.length;
      }

      const bucket = addPlan.perDataset[key];
      for (const c of bucket.creates) {
        const created = await tx[adapter.model].create({ data: c.data });
        preimages.push({ model: adapter.model, id: created.id, before: null, afterUpdatedAt: toIso(created.updatedAt) });
        counts.created++;
      }
      counts.skipped += bucket.skips.length;
      counts.invalid += bucket.invalid.length;
    }

    const now = new Date();
    const undoDeadline = new Date(now.getTime() + UNDO_WINDOW_MS);

    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: "APPLIED", appliedAt: now, undoDeadline, preimages, resultCounts: counts },
    });

    await tx.dataOperation.create({
      data: {
        type: "IMPORT_APPLY",
        status: counts.invalid > 0 ? "PARTIAL" : "SUCCESS",
        mode: "replace",
        datasets,
        fileName,
        fileHash,
        createdCount: counts.created,
        updatedCount: 0,
        skippedCount: counts.skipped,
        conflictCount: 0,
        deletedCount: counts.deleted,
        importBatchId: batchId,
      },
    });

    return { counts, preimages, plan: { perDataset, addPlan, outside, ignoredOutOfScope }, undoDeadline };
  }, IMPORT_TRANSACTION_OPTIONS);
}

function toIso(v) {
  return v instanceof Date ? v.toISOString() : v ?? null;
}

function serializePreimageRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v.toNumber === "function") out[k] = v.toNumber();
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}
