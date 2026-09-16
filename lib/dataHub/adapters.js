import { money, serializeMoney } from "../money.js";
import { isValidConfidence } from "../dataConfidence.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — ADAPTERS DE IMPORTAÇÃO.
//
// Item 47 do pedido: "preferência por adapters por domínio/model. Não usar
// for-each-sheet dynamic prisma[table].create(...)". Cada adapter abaixo é
// explícito sobre: como casar uma linha do arquivo com um registro
// existente (match), o que vira CREATE, o que vira UPDATE (só campos que
// realmente mudam), e nunca aceita um valor fora do enum/tipo real do
// schema.
//
// Datasets SEM adapter aqui = export-only (ver lib/dataHub/sheets.js,
// `importable:false`) — nunca oferecidos na UI de import (item 38).
// ============================================================================

// Fase 6.0.1 (Integrity Closure, item 16) — fronteira de dado NÃO CONFIÁVEL
// (arquivo enviado por upload): `money()` (lib/money.js) é deliberadamente
// estrita e lança em valor ilegível — correto pra chamadas internas do app,
// onde quem chama já validou a entrada. Aqui a entrada é uma célula de
// planilha arbitrária; um valor ilegível (texto solto, célula corrompida)
// precisa virar "linha inválida" (o mesmo caminho que `amount == null` já
// usa), nunca uma exceção que derruba o import inteiro por causa de UMA
// linha ruim.
function m(v) {
  if (v == null || v === "") return null;
  try {
    return serializeMoney(money(v));
  } catch {
    return null;
  }
}

function normStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function normDate(v) {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d; // undefined = inválido (distinto de null=ausente)
}

function normBool(v) {
  if (v == null || v === "") return false;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "sim" || s === "yes";
}

// Item 51 — só preserva source/confidence do arquivo se forem valores REAIS
// do schema (round-trip de uma exportação Norte válida); qualquer outra
// coisa (import externo) recebe source="import" fixo + confidence
// conservadora (ESTIMATED) — nunca CONFIRMED sem critério.
const VALID_SOURCES = new Set(["manual", "telegram", "migration"]);
function resolveImportProvenance(row) {
  const fileSource = normStr(row.source);
  const fileConfidence = normStr(row.confidence);
  if (fileSource && VALID_SOURCES.has(fileSource) && fileConfidence && isValidConfidence(fileConfidence)) {
    return { source: fileSource, confidence: fileConfidence };
  }
  return { source: "import", confidence: "ESTIMATED" };
}

// Resolve nome -> id, cacheado por chamada de plano (evita N queries
// repetidas pro mesmo nome dentro do mesmo arquivo).
function makeNameResolver(prisma, modelName, extra = {}) {
  const cache = new Map();
  return async (name) => {
    const key = normStr(name);
    if (!key) return { id: null, error: null };
    if (cache.has(key)) return cache.get(key);
    const row = await prisma[modelName].findFirst({ where: { name: { equals: key, mode: "insensitive" }, ...extra } });
    const result = row ? { id: row.id, error: null } : { id: null, error: `"${key}" não encontrado` };
    cache.set(key, result);
    return result;
  };
}

