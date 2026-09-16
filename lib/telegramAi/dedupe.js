// ============================================================================
// Fase 7.0 — deduplicação "soft" (item 11 do pedido): compara uma action
// contra lançamentos recentes por valor+data+conta/cartão+descrição, pra
// detectar "isso pode já ter sido lançado" e perguntar, nunca bloquear
// silenciosamente nem duplicar silenciosamente.
//
// Isto é DIFERENTE da idempotência de update_id (lib/telegramIdempotency.js)
// — aquilo impede que o MESMO webhook retry grave duas vezes; isto detecta
// quando o USUÁRIO descreve a MESMA compra em duas mensagens diferentes.
// ============================================================================
import { money } from "../money.js";

const DEDUPE_WINDOW_DAYS = 3;
const DESCRIPTION_OVERLAP_MIN = 0.4; // fração de palavras em comum pra contar como "parecido".

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

function descriptionOverlap(a, b) {
  const wordsA = new Set(normalizeWords(a));
  const wordsB = new Set(normalizeWords(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.min(wordsA.size, wordsB.size);
}

function dateRangeAround(isoDate, days) {
  const center = new Date(`${isoDate}T00:00:00.000Z`);
  return {
    gte: new Date(center.getTime() - days * 86400000),
    lte: new Date(center.getTime() + days * 86400000),
  };
}

// Modelos suportados por dedupe hoje — os únicos que RECORD_* de fato grava
// como ledger real (Expense/Income/Transfer). Compras parceladas dedupe por
// Purchase (não por Installment individual).
const MODEL_BY_ACTION = {
  RECORD_EXPENSE: "expense",
  RECORD_INCOME: "income",
  RECORD_TRANSFER: "transfer",
  RECORD_CARD_PURCHASE: "expense",
  RECORD_INSTALLMENT_PURCHASE: "purchase",
};

function amountFieldFor(model) {
  return model === "purchase" ? "totalAmount" : "amount";
}

function dateFieldFor(model) {
  if (model === "purchase") return "purchasedAt";
  return "occurredAt";
}

// Devolve candidatos possivelmente duplicados (nunca decide sozinho — o
// caller [confirmationPolicy] decide se isso vira pergunta de confirmação).
export async function findDuplicateCandidates(action, { client, resolvedAccountId, resolvedCardId } = {}) {
  const model = MODEL_BY_ACTION[action.type];
  if (!model) return [];

  const amount = action.type === "RECORD_INSTALLMENT_PURCHASE" ? action.totalAmount : action.amount;
  const date = action.date;
  if (!amount || !date) return [];

  const where = {
    [amountFieldFor(model)]: money(amount),
    [dateFieldFor(model)]: dateRangeAround(date, DEDUPE_WINDOW_DAYS),
  };
  if (resolvedAccountId && model !== "purchase") where.accountId = resolvedAccountId;
  if (resolvedCardId) where.cardId = resolvedCardId;

  const candidates = await client[model].findMany({ where, take: 10, orderBy: { [dateFieldFor(model)]: "desc" } });

  const description = action.description || action.merchant || "";
  return candidates
    .map((c) => ({ record: c, model, overlap: descriptionOverlap(description, c.description) }))
    .filter((c) => description === "" || c.overlap >= DESCRIPTION_OVERLAP_MIN || !action.description)
    .slice(0, 3);
}
