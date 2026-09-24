import { prisma } from "./prisma.js";
import { money, compareMoney } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — Contingency: risco/possível gasto futuro. NUNCA entra em freeMoney
// (nem nesta fase nem por padrão em nenhuma futura — decisão explícita, item 7).
// Nenhum cálculo de freeMoney existe ainda de qualquer forma.

// ============================================================================
// READ
// ============================================================================

export async function listContingencies({ status, client = prisma } = {}) {
  return client.contingency.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

// ============================================================================
// MUTATION
// ============================================================================

// Fase 7.0 — `client` opcional (default: `prisma`), mesmo padrão aditivo de
// lib/commitments.js/cardBillCalculator.js — participa da transação do
// pipeline conversacional do Telegram quando uma é passada.
export async function createContingency({ description, expectedAmount, maxAmount, expectedDate, notes, confidence } = {}, { client = prisma } = {}) {
  if (!description) throw new Error("description é obrigatória");
  const maxMoneyValue = money(maxAmount);
  if (!maxMoneyValue.gt(0)) throw new Error("maxAmount precisa ser positivo");

  let expectedMoneyValue = null;
  if (expectedAmount != null) {
    expectedMoneyValue = money(expectedAmount);
    if (expectedMoneyValue.lt(0)) throw new Error("expectedAmount não pode ser negativo");
    if (compareMoney(expectedMoneyValue, maxMoneyValue) > 0) {
      throw new Error("expectedAmount não pode ser maior que maxAmount");
    }
  }

  return client.contingency.create({
    data: {
      description,
      expectedAmount: expectedMoneyValue,
      maxAmount: maxMoneyValue,
      expectedDate: expectedDate ? new Date(expectedDate) : null,
      notes: notes || null,
      confidence: resolveConfidence(confidence),
    },
  });
}

export async function updateContingencyStatus(id, status, { client = prisma } = {}) {
  const ALLOWED = new Set(["AWAITING_INFORMATION", "CONFIRMED", "DISMISSED"]);
  if (!ALLOWED.has(status)) throw new Error(`status inválido: ${status}`);
  return client.contingency.update({ where: { id }, data: { status } });
}

// Atualiza maxAmount de uma Contingency existente — necessário pro
// UPDATE_CONTINGENCY do plano conversacional.
export async function updateContingencyAmount(id, maxAmount, { client = prisma } = {}) {
  const maxMoneyValue = money(maxAmount);
  if (!maxMoneyValue.gt(0)) throw new Error("maxAmount precisa ser positivo");
  // Fase 7D.1 — a tabela tem CHECK (expectedAmount <= maxAmount); validar aqui
  // dá uma mensagem clara em vez de estourar a constraint do banco.
  const current = await client.contingency.findUnique({ where: { id } });
  if (!current) throw new Error("Contingência não encontrada");
  if (current.expectedAmount != null && compareMoney(maxMoneyValue, current.expectedAmount) < 0) {
    throw new Error(`o máximo não pode ser menor que o esperado (R$ ${current.expectedAmount.toString()})`);
  }
  return client.contingency.update({ where: { id }, data: { maxAmount: maxMoneyValue } });
}
