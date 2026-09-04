import { prisma } from "./prisma.js";
import { money, sumMoney, isPositive } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — CardCreditMovement: saldo credor do CARTÃO (não da fatura — CardBill
// continua sem esse conceito). Mesmo padrão de ledger com sinal-por-kind de
// lib/reserves.js — amount é SEMPRE positivo (CHECK no banco), a direção vem do
// kind, nunca de um sinal escondido no valor.
//
// IMPORTANTE: este ledger nunca apaga/reduz Purchase/Expense original. Exemplo:
//   crédito concedido = R$209,11 (CREDIT_GRANTED)
//   compra de alimentação = R$35 (Expense normal, criado do jeito de sempre)
//   aplica R$35 do crédito (CREDIT_APPLIED)
//   -> a Expense de R$35 continua exatamente R$35 (não foi tocada);
//   -> o saldo credor cai pra R$174,11.
// "Aplicar crédito" é só um efeito no LEDGER DE CRÉDITO, nunca uma edição
// retroativa de um gasto já lançado.
//
// v1: não integrado automaticamente com payBill/lib/cardBillCalculator.js (Fase
// 3.3, item 10) — isso fica pra fase do motor financeiro/cartão. Aqui o ledger
// existe e é testável isoladamente.
const POSITIVE_KINDS = new Set(["CREDIT_GRANTED", "ADJUST_INCREASE"]);
const NEGATIVE_KINDS = new Set(["CREDIT_APPLIED", "ADJUST_DECREASE"]);

function assertValidKind(kind) {
  if (!POSITIVE_KINDS.has(kind) && !NEGATIVE_KINDS.has(kind)) {
    throw new Error(`CardCreditMovementKind inválido: ${JSON.stringify(kind)}`);
  }
}

function signedAmount(movement) {
  const abs = money(movement.amount);
  return POSITIVE_KINDS.has(movement.kind) ? abs : abs.negated();
}

// ============================================================================
// READ
// ============================================================================

export async function getCardCreditBalance(cardId) {
  const movements = await prisma.cardCreditMovement.findMany({ where: { cardId } });
  return sumMoney(movements.map(signedAmount));
}

export async function listCardCreditMovements(cardId) {
  return prisma.cardCreditMovement.findMany({ where: { cardId }, orderBy: { occurredAt: "asc" } });
}

// ============================================================================
// MUTATION
// ============================================================================

export async function createCardCreditMovement(cardId, { amount, kind, note, confidence, occurredAt, cardBillId, transferId } = {}) {
  assertValidKind(kind);
  const amountMoney = money(amount);
  if (!isPositive(amountMoney)) {
    throw new Error("amount do CardCreditMovement precisa ser positivo — o sinal vem do kind, nunca do amount");
  }
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error("Card não encontrado");

  return prisma.cardCreditMovement.create({
    data: {
      cardId,
      amount: amountMoney,
      kind,
      note: note || null,
      confidence: resolveConfidence(confidence),
      occurredAt: occurredAt || undefined,
      cardBillId: cardBillId || null,
      transferId: transferId || null,
    },
  });
}
