import { money, subtractMoney, isPositive } from "./money.js";

// Fase 4.0, item 6 — classificador central e PURO: responde "esta obrigação
// reduz freeMoney AGORA?". NÃO calcula freeMoney (isso é uma fase futura — ver
// Fase 4.0, item 14/"NÃO IMPLEMENTAR AINDA") — só classifica. Nenhuma função
// aqui lê o banco: cada classify* recebe o registro (e, quando necessário, o
// contexto temporal — nextIncomeDate/now/card) já carregado por quem chama.
//
// Decisão deliberada do Norte (item 14, formalizada aqui): uma compra parcelada
// pode ter criado uma obrigação econômica TOTAL, mas o produto não reserva todas
// as parcelas futuras hoje. Só a fatura atual/relevante já formada é
// INCURRED_LIABILITY; parcelas de faturas futuras são FUTURE_OBLIGATION. Exemplo
// do pedido: MacBook com parcela daqui a 6 meses não reduz freeMoney atual.
export const OBLIGATION_CLASS = Object.freeze({
  INCURRED_LIABILITY: "INCURRED_LIABILITY", // já formada/fechada, saldo > 0 — dívida de AGORA.
  CURRENT_HORIZON_OBLIGATION: "CURRENT_HORIZON_OBLIGATION", // vence até a próxima renda.
  FUTURE_OBLIGATION: "FUTURE_OBLIGATION", // vence depois da próxima renda, ainda não incorrida.
  CONTINGENCY: "CONTINGENCY", // risco, nunca reduz freeMoney por padrão.
  SETTLED: "SETTLED", // já resolvida (paga/quitada) — não é mais obrigação.
  CANCELLED: "CANCELLED", // descartada — não é mais obrigação.
});

// Receivable não é uma obrigação (é um INFLOW futuro) — vocabulário separado de
// propósito, pra nunca ser confundido/somado com OBLIGATION_CLASS (item 12).
export const INFLOW_CLASS = Object.freeze({
  PENDING_RECEIVABLE: "PENDING_RECEIVABLE", // nunca conta como caixa/freeMoney.
  RECEIVED: "RECEIVED", // o Income real é quem move dinheiro; isto é só rótulo informativo.
  CANCELLED: "CANCELLED",
});

// ============================================================================
// CardBill (item 7 / Fase 4.1.2 — Card Liability Gate)
// ============================================================================
//
// INCURRED_LIABILITY quando: saldo restante (totalAmount - paidAmount) > 0 E
// esta é a fatura "atualmente relevante" do cartão (`isCurrentRelevant`,
// resolvido por lib/freeMoney.js:resolveCurrentRelevantCardBillCycleMonth — a PRIMEIRA
// fatura não liquidada na ordem cronológica de fechamento, entre todas as
// faturas desse cartão). Qualquer outra fatura com saldo > 0 (mesmo já fechada
// e vencida, se houver uma anterior ainda não liquidada; ou futura, sempre) é
// FUTURE_OBLIGATION.
//
// Fase 4.1.2 — substituiu a checagem antiga "o ciclo já começou? (period.start
// <= now)": ela quebrava exatamente na borda do closingDay, sem granularidade
// de hora — uma fatura anterior QUITADA + a próxima já com saldo > 0 podia
// fazer a liability correta "desaparecer" por um dia só porque o calendário
// ainda não tinha virado o dia seguinte ao fechamento. A sequência (primeira
// não liquidada) não depende de relógio nenhum: se tudo antes dela está
// resolvido, ela é a liability de agora, ponto — mesmo que seu ciclo
// "oficialmente" feche daqui a um dia.
//
// classifyCardBill continua PURA — não decide sozinha qual fatura é a
// relevante (isso exige olhar TODAS as faturas do cartão, não só uma), só
// aplica a decisão que o engine já resolveu (`isCurrentRelevant`), evitando
// espalhar a regra entre UI/classifier/queries (item 8).
//
// Saldo restante ainda NÃO desconta crédito aplicado (CardCreditMovement) — essa
// integração é decisão explícita de fase futura (Fase 3.3, item 10); comentado
// aqui pra não ser esquecido quando essa integração existir.
export function classifyCardBill(bill, { isCurrentRelevant = false } = {}) {
  const remaining = subtractMoney(money(bill.totalAmount), money(bill.paidAmount ?? 0));
  if (!isPositive(remaining)) return OBLIGATION_CLASS.SETTLED;
  return isCurrentRelevant ? OBLIGATION_CLASS.INCURRED_LIABILITY : OBLIGATION_CLASS.FUTURE_OBLIGATION;
}

// ============================================================================
// Bill (item 8)
// ============================================================================
export function classifyBill(bill, { nextIncomeDate }) {
  if (bill.status === "paid") return OBLIGATION_CLASS.SETTLED;
  if (bill.status === "cancelled") return OBLIGATION_CLASS.CANCELLED;
  if (bill.status === "overdue") return OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION; // sempre atual, independente de dueDate.
  // "pending"
  return bill.dueDate <= nextIncomeDate ? OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION : OBLIGATION_CLASS.FUTURE_OBLIGATION;
}

// ============================================================================
// ExternalInstallment (item 9)
// ============================================================================
export function classifyExternalInstallment(installment, { nextIncomeDate }) {
  if (installment.status === "PAID") return OBLIGATION_CLASS.SETTLED;
  return installment.dueDate <= nextIncomeDate ? OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION : OBLIGATION_CLASS.FUTURE_OBLIGATION;
}

// ============================================================================
// ConfirmedCommitment (item 10)
// ============================================================================
//
// FUNDED não é pago — mas earmark/intenção já existe, então conta como horizonte
// atual mesmo se dueDate estiver longe (regra B, explícita no pedido).
export function classifyConfirmedCommitment(commitment, { nextIncomeDate }) {
  if (commitment.status === "SETTLED") return OBLIGATION_CLASS.SETTLED;
  if (commitment.status === "CANCELLED") return OBLIGATION_CLASS.CANCELLED;

  // CONFIRMED ou FUNDED daqui pra baixo.
  if (commitment.dueDate <= nextIncomeDate) return OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION; // regra A
  if (commitment.status === "FUNDED") return OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION; // regra B
  return OBLIGATION_CLASS.FUTURE_OBLIGATION; // regra C: CONFIRMED + unfunded + dueDate > nextIncomeDate
}

// ============================================================================
// Contingency (item 11)
// ============================================================================
//
// Nunca reduz freeMoney por padrão — nem nesta fase, nem nas futuras (decisão
// explícita). expectedAmount/maxAmount só entram em cenários na Fase 4.1.
export function classifyContingency(contingency) {
  if (contingency.status === "DISMISSED") return OBLIGATION_CLASS.CANCELLED;
  return OBLIGATION_CLASS.CONTINGENCY; // AWAITING_INFORMATION ou CONFIRMED (da Contingency) — sempre separado.
}

// ============================================================================
// Receivable (item 12) — vocabulário INFLOW_CLASS, não OBLIGATION_CLASS.
// ============================================================================
//
// PENDING nunca aumenta freeMoney/unrestrictedCash, nunca vira "recebido" só
// porque expectedDate passou — só o Income real (via markReceivableReceived)
// move dinheiro de verdade.
export function classifyReceivable(receivable) {
  if (receivable.status === "RECEIVED") return INFLOW_CLASS.RECEIVED;
  if (receivable.status === "CANCELLED") return INFLOW_CLASS.CANCELLED;
  return INFLOW_CLASS.PENDING_RECEIVABLE;
}
