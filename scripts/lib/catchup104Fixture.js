// Fixture compartilhado dos testes da Fase 10.4 (planner e executor): fatias reais de PROD de 07/10/2026, montadas dentro de uma transação
// de teste que SEMPRE reverte. Só roda com assertTestEnvironment() ativo no teste que importa.
import { ITAU_ITEMS, CAJU_ITEMS, CARD_PURCHASES } from "./catchup104Planner.js";

const d = (s) => new Date(s);
export class Rollback extends Error {}

export async function wipe(tx) {
  for (const m of ["externalInstallment", "externalInstallmentPlan", "confirmedCommitment", "receivable", "reserveMovement", "reserve", "cardCreditMovement", "installment", "purchase", "cardBillReconciliation", "cardLimitUpdate", "transfer", "cardBill", "expense", "income", "bill", "balanceAdjustment", "recurringRule", "contingency", "card", "account"]) await tx[m].deleteMany({});
}
export async function seedBefore(tx) {
  const itau = await tx.account.create({ data: { slug: "itau", name: "Itaú", type: "checking" } });
  const caju = await tx.account.create({ data: { slug: "vale-alimentacao", name: "Vale Alimentação", type: "food_voucher" } });
  await tx.balanceAdjustment.create({ data: { accountId: itau.id, newBalance: "6875.46", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-09-25T04:58:00Z") } });
  await tx.balanceAdjustment.create({ data: { accountId: caju.id, newBalance: "596.35", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-09-26T19:40:00Z") } });
  const rule = (name, amount, extra = {}) => tx.recurringRule.create({ data: { name, kind: "expense", amount, accountId: itau.id, category: "Moradia", ...extra } });
  const rAgua = await rule("Água", "59.27", { amountKind: "APPROXIMATE" });
  const rTel = await rule("Telefone", "60", { amountKind: "APPROXIMATE" });
  await rule("Energia", null, { amountKind: "VARIABLE" });
  // Água REAL de 23/09 (competência 2026-09, anterior à âncora) — NÃO pode ser tocada
  const aguaReal = await tx.bill.create({ data: { description: "Água", amount: "59.31", accountId: itau.id, recurringRuleId: rAgua.id, cycleMonth: "2026-09", part: 1, status: "paid", paidAt: d("2026-09-23T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
  const aguaRealExp = await tx.expense.create({ data: { amount: "59.31", description: "Gabriel — conta de água", category: "Moradia", accountId: itau.id, billId: aguaReal.id, occurredAt: d("2026-09-23T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
  // Água FALSA de 26/09 (sem contrapartida bancária) e Telefone 60 (banco: 57,48)
  const aguaFalsa = await tx.bill.create({ data: { description: "Água", amount: "59.27", accountId: itau.id, recurringRuleId: rAgua.id, cycleMonth: "2026-10", part: 1, status: "paid", paidAt: d("2026-09-26T04:32:00Z"), source: "manual", confidence: "CONFIRMED" } });
  const aguaFalsaExp = await tx.expense.create({ data: { amount: "59.27", description: "Água", category: "Moradia", accountId: itau.id, billId: aguaFalsa.id, occurredAt: d("2026-09-26T04:32:00Z"), source: "manual", confidence: "CONFIRMED" } });
  const tel = await tx.bill.create({ data: { description: "Telefone", amount: "60", accountId: itau.id, recurringRuleId: rTel.id, cycleMonth: "2026-10", part: 1, status: "paid", paidAt: d("2026-09-26T04:35:00Z"), source: "manual", confidence: "CONFIRMED" } });
  const telExp = await tx.expense.create({ data: { amount: "60", description: "Telefone", category: "Outros", accountId: itau.id, billId: tel.id, occurredAt: d("2026-09-26T04:35:00Z"), source: "manual", confidence: "CONFIRMED" } });
  // restante do que já está no Norte depois da âncora (batem com o extrato de 28/09)
  for (const [amount, desc, at] of [["1050.59", "Parcelas (Maria S)", "2026-09-26T04:24:00Z"], ["308", "Casa de Ubatuba — parcela 4/6", "2026-09-26T04:27:00Z"], ["113.5", "Regularização da Tiger — parcela 2/3", "2026-09-26T04:28:00Z"], ["1000", "Aluguel", "2026-09-26T04:29:00Z"], ["114.9", "Internet", "2026-09-26T04:33:00Z"], ["130", "Faxina 1/2", "2026-09-26T04:36:00Z"], ["130", "Faxina 2/2", "2026-09-26T04:37:00Z"], ["50", "gasolina carro", "2026-09-27T00:00:00Z"], ["44.05", "vacina bia", "2026-09-27T00:00:00Z"], ["40.5", "cheat pb", "2026-09-28T00:00:00Z"]])
    await tx.expense.create({ data: { amount, description: desc, category: "Outros", accountId: itau.id, occurredAt: d(at), source: "manual", confidence: "CONFIRMED" } });

  const card = await tx.card.create({ data: { slug: "itau-card", name: "Itaú", accountId: itau.id, totalLimit: "4027", closingDay: 4, dueDay: 11 } });
  const cardExp = async (amount, description, date, extra = {}) => tx.expense.create({ data: { amount, description, category: "Outros", cardId: card.id, occurredAt: d(`${date}T00:00:00Z`), source: "manual", confidence: "CONFIRMED", ...extra } });
  await cardExp("385", "Sushi — aniversário da Bia", "2026-09-05");
  await cardExp("120.38", "Claude IA", "2026-09-08");
  await cardExp("65.9", "TIM RP", "2026-09-10");
  await cardExp("20", "Apple", "2026-09-10");
  await cardExp("70", "Gympass", "2026-09-11");
  await cardExp("15", "Chope — gasto que idealmente teria saído do VA", "2026-09-12");
  await cardExp("31", "Chope — gasto que idealmente teria saído do VA", "2026-09-12");
  await cardExp("70", "Gympass da Bia", "2026-09-14");
  await cardExp("25.35", "Gomes supermercado — gasto que idealmente teria saído do VA", "2026-09-15");
  await cardExp("38", "Compra não identificada (cartão Itaú)", "2026-09-17");
  // compras já estruturadas (as 2 que NÃO podem duplicar)
  const shein = await tx.purchase.create({ data: { description: "passei 363,60 reais no cartão de crédito, parcelado em 6x, aniversario da bia", totalAmount: "363.60", installmentCount: 6, installmentValue: "60.60", category: "Outros", cardId: card.id, firstInstallmentMonth: "2026-09", purchasedAt: d("2026-08-29T23:20:00Z") } });
  await tx.installment.createMany({ data: [1, 2, 3, 4, 5, 6].map((n) => ({ purchaseId: shein.id, number: n, amount: "60.60", billMonth: ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"][n - 1] })) });
  const portao = await tx.purchase.create({ data: { description: "Mercado Livre — Controle do portão", totalAmount: "118.34", installmentCount: 2, installmentValue: "59.17", category: "Outros", cardId: card.id, firstInstallmentMonth: "2026-10", purchasedAt: d("2026-09-08T00:00:00Z") } });
  await tx.installment.createMany({ data: [{ purchaseId: portao.id, number: 1, amount: "59.17", billMonth: "2026-10" }, { purchaseId: portao.id, number: 2, amount: "59.17", billMonth: "2026-11" }] });
  await tx.cardBill.create({ data: { cardId: card.id, cycleMonth: "2026-09", closesAt: d("2026-09-04T00:00:00Z"), dueAt: d("2026-09-11T00:00:00Z"), totalAmount: "1859.01", status: "paid", paidAmount: "1859.01" } });
  for (const [m, total, closes, due] of [["2026-10", "716.97", "2026-10-04", "2026-10-11"], ["2026-11", "479.38", "2026-11-04", "2026-11-11"], ["2026-12", "60.6", "2026-12-04", "2026-12-11"], ["2027-01", "60.6", "2027-01-04", "2027-01-11"], ["2027-02", "60.6", "2027-02-04", "2027-02-11"]])
    await tx.cardBill.create({ data: { cardId: card.id, cycleMonth: m, closesAt: d(`${closes}T00:00:00Z`), dueAt: d(`${due}T00:00:00Z`), totalAmount: total, status: "open" } });
  await tx.cardBillReconciliation.create({ data: { cardId: card.id, cycleMonth: "2026-10", observedTotal: "1616.54", calculatedTotal: "960.40", delta: "656.14", occurredAt: d("2026-09-25T04:15:00Z") } });
  await tx.cardLimitUpdate.create({ data: { cardId: card.id, newUsedLimit: "1378.15", reportedAvailable: "2648.85", occurredAt: d("2026-09-04T23:59:00Z") } });
  const cont = await tx.contingency.create({ data: { description: "Tiger", expectedAmount: "1000", maxAmount: "2000", status: "AWAITING_INFORMATION" } });
  return { itau, caju, card, aguaReal, aguaRealExp, aguaFalsa, aguaFalsaExp, tel, telExp, shein, cont };
}

// estado JÁ RECONCILIADO (escrito à mão pelo teste, independente do planner): o que o PASSO B deixaria no banco
export async function seedReconciled(tx, w) {
  await tx.expense.delete({ where: { id: w.aguaFalsaExp.id } });
  await tx.bill.delete({ where: { id: w.aguaFalsa.id } });
  await tx.expense.update({ where: { id: w.telExp.id }, data: { amount: "57.48" } });
  await tx.bill.update({ where: { id: w.tel.id }, data: { amount: "57.48" } });
  for (const [acc, items] of [[w.itau, ITAU_ITEMS], [w.caju, CAJU_ITEMS]])
    for (const it of items) await tx[it.kind === "income" ? "income" : "expense"].create({ data: { amount: it.amount, description: it.description, category: it.category, accountId: acc.id, occurredAt: d(`${it.date}T00:00:00Z`), rawMessage: `FASE104-CATCHUP:${it.key}`, source: "manual", confidence: "CONFIRMED" } });
  await tx.balanceAdjustment.create({ data: { accountId: w.itau.id, newBalance: "2490.38", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-10-08T02:59:59Z") } });
  await tx.balanceAdjustment.create({ data: { accountId: w.caju.id, newBalance: "530.89", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: d("2026-10-08T02:59:59Z") } });
  await tx.confirmedCommitment.create({ data: { description: "Acordo Tiger — Leandro (saldo restante)", amount: "5000", dueDate: null, status: "CONFIRMED", shortLabel: "Tiger" } });
  await tx.contingency.update({ where: { id: w.cont.id }, data: { status: "DISMISSED" } });
  const upd = async (match, data) => {
    const e = await tx.expense.findFirst({ where: { cardId: w.card.id, description: { contains: match } } });
    await tx.expense.update({ where: { id: e.id }, data });
  };
  await upd("Sushi", { amount: "384.89", occurredAt: d("2026-09-06T00:00:00Z") });
  await upd("Claude", { amount: "116.31", description: "Claude — assinatura (internacional)", isRecurring: true });
  await upd("TIM RP", { description: "Tiny ERP" });
  await upd("Apple", { amount: "19.90", description: "Apple — assinatura", isRecurring: true });
  const gy = await tx.expense.findMany({ where: { cardId: w.card.id, description: { contains: "Gympass" } }, orderBy: { occurredAt: "asc" } });
  await tx.expense.update({ where: { id: gy[0].id }, data: { amount: "69.99", description: "Wellhub — Ricardo", isRecurring: true } });
  await tx.expense.update({ where: { id: gy[1].id }, data: { amount: "69.99", description: "Wellhub — Bia", isRecurring: true } });
  await upd("não identificada", { description: "Gustavo Alberto — serviços" });
  for (const [amount, desc, date, rec, cat] of [["110.20", "ChatGPT — assinatura (internacional)", "2026-09-25", true, "Outros"], ["31.90", "Spotify — assinatura", "2026-09-27", true, "Lazer"], ["7.93", "IOF internacional — encargo agregado da fatura de 04/10/2026 (Claude + ChatGPT)", "2026-10-04", false, "Outros"]])
    await tx.expense.create({ data: { amount, description: desc, category: cat, cardId: w.card.id, isRecurring: rec, occurredAt: d(`${date}T00:00:00Z`), source: "manual", confidence: "CONFIRMED" } });
  for (const p of CARD_PURCHASES) {
    const created = await tx.purchase.create({ data: { description: p.description, totalAmount: p.total, installmentCount: p.count, installmentValue: p.value, category: p.category, cardId: w.card.id, firstInstallmentMonth: p.first, startingInstallmentNumber: p.rows[0].n, purchasedAt: d(`${p.purchasedAt}T00:00:00Z`), confidence: p.rows.some((r) => r.derived) ? "ESTIMATED" : "CONFIRMED", rawMessage: `FASE104-CATCHUP:card-${p.key}` } });
    await tx.installment.createMany({ data: p.rows.map((r) => { const t = Number(p.first.slice(0, 4)) * 12 + (Number(p.first.slice(5)) - 1) + (r.n - 1); return { purchaseId: created.id, number: r.n, amount: r.amount, billMonth: `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}` }; }) });
  }
  await tx.purchase.update({ where: { id: w.shein.id }, data: { description: "Roupas da Bia — Shein" } });
  const setBill = (m, data) => tx.cardBill.update({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: m } }, data });
  await setBill("2026-10", { totalAmount: "1795.77", status: "closed", dueAt: d("2026-10-13T00:00:00Z") });
  await setBill("2026-11", { totalAmount: "571.79" });
  await setBill("2026-12", { totalAmount: "93.84" });
  await setBill("2027-01", { totalAmount: "93.84" });
  await tx.cardBillReconciliation.create({ data: { cardId: w.card.id, cycleMonth: "2026-10", observedTotal: "1795.77", calculatedTotal: "1795.77", delta: "0", occurredAt: d("2026-10-05T02:59:59Z") } });
  await tx.cardLimitUpdate.create({ data: { cardId: w.card.id, newTotalLimit: "5087", newUsedLimit: "2615.84", reportedAvailable: "2471.16", occurredAt: d("2026-10-05T02:59:59Z") } });
}

