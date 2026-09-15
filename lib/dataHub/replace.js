import { periodRange } from "./sheets.js";
import ADAPTERS from "./adapters.js";
import { planImport } from "./plan.js";

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

// Retorna, por dataset: os IDs existentes no escopo (período), quais são
// protegidos (nunca removidos) e quais seriam removidos — MAIS o plano de
// CREATE de tudo que vier do arquivo pra aquele dataset (reaproveita
// planImport em modo "add" — substituir = deletar o escopo antigo + tratar
// o arquivo inteiro como "adicionar" dentro do escopo novo, nunca uma
// terceira lógica de matching).
export async function planReplace({ prisma, datasets, period, rowsBySheet }) {
  const scoped = datasets.filter((d) => REPLACEABLE_DATASETS.includes(d));
  const range = periodRange(period);
  const perDataset = {};

  for (const key of scoped) {
    const adapter = ADAPTERS[key];
    const dateField = key === "incomes" || key === "expenses" ? "occurredAt" : "occurredAt";
    const existing = await prisma[adapter.model].findMany({ where: range ? { [dateField]: range } : undefined, select: { id: true } });
    const allIds = existing.map((r) => r.id);
    const protectedIds = await findProtectedIds(prisma, key, allIds);
    const deletableIds = allIds.filter((id) => !protectedIds.has(id));
    perDataset[key] = { existingCount: allIds.length, protectedIds: [...protectedIds], deletableIds };
  }

  // O que entra: TODO o conteúdo do arquivo pro dataset, sem checar
  // duplicata contra o que está saindo (o escopo antigo já está marcado
  // pra sair) — mas ainda valida campo a campo (adapter.toData) e ainda
  // detecta duplicata contra o que fica de FORA do escopo (ex: um registro
  // fora do período, que "substituir" nunca toca).
  const addPlan = await planImport({ prisma, mode: "add", datasets: scoped, rowsBySheet });

  return { perDataset, addPlan };
}

export async function applyReplace(prisma, { datasets, period, rowsBySheet }) {
  const { perDataset, addPlan } = await planReplace({ prisma, datasets, period, rowsBySheet });

  return prisma.$transaction(async (tx) => {
    const preimages = [];
    const counts = { created: 0, deleted: 0, skipped: 0, invalid: 0 };

    for (const key of Object.keys(perDataset)) {
      const adapter = ADAPTERS[key];
      const { deletableIds } = perDataset[key];
      if (deletableIds.length > 0) {
        const rowsBefore = await tx[adapter.model].findMany({ where: { id: { in: deletableIds } } });
        for (const row of rowsBefore) preimages.push({ model: adapter.model, id: row.id, before: serializePreimageRow(row), wasDeleted: true });
        await tx[adapter.model].deleteMany({ where: { id: { in: deletableIds } } });
        counts.deleted += deletableIds.length;
      }

      const bucket = addPlan.perDataset[key];
      for (const c of bucket.creates) {
        const created = await tx[adapter.model].create({ data: c.data });
        preimages.push({ model: adapter.model, id: created.id, before: null });
        counts.created++;
      }
      counts.skipped += bucket.skips.length;
      counts.invalid += bucket.invalid.length;
    }

    return { counts, preimages, plan: { perDataset, addPlan } };
  });
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
