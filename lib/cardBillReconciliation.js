// ============================================================================
// Fase 7.0 — reconciliação de fatura de cartão observada vs calculada.
//
// Auditado antes de implementar (não é gambiarra): NENHUM mecanismo de
// reconciliação de fatura existia (RECONCILIATION_ADJUSTMENT era só um
// valor solto do enum DataConfidence, usado em scripts de migração one-shot
// nunca integrados a um serviço real). CardBillReconciliation (novo model,
// migration DEV 20260916071322) é histórico append-only, mesmo padrão do
// BalanceAdjustment pro saldo de conta: nunca sobrescreve, nunca cria
// Expense/Income pra "fechar a conta" — só registra explicitamente que o
// usuário observou X quando o sistema calculava Y, com o delta ao lado.
// ============================================================================
import { prisma } from "./prisma.js";
import { computeExpectedCardBillTotal } from "./cardBillCalculator.js";
import { getCardCycleForDate } from "./cardCycle.js";
import { money, subtractMoney, serializeMoney } from "./money.js";
import { formatMoney } from "./formatMoney.js";

// Read-only — monta o que a confirmação precisa mostrar ("Pelos detalhes
// conhecidos eu calculo R$X. Diferença: R$Y. Quer reconciliar?").
export async function previewCardBillReconciliation(cardId, observedTotal, { date = new Date(), client = prisma } = {}) {
  const card = await client.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado.`);
  const cycleMonth = getCardCycleForDate(card, date);
  const calculated = await computeExpectedCardBillTotal(card, cycleMonth, { client });
  const observed = money(observedTotal);
  const delta = subtractMoney(observed, calculated);
  const existingBill = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  return {
    card,
    cycleMonth,
    cardBillId: existingBill?.id ?? null,
    calculated: serializeMoney(calculated),
    observed: serializeMoney(observed),
    delta: serializeMoney(delta),
    isDifferent: !delta.isZero(),
  };
}

// Grava a reconciliação — só depois de confirmado. NUNCA altera
// CardBill.totalAmount (que continua sendo sempre o valor CALCULADO, fonte
// de verdade derivada de Expense/Installment reais) — a reconciliação é uma
// anotação paralela, auditável, nunca uma reescrita silenciosa do total.
export async function applyCardBillReconciliation(cardId, observedTotal, { date = new Date(), note, rawMessage, client = prisma } = {}) {
  const preview = await previewCardBillReconciliation(cardId, observedTotal, { date, client });
  const record = await client.cardBillReconciliation.create({
    data: {
      cardBillId: preview.cardBillId,
      cardId,
      cycleMonth: preview.cycleMonth,
      observedTotal: money(observedTotal),
      calculatedTotal: money(preview.calculated),
      delta: money(preview.delta),
      note: note ?? `Reconciliação: calculado ${formatMoney(preview.calculated)}, informado ${formatMoney(preview.observed)} (diferença ${formatMoney(preview.delta)}).`,
      source: "telegram",
      confidence: "RECONCILIATION_ADJUSTMENT",
      rawMessage,
    },
  });
  return { record, preview };
}
