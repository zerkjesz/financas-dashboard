// Fase 8.0.1 — FATURA OBSERVADA COMO VERDADE DA OBRIGAÇÃO (read-models sem side effect).
// Cenário: detalhe conhecido R$960,40; CardBill guardado defasado R$716,97; observado R$1.616,54
// (CardBillReconciliation). Esperado: obrigação atual = 1.616,54 em TODOS os read-models
// (view, freeMoney, safeToSpend, simulador, Telegram), lacuna 656,14 preservada, ZERO
// Expense/Purchase fabricado, ZERO escrita por leitura. Fixtures sintéticas (cartão/conta
// próprios); totais globais medidos por DELTA porque o DEV tem dados reais de fundo.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney, compareMoney } from "../lib/money.js";
import { getCardCycleForDate, getCardBillPeriod, getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";
import { listCardBillsView, payBill, computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { applyCardBillReconciliation } from "../lib/cardBillReconciliation.js";
import { computeFreeMoney, computeSafeToSpend, getObligationsBreakdown } from "../lib/freeMoney.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import { simulateFinancialScenario, SIMULATION_SCENARIO_TYPE } from "../lib/simulation/financialSimulator.js";
import { handleReadIntent } from "../lib/telegramReads.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { getNextIncomeInfo } from "../lib/incomeHorizon.js";

const MARK = "TESTE_OBS8";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const num = (x) => Number(serializeMoney(x));
const eq = (a, b) => compareMoney(a, money(b)) === 0;
const norm = (s) => String(s).replace(/\s/g, " ");

const created = { cards: [], accounts: [] };
async function cleanup() {
  for (const c of created.cards) {
    await prisma.transfer.deleteMany({ where: { toCardId: c } }).catch(() => {});
    await prisma.cardBillReconciliation.deleteMany({ where: { cardId: c } }).catch(() => {});
    await prisma.expense.deleteMany({ where: { cardId: c } }).catch(() => {});
    const ps = await prisma.purchase.findMany({ where: { cardId: c }, select: { id: true } });
    for (const p of ps) await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.deleteMany({ where: { cardId: c } }).catch(() => {});
    await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
    await prisma.card.delete({ where: { id: c } }).catch(() => {});
  }
  for (const a of created.accounts) {
    await prisma.transfer.deleteMany({ where: { fromAccountId: a } }).catch(() => {});
    await prisma.account.delete({ where: { id: a } }).catch(() => {});
  }
  const left = await Promise.all([prisma.card.count({ where: { slug: { contains: "teste-obs8" } } }), prisma.account.count({ where: { slug: { contains: "teste-obs8" } } }), prisma.expense.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((n) => n === 0), JSON.stringify(left));
}

async function main() {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const account = await prisma.account.create({ data: { slug: "teste-obs8-conta", name: `${MARK} conta`, type: "checking" } });
  created.accounts.push(account.id);
  const card = await prisma.card.create({ data: { slug: "teste-obs8-card", name: `${MARK} Cartão`, totalLimit: 5000, closingDay: 4, dueDay: 11, accountId: account.id } });
  created.cards.push(card.id);
  const cycle = getCardCycleForDate(card, now);

  // Detalhe conhecido = 960,40 (Expense real do cartão, dentro do ciclo atual).
  await prisma.expense.create({ data: { amount: 960.4, description: `${MARK} detalhe conhecido`, category: "Outros", cardId: card.id, source: "manual", occurredAt: today } });
  // CardBill PERSISTIDO defasado (o valor guardado que os read-models liam antes): 716,97.
  const stale = await prisma.cardBill.create({ data: { cardId: card.id, cycleMonth: cycle, closesAt: getCardBillClosesAt(card, cycle), dueAt: getCardBillDueDate(card, cycle), totalAmount: 716.97, status: "open" } });

  const nextIncome = await getNextIncomeInfo({ now });
  const accounts = await listAccountsWithBalances();
  const fmBefore = await computeFreeMoney({ now, accounts, nextIncomeDate: nextIncome.expectedDate });
  const breakdownBefore = await getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate });
  const settingsSafety = 10;
  const safeBefore = computeSafeToSpend(fmBefore.freeMoney, settingsSafety);
  const engineBefore = await buildFinancialEngineSummary({ now });
  const simBefore = await simulateFinancialScenario({ now, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 1 } });
  const itemOf = (bd) => bd[Object.keys(bd).find((k) => bd[k].items.some((i) => i.type === "CardBill" && i.cardId === card.id))]?.items.find((i) => i.type === "CardBill" && i.cardId === card.id && i.cycleMonth === cycle);

  // ---------- [A] SEM reconciliação: fallback = lógica atual (valor guardado)
  const itemNoRec = itemOf(breakdownBefore);
  check("[A] sem reconciliação: obrigação da fatura = valor guardado 716,97 (fallback inalterado)", itemNoRec && eq(itemNoRec.amount, 716.97), itemNoRec && String(num(itemNoRec.amount)));
  const viewNoRec = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[A] sem reconciliação: view.totalSource = stored", viewNoRec.totalSource === "stored" && eq(viewNoRec.totalAmount, 716.97));

  // ---------- [B] reconciliação de OUTRO ciclo / OUTRO cartão NÃO sobrescreve
  const otherCycle = "2099-01";
  await prisma.cardBillReconciliation.create({ data: { cardId: card.id, cycleMonth: otherCycle, observedTotal: 9999, calculatedTotal: 0, delta: 9999, confidence: "RECONCILIATION_ADJUSTMENT", source: "manual" } });
  const otherCard = await prisma.card.create({ data: { slug: "teste-obs8-card2", name: `${MARK} Outro`, totalLimit: 1000, dueDay: 11 } });
  created.cards.push(otherCard.id);
  await prisma.cardBillReconciliation.create({ data: { cardId: otherCard.id, cycleMonth: cycle, observedTotal: 8888, calculatedTotal: 0, delta: 8888, confidence: "RECONCILIATION_ADJUSTMENT", source: "manual" } });
  const viewOther = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[B] reconciliação de outro ciclo/cartão NÃO sobrescreve a fatura atual", viewOther.totalSource === "stored" && eq(viewOther.totalAmount, 716.97));
  await prisma.cardBillReconciliation.deleteMany({ where: { cardId: { in: [card.id, otherCard.id] } } });

  // ---------- reconciliação REAL via serviço existente (nunca Expense)
  const expensesBefore = await prisma.expense.count({ where: { cardId: card.id } });
  const purchasesBefore = await prisma.purchase.count({ where: { cardId: card.id } });
  const { record, preview } = await applyCardBillReconciliation(card.id, 1616.54, { date: now, rawMessage: `${MARK} obs` });
  check("[C] serviço: calculado = 960,40; observado = 1.616,54; delta = 656,14", preview.calculated === 960.4 && preview.observed === 1616.54 && preview.delta === 656.14, JSON.stringify([preview.calculated, preview.observed, preview.delta]));
  check("[C] reconciliação nunca cria Expense/Purchase", (await prisma.expense.count({ where: { cardId: card.id } })) === expensesBefore && (await prisma.purchase.count({ where: { cardId: card.id } })) === purchasesBefore);

  // ---------- [D] view: obrigação atual = 1.616,54; detalhe 960,40; lacuna 656,14
  const cardBillCountBefore = await prisma.cardBill.count({ where: { cardId: card.id } });
  const view = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[D] CURRENT_CARD_OBLIGATION (view) = 1616.54", eq(view.totalAmount, 1616.54), String(num(view.totalAmount)));
  check("[D] KNOWN_DETAIL = 960.40", eq(view.knownDetailTotal, 960.4), String(num(view.knownDetailTotal)));
  check("[D] KNOWN_CARD_DETAIL_GAP = 656.14", eq(view.knownDetailGap, 656.14), String(num(view.knownDetailGap)));
  check("[D] totalSource = observed", view.totalSource === "observed");
  check("[D] CardBill guardado NÃO foi reescrito (continua 716,97 — sem side effect)", eq((await prisma.cardBill.findUnique({ where: { id: stale.id } })).totalAmount, 716.97));
  check("[D] leitura não materializa nenhuma CardBill nova", (await prisma.cardBill.count({ where: { cardId: card.id } })) === cardBillCountBefore);
  check("[D] computeExpectedCardBillTotal (detalhe) continua 960,40", eq(await computeExpectedCardBillTotal(card, cycle), 960.4));

  // ---------- [E] freeMoney / safeToSpend / engine / simulador / Telegram usam 1.616,54
  const breakdownAfter = await getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate });
  const itemRec = itemOf(breakdownAfter);
  check("[E] obrigação classificada da fatura = 1616.54 (não 716,97 nem 960,40)", itemRec && eq(itemRec.amount, 1616.54), itemRec && String(num(itemRec.amount)));
  const fmAfter = await computeFreeMoney({ now, accounts, nextIncomeDate: nextIncome.expectedDate });
  const expectedDelta = -(1616.54 - 716.97);
  check("[E] freeMoney usa 1616.54: delta = -(1616,54 - 716,97)", Math.abs(num(fmAfter.freeMoney) - num(fmBefore.freeMoney) - expectedDelta) < 0.005, `${num(fmAfter.freeMoney) - num(fmBefore.freeMoney)} vs ${expectedDelta}`);
  const safeAfter = computeSafeToSpend(fmAfter.freeMoney, settingsSafety);
  const safeDelta = num(safeAfter.safeToSpend) - num(safeBefore.safeToSpend);
  check("[E] safeToSpend recalculado sobre o freeMoney novo (nunca o antigo)", num(fmBefore.freeMoney) <= 0 || Math.abs(safeDelta - expectedDelta * 0.9) < 0.02 || num(fmAfter.freeMoney) <= 0, String(safeDelta));
  const engineAfter = await buildFinancialEngineSummary({ now });
  check("[E] engine.incurredLiabilities sobe exatamente 899,57 (observado − guardado)", Math.abs(num(engineAfter.obligations.incurredLiabilities) - num(engineBefore.obligations.incurredLiabilities) - 899.57) < 0.005, String(num(engineAfter.obligations.incurredLiabilities) - num(engineBefore.obligations.incurredLiabilities)));
  const simAfter = await simulateFinancialScenario({ now, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 1 } });
  check("[E] simulador (baseline) usa a fatura observada: incurredLiabilities +899,57", Math.abs(num(simAfter.baseline.incurredLiabilities) - num(simBefore.baseline.incurredLiabilities) - 899.57) < 0.005);
  check("[E] simulador baseline.freeMoney = engine (mesma fonte)", eq(simAfter.baseline.freeMoney, engineAfter.freeMoney));
  const tgText = norm(await handleReadIntent("read_free_money", { now }));
  check("[E] Telegram read_free_money mostra a fatura de R$ 1.616,54", tgText.includes(`Fatura ${MARK} Cartão (${cycle}): R$ 1.616,54`), tgText.slice(0, 400));
  check("[E] Telegram NÃO mostra 716,97 nem 960,40 como obrigação dessa fatura", !tgText.includes(`Fatura ${MARK} Cartão (${cycle}): R$ 716,97`) && !tgText.includes(`Fatura ${MARK} Cartão (${cycle}): R$ 960,40`)); // (o cartão real do DEV pode ter os próprios números — checa só o cartão do teste)

  // ---------- [F] lançamento DEPOIS da observação soma; retroativo não duplica
  await new Promise((r) => setTimeout(r, 30));
  await prisma.expense.create({ data: { amount: 100, description: `${MARK} depois da observação`, category: "Outros", cardId: card.id, source: "manual", occurredAt: today } });
  const viewAfterNew = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[F] compra feita DEPOIS da observação soma: 1716,54", eq(viewAfterNew.totalAmount, 1716.54), String(num(viewAfterNew.totalAmount)));
  check("[F] lacuna continua 656,14 (o novo item entra no detalhe conhecido)", eq(viewAfterNew.knownDetailGap, 656.14), String(num(viewAfterNew.knownDetailGap)));
  const { start } = getCardBillPeriod(card, cycle);
  if (start < today) {
    await prisma.expense.create({ data: { amount: 50, description: `${MARK} retroativo`, category: "Outros", cardId: card.id, source: "manual", occurredAt: start } });
    const viewRetro = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
    check("[F] lançamento RETROATIVO (data anterior à observação) NÃO duplica: total continua 1716,54", eq(viewRetro.totalAmount, 1716.54), String(num(viewRetro.totalAmount)));
    check("[F] retroativo reduz a lacuna (656,14 → 606,14) em vez de inflar a obrigação", eq(viewRetro.knownDetailGap, 606.14), String(num(viewRetro.knownDetailGap)));
  } else {
    console.log("↷ [F] retroativo: hoje é o 1º dia do ciclo — sem dia anterior dentro da janela (n/a hoje)");
  }
  await prisma.expense.deleteMany({ where: { cardId: card.id, description: { in: [`${MARK} depois da observação`, `${MARK} retroativo`] } } });

  // ---------- [G] reconciliação mais recente vence
  await new Promise((r) => setTimeout(r, 30));
  await prisma.cardBillReconciliation.create({ data: { cardId: card.id, cycleMonth: cycle, observedTotal: 1700, calculatedTotal: 960.4, delta: 739.6, confidence: "RECONCILIATION_ADJUSTMENT", source: "manual", rawMessage: `${MARK} nova` } });
  const viewNewer = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[G] havendo duas reconciliações do ciclo, a mais recente é a verdade (1.700,00)", eq(viewNewer.totalAmount, 1700), String(num(viewNewer.totalAmount)));
  await prisma.cardBillReconciliation.deleteMany({ where: { cardId: card.id, rawMessage: `${MARK} nova` } });

  // ---------- [H] pagar a fatura REAL: aceita o observado, recusa excesso
  const bill = await prisma.cardBill.findUnique({ where: { id: stale.id } });
  let over = null;
  try { await payBill(bill.id, { fromAccountId: account.id, amount: 1616.55, description: `${MARK} excesso` }); } catch (e) { over = e; }
  check("[H] pagamento acima do observado (1.616,55) é recusado", over && /maior que o restante/.test(over.message), over && over.message);
  check("[H] nenhum Transfer criado pela recusa", (await prisma.transfer.count({ where: { fromAccountId: account.id } })) === 0);
  const paid1 = await payBill(bill.id, { fromAccountId: account.id, amount: 1000, description: `${MARK} parcial` });
  check("[H] pagamento parcial de 1.000 aceito (antes seria bloqueado só se > guardado): partially_paid", paid1.bill.status === "partially_paid");
  const viewMid = (await listCardBillsView(card.id, { now })).find((b) => b.cycleMonth === cycle);
  check("[H] restante = 616,54 (1.616,54 − 1.000)", eq(money(viewMid.totalAmount).minus(money(viewMid.paidAmount)), 616.54));
  const paid2 = await payBill(bill.id, { fromAccountId: account.id, amount: 616.54, description: `${MARK} quitação` });
  check("[H] quitar o restante de 616,54 → status paid (contra o total observado)", paid2.bill.status === "paid" && eq(paid2.bill.paidAmount, 1616.54));
  const bdPaid = await getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate });
  const itemPaid = itemOf(bdPaid);
  check("[H] fatura quitada deixa de ser obrigação", !itemPaid || eq(itemPaid.amount, 0) || Object.entries(bdPaid).every(([k, v]) => !v.items.some((i) => i.type === "CardBill" && i.cardId === card.id && i.cycleMonth === cycle && num(i.amount) > 0)));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
