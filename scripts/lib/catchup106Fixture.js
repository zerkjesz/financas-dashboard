// Fixture dos testes da Fase 10.6: estado da PROD DEPOIS da 10.5 e ANTES da 10.6 (13/10/2026), montado dentro de uma transação de teste
// que SEMPRE reverte. Só roda com assertTestEnvironment() ativo no teste que importa.
import { paymentKey } from "../../lib/cardBillPaymentKey.js";
export { Rollback } from "./catchup104Fixture.js";

const d = (s) => new Date(s);

export async function wipe(tx) {
  for (const m of ["internalReimbursement", "externalInstallment", "externalInstallmentPlan", "confirmedCommitment", "receivable", "reserveMovement", "reserve", "cardCreditMovement", "installment", "purchase", "cardBillReconciliation", "cardLimitUpdate", "transfer", "cardBill", "expense", "income", "bill", "balanceAdjustment", "recurringRule", "contingency", "goal", "card", "account"]) await tx[m].deleteMany({});
}

export async function seedBefore106(tx) {
  const itau = await tx.account.create({ data: { slug: "itau", name: "Itaú", type: "checking" } });
  const caju = await tx.account.create({ data: { slug: "vale-alimentacao", name: "Vale Alimentação", type: "food_voucher" } });
  const dinheiro = await tx.account.create({ data: { slug: "dinheiro", name: "Dinheiro", type: "cash" } });
  await tx.balanceAdjustment.create({ data: { accountId: itau.id, newBalance: "2490.38", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-10-08T02:59:59Z") } });
  await tx.balanceAdjustment.create({ data: { accountId: caju.id, newBalance: "530.89", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-10-08T02:59:59Z") } });
  await tx.balanceAdjustment.create({ data: { accountId: dinheiro.id, newBalance: "335.00", occurredAt: d("2026-09-20T12:00:00Z") } });
  await tx.recurringRule.create({ data: { name: "Energia", kind: "expense", amount: null, accountId: itau.id, category: "Moradia", amountKind: "VARIABLE" } });
  // gasto original do lanche Lazari (30/09, pago pelo Itaú) — origem do repasse de 29,50
  await tx.expense.create({ data: { amount: "29.50", description: "Pedro / Lazari — lanche", category: "Alimentação", accountId: itau.id, occurredAt: d("2026-09-30T00:00:00Z"), rawMessage: "FASE104-CATCHUP:20260930-pedro-lazari", source: "manual", confidence: "CONFIRMED" } });

  const card = await tx.card.create({ data: { slug: "itau-card", name: "Itaú", accountId: itau.id, totalLimit: "5087", closingDay: 4, dueDay: 11 } });
  const buy = async (description, total, count, value, first, purchasedAt, rows) => {
    const p = await tx.purchase.create({ data: { description, totalAmount: total, installmentCount: count, installmentValue: value, category: "Outros", cardId: card.id, firstInstallmentMonth: first, purchasedAt: d(purchasedAt) } });
    await tx.installment.createMany({ data: rows.map(([number, amount, billMonth]) => ({ purchaseId: p.id, number, amount, billMonth })) });
    return p;
  };
  await buy("Roupas da Bia — Shein", "363.60", 6, "60.60", "2026-09", "2026-08-29T23:20:00Z", [[1, "60.60", "2026-09"], [2, "60.60", "2026-10"], [3, "60.60", "2026-11"], [4, "60.60", "2026-12"], [5, "60.60", "2027-01"], [6, "60.60", "2027-02"]]);
  const portao = await buy("Mercado Livre — Controle do portão", "118.34", 2, "59.17", "2026-10", "2026-09-08T00:00:00Z", [[1, "59.17", "2026-10"], [2, "59.17", "2026-11"]]);
  await buy("Mercado Livre — colchão inflável", "132.99", 4, "33.27", "2026-10", "2026-09-20T00:00:00Z", [[1, "33.27", "2026-10"], [2, "33.24", "2026-11"], [3, "33.24", "2026-12"], [4, "33.24", "2027-01"]]);
  await buy("Roupas — Jim.com F C M", "599.80", 5, "119.96", "2026-07", "2026-07-20T00:00:00Z", [[4, "119.96", "2026-10"], [5, "119.96", "2026-11"]]);
  await buy("Manutenção do PC — DH Mega Vendas", "384.49", 3, "128.16", "2026-09", "2026-09-10T00:00:00Z", [[2, "128.16", "2026-10"], [3, "128.16", "2026-11"]]);
  await buy("Venvanse — Raia Drogasil", "512.00", 3, "170.66", "2026-09", "2026-09-12T00:00:00Z", [[2, "170.66", "2026-10"], [3, "170.66", "2026-11"]]);

  await tx.cardBill.create({ data: { cardId: card.id, cycleMonth: "2026-09", closesAt: d("2026-09-04T00:00:00Z"), dueAt: d("2026-09-11T00:00:00Z"), totalAmount: "1859.01", status: "paid", paidAmount: "1859.01" } });
  const oct = await tx.cardBill.create({ data: { cardId: card.id, cycleMonth: "2026-10", closesAt: d("2026-10-04T00:00:00Z"), dueAt: d("2026-10-13T00:00:00Z"), totalAmount: "1795.77", status: "paid", paidAmount: "1795.77", paidAt: d("2026-10-08T00:00:00Z") } });
  for (const [m, total, closes, due] of [["2026-11", "571.79", "2026-11-04", "2026-11-11"], ["2026-12", "93.84", "2026-12-04", "2026-12-11"], ["2027-01", "93.84", "2027-01-04", "2027-01-11"], ["2027-02", "60.6", "2027-02-04", "2027-02-11"]])
    await tx.cardBill.create({ data: { cardId: card.id, cycleMonth: m, closesAt: d(`${closes}T00:00:00Z`), dueAt: d(`${due}T00:00:00Z`), totalAmount: total, status: "open" } });
  // pagamento da fatura de outubro registrado na 10.5 pelo valor TOTAL (1.795,77), dia 08/10
  const payment = await tx.transfer.create({ data: { amount: "1795.77", description: "Pagamento da fatura Itaú — 2026-10", fromAccountId: itau.id, toCardId: card.id, cardBillId: oct.id, kind: "card_bill_payment", source: "manual", confidence: "CONFIRMED", rawMessage: paymentKey({ billId: oct.id, cycleMonth: "2026-10", amount: "1795.77", accountId: itau.id, day: "2026-10-08" }), occurredAt: d("2026-10-08T00:00:00Z") } });
  await tx.cardBillReconciliation.create({ data: { cardId: card.id, cycleMonth: "2026-10", observedTotal: "1616.54", calculatedTotal: "960.40", delta: "656.14", occurredAt: d("2026-09-25T04:15:10Z") } });
  await tx.cardBillReconciliation.create({ data: { cardId: card.id, cycleMonth: "2026-10", observedTotal: "1795.77", calculatedTotal: "1795.77", delta: "0", occurredAt: d("2026-10-05T02:59:59Z"), createdAt: d("2026-10-08T04:27:52Z") } });
  await tx.cardLimitUpdate.create({ data: { cardId: card.id, newTotalLimit: "4027", newUsedLimit: "2262.95", reportedAvailable: "1764.05", occurredAt: d("2026-08-11T04:52:35Z") } });
  await tx.cardLimitUpdate.create({ data: { cardId: card.id, newUsedLimit: "1378.15", reportedAvailable: "2648.85", occurredAt: d("2026-09-04T23:59:59Z") } });
  await tx.cardLimitUpdate.create({ data: { cardId: card.id, newTotalLimit: "5087", newUsedLimit: "2615.84", reportedAvailable: "2471.16", occurredAt: d("2026-10-05T02:59:59Z") } });

  const cnpj = await tx.confirmedCommitment.create({ data: { description: "Devolver valor restante ao CNPJ (capital)", amount: "1335", dueDate: null, status: "FUNDED", fundingAccountId: itau.id, fundedAt: d("2026-10-08T12:00:00Z"), settlementMode: "EXTERNAL_TRANSFER", shortLabel: "CNPJ" } });
  const goal = await tx.goal.create({ data: { name: "Tattoo ", targetAmount: "2635", savedAmount: "0" } });
  return { itau, caju, dinheiro, card, oct, payment, portao, cnpj, goal };
}