// Fase 6.1 (Incident P0) — pré-carrega TODOS os IDs de um dataset numa única
// query (`findMany({id:{in:[...]}})`) em vez de um `findUnique` por linha.
// Causa raiz do incidente de produção: `findMatch` fazia 1 round-trip de
// banco POR LINHA, dentro de UMA transação interativa do Prisma com timeout
// padrão de 5s — um arquivo de ~160 linhas (comum num import de
// regularização real) soma ~126+ round-trips sequenciais só de matching,
// e num ambiente cross-region (Vercel US ↔ Neon sa-east-1) isso estoura o
// timeout, derrubando a transação inteira no meio (erro real: "Transaction
// API error: Transaction not found... old closed transaction" — sintoma do
// timeout, não um erro de dado). Preview nunca pegava isso porque preview
// não abre transação nenhuma — só o apply tinha esse limite de tempo.
// Reduz de O(n) pra O(1) round-trip de matching por dataset, preservando
// EXATAMENTE a mesma classificação (id / id_not_found / no_key) — só a
// fonte do dado muda (índice pré-carregado em vez de query ao vivo por
// linha), então o "recompute fresco dentro da transação" (item 53 da Fase
// 6.0.1, concorrência otimista) continua garantido: o índice é buscado nesta
// MESMA chamada de planImport, nunca reaproveitado de uma chamada anterior.
async function buildIdIndex(prisma, model, rows) {
  const ids = [...new Set(rows.map((r) => normStr(r.id || r.ID)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const existing = await prisma[model].findMany({ where: { id: { in: ids } } });
  return new Map(existing.map((e) => [e.id, e]));
}

// ----------------------------------------------------------------------------
function buildLedgerAdapter({ key, model, dateField, requireAccount = false, requireCard = false, allowUpdate = true }) {
  return {
    key,
    model,
    modes: allowUpdate ? ["add", "update"] : ["add"],

    async prepare(prisma) {
      return { resolveAccount: makeNameResolver(prisma, "account"), resolveCard: makeNameResolver(prisma, "card") };
    },

    async prepareMatchIndex(prisma, rows) {
      return { idIndex: await buildIdIndex(prisma, model, rows) };
    },

    async findMatch(prisma, row, ctx) {
      const id = normStr(row.id || row.ID);
      if (id) {
        const existing = ctx.idIndex.get(id);
        return { kind: existing ? "id" : "id_not_found", candidates: existing ? [existing] : [] };
      }
      // Sem ID: registros de ledger (receita/despesa/transferência/ajuste)
      // não têm chave natural confiável (descrição+valor+data pode repetir
      // de propósito — ex: duas compras iguais no mesmo dia) — nunca
      // adivinha; ADICIONAR sempre cria, ATUALIZAR sem ID é sempre "sem
      // correspondência" (skip).
      return { kind: "no_key", candidates: [] };
    },

    async toData(prisma, row, ctx) {
      const amount = m(row.amount);
      if (amount == null) return { invalid: "amount ausente ou inválido" };
      const occurredAt = normDate(row[dateField]);
      if (occurredAt === undefined) return { invalid: `${dateField} inválida` };

      const data = { amount, description: normStr(row.description) || "(sem descrição)", category: normStr(row.category) || "Outros" };
      if (occurredAt) data.occurredAt = occurredAt;

      if (requireAccount) {
        const acc = await ctx.resolveAccount(row.accountName);
        if (!acc.id) return { invalid: `conta ${acc.error}` };
        data.accountId = acc.id;
      }
      if (requireCard && row.cardName) {
        const card = await ctx.resolveCard(row.cardName);
        if (!card.id) return { invalid: `cartão ${card.error}` };
        data.cardId = card.id;
      }
      const { source, confidence } = resolveImportProvenance(row);
      data.source = source;
      data.confidence = confidence;
      data.isRecurring = normBool(row.isRecurring);
      return { data };
    },

    diffFields: ["amount", "description", "category", "occurredAt"],
  };
}

const incomesAdapter = buildLedgerAdapter({ key: "incomes", model: "income", dateField: "occurredAt", requireAccount: true });
const expensesAdapter = buildLedgerAdapter({ key: "expenses", model: "expense", dateField: "occurredAt", requireAccount: false, requireCard: false });
// Expense: conta OU cartão (nunca os dois) — sobrescreve toData pra essa regra específica.
expensesAdapter.toData = async (prisma, row, ctx) => {
  const amount = m(row.amount);
  if (amount == null) return { invalid: "amount ausente ou inválido" };
  const occurredAt = normDate(row.occurredAt);
  if (occurredAt === undefined) return { invalid: "occurredAt inválida" };
  const data = { amount, description: normStr(row.description) || "(sem descrição)", category: normStr(row.category) || "Outros" };
  if (occurredAt) data.occurredAt = occurredAt;
  const accName = normStr(row.accountName);
  const cardName = normStr(row.cardName);
  if (!accName && !cardName) return { invalid: "precisa de conta OU cartão" };
  if (accName) {
    const acc = await ctx.resolveAccount(accName);
    if (!acc.id) return { invalid: `conta ${acc.error}` };
    data.accountId = acc.id;
  }
  if (cardName) {
    const card = await ctx.resolveCard(cardName);
    if (!card.id) return { invalid: `cartão ${card.error}` };
    data.cardId = card.id;
  }
  const { source, confidence } = resolveImportProvenance(row);
  data.source = source;
  data.confidence = confidence;
  data.isRecurring = normBool(row.isRecurring);
  return { data };
};

const transfersAdapter = {
  key: "transfers",
  model: "transfer",
  modes: ["add"],
  async prepare(prisma) {
    return { resolveAccount: makeNameResolver(prisma, "account"), resolveCard: makeNameResolver(prisma, "card") };
  },
  async findMatch() {
    return { kind: "no_key", candidates: [] }; // sempre CREATE em modo adicionar; sem modo atualizar.
  },
  async toData(prisma, row, ctx) {
    const amount = m(row.amount);
    if (amount == null) return { invalid: "amount ausente ou inválido" };
    const occurredAt = normDate(row.occurredAt);
    if (occurredAt === undefined) return { invalid: "occurredAt inválida" };
    const data = { amount, description: normStr(row.description) || "Transferência", kind: "generic" };
    if (occurredAt) data.occurredAt = occurredAt;
    if (row.fromAccountName) {
      const a = await ctx.resolveAccount(row.fromAccountName);
      if (!a.id) return { invalid: `conta origem ${a.error}` };
      data.fromAccountId = a.id;
    }
    if (row.toAccountName) {
      const a = await ctx.resolveAccount(row.toAccountName);
      if (!a.id) return { invalid: `conta destino ${a.error}` };
      data.toAccountId = a.id;
    }
    if (row.toCardName) {
      const c = await ctx.resolveCard(row.toCardName);
      if (!c.id) return { invalid: `cartão destino ${c.error}` };
      data.toCardId = c.id;
    }
    if (!data.fromAccountId && !data.toAccountId && !data.toCardId) return { invalid: "precisa de ao menos uma ponta (origem ou destino)" };
    const { source } = resolveImportProvenance(row);
    data.source = source;
    return { data };
  },
  diffFields: ["amount", "description"],
};

const balanceAdjustmentsAdapter = {
  key: "balanceAdjustments",
  model: "balanceAdjustment",
  modes: ["add"],
  async prepare(prisma) {
    return { resolveAccount: makeNameResolver(prisma, "account") };
  },
  async findMatch() {
    return { kind: "no_key", candidates: [] };
  },
  async toData(prisma, row, ctx) {
    const newBalance = m(row.newBalance);
    if (newBalance == null) return { invalid: "newBalance ausente ou inválido" };
    const acc = await ctx.resolveAccount(row.accountName);
    if (!acc.id) return { invalid: `conta ${acc.error}` };
    const occurredAt = normDate(row.occurredAt);
    if (occurredAt === undefined) return { invalid: "occurredAt inválida" };
    const { source, confidence } = resolveImportProvenance(row);
    const data = { accountId: acc.id, newBalance, note: normStr(row.note), source, confidence };
    if (occurredAt) data.occurredAt = occurredAt;
    return { data };
  },
  diffFields: ["newBalance"],
};

// Datasets de cadastro (Metas/Contas a pagar/Compromissos/Contingências/
// Recebíveis/Orçamento) são inerentemente pequenos pra um app pessoal —
// nunca escala de ledger. Uma única `findMany({})` (sem filtro) troca N
// round-trips de matching por 1 só, e o agrupamento por chave natural vira
// trabalho em memória (JS puro), não N queries — mesma causa raiz do
// incidente P0, mesmo tipo de correção do buildLedgerAdapter acima.
function naturalKeyOf(record, naturalKeyFields) {
  return naturalKeyFields
    .map((f) => {
      const v = record[f.field];
      return v instanceof Date ? v.toISOString() : String(v ?? "");
    })
    .join(" ");
}

function buildNaturalKeyAdapter({ key, model, modes, naturalKeyFields, toData, diffFields }) {
  return {
    key,
    model,
    modes,
    async prepare() {
      return {};
    },
    async prepareMatchIndex(prisma, rows) {
      const idIndex = await buildIdIndex(prisma, model, rows);
      const all = await prisma[model].findMany({});
      const naturalKeyIndex = new Map();
      for (const record of all) {
        const key = naturalKeyOf(record, naturalKeyFields);
        if (!naturalKeyIndex.has(key)) naturalKeyIndex.set(key, []);
        naturalKeyIndex.get(key).push(record);
      }
      return { idIndex, naturalKeyIndex };
    },
    async findMatch(prisma, row, ctx) {
      const id = normStr(row.id || row.ID);
      if (id) {
        const existing = ctx.idIndex.get(id);
        return { kind: existing ? "id" : "id_not_found", candidates: existing ? [existing] : [] };
      }
      const keyParts = [];
      for (const f of naturalKeyFields) {
        const v = row[f.key];
        if (v == null || v === "") return { kind: "no_key", candidates: [] };
        keyParts.push(f.type === "date" ? normDate(v)?.toISOString() ?? "" : String(v));
      }
      const candidates = ctx.naturalKeyIndex.get(keyParts.join(" ")) || [];
      return { kind: candidates.length > 1 ? "ambiguous" : candidates.length === 1 ? "natural_key" : "not_found", candidates };
    },
    toData,
    diffFields,
  };
}

const goalsAdapter = buildNaturalKeyAdapter({
  key: "goals",
  model: "goal",
  modes: ["add", "update"],
  naturalKeyFields: [{ key: "name", field: "name" }],
  async toData(prisma, row) {
    const targetAmount = m(row.targetAmount);
    if (targetAmount == null) return { invalid: "targetAmount ausente ou inválido" };
    const name = normStr(row.name);
    if (!name) return { invalid: "name ausente" };
    const targetDate = normDate(row.targetDate);
    if (targetDate === undefined) return { invalid: "targetDate inválida" };
    const data = { name, targetAmount, notes: normStr(row.notes), isActive: row.isActive == null ? true : normBool(row.isActive) };
    if (row.savedAmount != null) data.savedAmount = m(row.savedAmount) ?? undefined;
    if (targetDate) data.targetDate = targetDate;
    return { data };
  },
  diffFields: ["targetAmount", "savedAmount", "notes"],
});

const billsAdapter = buildNaturalKeyAdapter({
  key: "bills",
  model: "bill",
  modes: ["add", "update"],
  naturalKeyFields: [
    { key: "description", field: "description" },
    { key: "dueDate", field: "dueDate", type: "date" },
  ],
  async toData(prisma, row) {
    const amount = m(row.amount);
    if (amount == null) return { invalid: "amount ausente ou inválido" };
    const description = normStr(row.description);
    if (!description) return { invalid: "description ausente" };
    const dueDate = normDate(row.dueDate);
    if (!dueDate) return { invalid: "dueDate ausente ou inválida" };
    const { source } = resolveImportProvenance(row);
    return { data: { description, amount, dueDate, category: normStr(row.category) || "Outros", status: normStr(row.status) || "pending", source } };
  },
  diffFields: ["amount", "status"],
});

const confirmedCommitmentsAdapter = buildNaturalKeyAdapter({
  key: "confirmedCommitments",
  model: "confirmedCommitment",
  modes: ["add", "update"],
  naturalKeyFields: [
    { key: "description", field: "description" },
    { key: "dueDate", field: "dueDate", type: "date" },
  ],
  async toData(prisma, row) {
    const amount = m(row.amount);
    if (amount == null) return { invalid: "amount ausente ou inválido" };
    const description = normStr(row.description);
    if (!description) return { invalid: "description ausente" };
    const dueDate = normDate(row.dueDate);
    if (!dueDate) return { invalid: "dueDate ausente ou inválida" };
    return { data: { description, amount, dueDate, notes: normStr(row.notes), confidence: isValidConfidence(row.confidence) ? row.confidence : "ESTIMATED" } };
  },
  diffFields: ["amount", "notes"],
});

const contingenciesAdapter = buildNaturalKeyAdapter({
  key: "contingencies",
  model: "contingency",
  modes: ["add", "update"],
  naturalKeyFields: [{ key: "description", field: "description" }],
  async toData(prisma, row) {
    const maxAmount = m(row.maxAmount);
    if (maxAmount == null) return { invalid: "maxAmount ausente ou inválido" };
    const description = normStr(row.description);
    if (!description) return { invalid: "description ausente" };
    const expectedDate = normDate(row.expectedDate);
    if (expectedDate === undefined) return { invalid: "expectedDate inválida" };
    const data = { description, maxAmount, expectedAmount: m(row.expectedAmount), notes: normStr(row.notes), confidence: isValidConfidence(row.confidence) ? row.confidence : "ESTIMATED" };
    if (expectedDate) data.expectedDate = expectedDate;
    return { data };
  },
  diffFields: ["maxAmount", "expectedAmount", "notes"],
});

const receivablesAdapter = buildNaturalKeyAdapter({
  key: "receivables",
  model: "receivable",
  modes: ["add", "update"],
  naturalKeyFields: [
    { key: "description", field: "description" },
    { key: "counterparty", field: "counterparty" },
  ],
  async toData(prisma, row) {
    const amount = m(row.amount);
    if (amount == null) return { invalid: "amount ausente ou inválido" };
    const description = normStr(row.description);
    const counterparty = normStr(row.counterparty);
    if (!description || !counterparty) return { invalid: "description e counterparty são obrigatórios" };
    const expectedDate = normDate(row.expectedDate);
    if (expectedDate === undefined) return { invalid: "expectedDate inválida" };
    const data = { description, counterparty, amount, notes: normStr(row.notes) };
    if (expectedDate) data.expectedDate = expectedDate;
    return { data };
  },
  diffFields: ["amount", "notes"],
});

const categoryBudgetsAdapter = buildNaturalKeyAdapter({
  key: "categoryBudgets",
  model: "categoryBudget",
  modes: ["add", "update"],
  naturalKeyFields: [
    { key: "category", field: "category" },
    { key: "cycleStart", field: "cycleStart", type: "date" },
  ],
  async toData(prisma, row) {
    const amount = m(row.amount);
    if (amount == null) return { invalid: "amount ausente ou inválido" };
    const category = normStr(row.category);
    if (!category) return { invalid: "category ausente" };
    const cycleStart = normDate(row.cycleStart);
    if (!cycleStart) return { invalid: "cycleStart ausente ou inválida" };
    return { data: { category, cycleStart, amount } };
  },
  diffFields: ["amount"],
});

const ADAPTERS = {
  incomes: incomesAdapter,
  expenses: expensesAdapter,
  transfers: transfersAdapter,
  balanceAdjustments: balanceAdjustmentsAdapter,
  goals: goalsAdapter,
  bills: billsAdapter,
  confirmedCommitments: confirmedCommitmentsAdapter,
  contingencies: contingenciesAdapter,
  receivables: receivablesAdapter,
  categoryBudgets: categoryBudgetsAdapter,
};

export default ADAPTERS;
export { normStr, normDate, normBool, m as normMoney };
