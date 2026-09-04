import { prisma } from "./prisma.js";
import { money, compareMoney } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — Contingency: risco/possível gasto futuro. NUNCA entra em freeMoney
// (nem nesta fase nem por padrão em nenhuma futura — decisão explícita, item 7).
// Nenhum cálculo de freeMoney existe ainda de qualquer forma.

// ============================================================================
// READ
// ============================================================================

export async function listContingencies({ status } = {}) {
  return prisma.contingency.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

// ============================================================================
// MUTATION
// ============================================================================

export async function createContingency({ description, expectedAmount, maxAmount, expectedDate, notes, confidence } = {}) {
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

  return prisma.contingency.create({
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

export async function updateContingencyStatus(id, status) {
  const ALLOWED = new Set(["AWAITING_INFORMATION", "CONFIRMED", "DISMISSED"]);
  if (!ALLOWED.has(status)) throw new Error(`status inválido: ${status}`);
  return prisma.contingency.update({ where: { id }, data: { status } });
}
