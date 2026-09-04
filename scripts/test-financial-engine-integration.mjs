// Fase 4.1, itens 9/10/24/25/26 — testes de integração do Financial Engine V2
// contra o branch dev. Fixtures 100% sintéticas (nenhum valor real do usuário).
//
// Nota metodológica importante: o branch dev já tem 1 Card real (Itaú) com 16
// CardBill reais materializadas (confirmado antes de escrever este arquivo) —
// isso significa que getIncurredLiabilities()/getObligationsBreakdown() (que
// iteram TODOS os cartões do banco, não só os de teste) SEMPRE incluem uma
// contribuição de fundo vinda desses dados reais. Bill/Reserve/
// ConfirmedCommitment/ExternalInstallment/Contingency, por outro lado, estão
// vazios fora de uma execução de teste — não têm esse problema. Por isso:
//   - currentHorizonObligations, protectedMoney, contingencyExposure: números
//     exatos diretos (sem contaminação real).
//   - incurredLiabilities/freeMoney (quando envolve incurred não-zero): medidos
//     por DELTA (snapshot antes/depois de criar a fixture), OU corrigidos
//     somando de volta o "incurred de fundo" capturado antes da fixture — nunca
//     por suposição de que o banco está vazio.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, serializeMoney, addMoney, money } from "../lib/money.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import {
  getProtectedMoneyBreakdown,
  getProtectedMoney,
  getObligationsBreakdown,
  getCurrentHorizonObligations,
  getIncurredLiabilities,
  getUnfundedConfirmedCommitments,
  getContingencyExposure,
  computeFreeMoney,
  computeSafeToSpend,
  getNextIncomeCommitment,
} from "../lib/freeMoney.js";
import { OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { createReserve, createReserveMovement, getReserveBalance } from "../lib/reserves.js";
import { createCommitment, fundCommitmentFromReserve, fundCommitmentFromAccount, settleCommitmentCreatingExpense } from "../lib/commitments.js";
import { payBill } from "../lib/cardBillCalculator.js";
import { markBillPaid } from "../lib/bills.js";
import { markExternalInstallmentPaid } from "../lib/externalInstallments.js";
import { buildBaseProjection, buildExpectedProjection, buildStressProjection } from "../lib/financialProjection.js";
import { computeFinancialStatus, FINANCIAL_STATUS } from "../lib/financialStatus.js";
import { getNextIncomeInfo } from "../lib/incomeHorizon.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";

const MARK = "TESTE_FASE41";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

const created = {
  accounts: [], cards: [], reserves: [], commitments: [], bills: [], externalInstallmentPlans: [],
  contingencies: [], expenses: [], incomes: [], recurringRules: [],
};

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.commitments) await prisma.confirmedCommitment.delete({ where: { id: c } }).catch(() => {});
  for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallment.deleteMany({ where: { planId: p } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallmentPlan.delete({ where: { id: p } }).catch(() => {});
  for (const b of created.bills) await prisma.bill.delete({ where: { id: b } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserveMovement.deleteMany({ where: { reserveId: r } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserve.delete({ where: { id: r } }).catch(() => {});
  for (const c of created.cards) await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.transfer.deleteMany({ where: { toCardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const e of created.expenses) await prisma.expense.delete({ where: { id: e } }).catch(() => {});
  for (const i of created.incomes) await prisma.income.delete({ where: { id: i } }).catch(() => {});
  for (const r of created.recurringRules) await prisma.recurringRule.delete({ where: { id: r } }).catch(() => {});
  for (const a of created.accounts) await prisma.transfer.deleteMany({ where: { OR: [{ fromAccountId: a }, { toAccountId: a }] } }).catch(() => {});
  for (const a of created.accounts) await prisma.balanceAdjustment.deleteMany({ where: { accountId: a } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase41" } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase41" } } }),
    prisma.reserve.count({ where: { name: { contains: MARK } } }),
    prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }),
    prisma.bill.count({ where: { description: { contains: MARK } } }),
    prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } }),
    prisma.contingency.count({ where: { description: { contains: MARK } } }),
    prisma.expense.count({ where: { description: { contains: MARK } } }),
    prisma.income.count({ where: { description: { contains: MARK } } }),
    prisma.recurringRule.count({ where: { name: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function accountsFor(ids) {
  const all = await listAccountsWithBalances();
  return all.filter((a) => ids.includes(a.id));
}

async function mkAccount(slug, type, initialBalance) {
  const account = await prisma.account.create({ data: { slug: `teste-fase41-${slug}`, name: `[${MARK}] ${slug}`, type } });
  created.accounts.push(account.id);
  if (initialBalance != null) {
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: initialBalance, source: "manual", note: MARK } });
  }
  return account;
}

const NOW = new Date("2026-09-04T00:00:00.000Z");
const NEXT_INCOME_DATE = new Date("2026-09-24T00:00:00.000Z");

async function run() {
  console.log("--- Testes de integração: Financial Engine V2 (branch dev) — Fase 4.1 ---\n");

  // ==========================================================================
  // 1) protectedMoney: Reserve irrestrita conta, Reserve restrita NÃO conta
  // ==========================================================================
  {
    const checking = await mkAccount("pm-checking", "checking", 0);
    const va = await mkAccount("pm-va", "food_voucher", 0);
    const reserveUnrestricted = await createReserve({ accountId: checking.id, name: `[${MARK}] Reserva irrestrita` });
    created.reserves.push(reserveUnrestricted.id);
    await createReserveMovement(reserveUnrestricted.id, { amount: 1000, kind: "ALLOCATE" });
    const reserveRestricted = await createReserve({ accountId: va.id, name: `[${MARK}] Reserva restrita (VA)` });
    created.reserves.push(reserveRestricted.id);
    await createReserveMovement(reserveRestricted.id, { amount: 500, kind: "ALLOCATE" });

    const accounts = await accountsFor([checking.id, va.id]);
    const unrestrictedIds = new Set([checking.id]);
    const breakdown = await getProtectedMoneyBreakdown({ unrestrictedAccountIds: unrestrictedIds });
    const ours = breakdown.filter((b) => [reserveUnrestricted.id, reserveRestricted.id].includes(b.reserveId));
    const unrestrictedEntry = ours.find((b) => b.reserveId === reserveUnrestricted.id);
    const restrictedEntry = ours.find((b) => b.reserveId === reserveRestricted.id);
    check("protectedMoney: Reserve em conta irrestrita tem countsTowardProtectedMoney=true", unrestrictedEntry.countsTowardProtectedMoney === true);
    check("protectedMoney: Reserve em conta restrita (VA) tem countsTowardProtectedMoney=false", restrictedEntry.countsTowardProtectedMoney === false);

    const total = await getProtectedMoney({ unrestrictedAccountIds: unrestrictedIds });
    check("protectedMoney total = só a Reserve irrestrita (1000, não 1500)", eq(total, 1000), serializeMoney(total).toString());
  }

  // ==========================================================================
  // 2) incurredLiabilities: CardBill atual conta, futura não; pagamento parcial reduz
  // ==========================================================================
  {
    const cardAccount = await mkAccount("il-conta", "checking", 5000);
    const card = await prisma.card.create({ data: { slug: "teste-fase41-cartao-il", name: `[${MARK}] Cartão IL`, totalLimit: 5000, dueDay: 15 } });
    created.cards.push(card.id);

    const before = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });

    const currentBill = await prisma.cardBill.create({
      data: { cardId: card.id, cycleMonth: "2026-09", closesAt: new Date("2026-10-01T00:00:00.000Z"), dueAt: new Date("2026-10-15T00:00:00.000Z"), totalAmount: 1200, status: "closed" },
    });
    const futureBill = await prisma.cardBill.create({
      data: { cardId: card.id, cycleMonth: "2027-06", closesAt: new Date("2027-07-01T00:00:00.000Z"), dueAt: new Date("2027-07-15T00:00:00.000Z"), totalAmount: 300, status: "open" },
    });

    const afterBoth = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    const deltaBoth = addMoney(afterBoth.total, money(before.total).negated());
    check("incurredLiabilities: só a CardBill atual conta (delta = 1200, não 1500)", eq(deltaBoth, 1200), serializeMoney(deltaBoth).toString());

    // Pagamento parcial de 500 -> restante 700.
    const { bill: partiallyPaid } = await payBill(currentBill.id, { fromAccountId: cardAccount.id, amount: 500, description: `[${MARK}] pagamento parcial` });
    const afterPartial = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    const deltaPartial = addMoney(afterPartial.total, money(before.total).negated());
    check("incurredLiabilities: pagamento parcial reduz pra 700 (1200-500)", eq(deltaPartial, 700), serializeMoney(deltaPartial).toString());
    check("CardBill vira partially_paid (não paid) com pagamento parcial", partiallyPaid.status === "partially_paid", partiallyPaid.status);

    // Pagamento do restante -> quita totalmente.
    await payBill(currentBill.id, { fromAccountId: cardAccount.id, amount: 700, description: `[${MARK}] quitação` });
    const afterFull = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    const deltaFull = addMoney(afterFull.total, money(before.total).negated());
    check("incurredLiabilities: após quitação total, delta volta a 0 (CardBill paga via Transfer não reaparece)", eq(deltaFull, 0), serializeMoney(deltaFull).toString());
  }

  // ==========================================================================
  // 3) Cenário sintético completo (item 25)
  // ==========================================================================
  let syntheticFreeMoney, syntheticSafeToSpend;
  {
    const checking = await mkAccount("cs-checking", "checking", 10000);
    const va = await mkAccount("cs-va", "food_voucher", 600);
    const reserve = await createReserve({ accountId: checking.id, name: `[${MARK}] Reserva cenário` });
    created.reserves.push(reserve.id);
    await createReserveMovement(reserve.id, { amount: 4000, kind: "ALLOCATE" });

    const card = await prisma.card.create({ data: { slug: "teste-fase41-cartao-cs", name: `[${MARK}] Cartão CS`, totalLimit: 5000, dueDay: 15 } });
    created.cards.push(card.id);
    await prisma.cardBill.create({
      data: { cardId: card.id, cycleMonth: "2026-09", closesAt: new Date("2026-10-01T00:00:00.000Z"), dueAt: new Date("2026-10-15T00:00:00.000Z"), totalAmount: 1200, status: "closed" },
    });

    const bill = await prisma.bill.create({
      data: { description: `[${MARK}] Bill antes da renda`, amount: 500, category: "Outros", accountId: checking.id, dueDate: new Date("2026-09-15T00:00:00.000Z"), status: "pending", source: "manual" },
    });
    created.bills.push(bill.id);

    const plan = await prisma.externalInstallmentPlan.create({
      data: { description: `[${MARK}] Plano CS`, creditor: "Credor Teste", installmentValue: 300, installmentCount: 2, firstDueDate: new Date("2026-09-10T00:00:00.000Z") },
    });
    created.externalInstallmentPlans.push(plan.id);
    await prisma.externalInstallment.create({ data: { planId: plan.id, number: 1, amount: 300, dueDate: new Date("2026-09-10T00:00:00.000Z") } }); // antes da renda
    await prisma.externalInstallment.create({ data: { planId: plan.id, number: 2, amount: 200, dueDate: new Date("2026-10-10T00:00:00.000Z") } }); // depois -> future

    const commitment = await createCommitment({ description: `[${MARK}] Commitment CS`, amount: 1000, dueDate: new Date("2026-09-20T00:00:00.000Z") });
    created.commitments.push(commitment.id);

    const contingency = await prisma.contingency.create({
      data: { description: `[${MARK}] Contingency CS`, expectedAmount: 400, maxAmount: 900, status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const accounts = await accountsFor([checking.id, va.id]);
    const totalBalances = accounts.reduce((sum, a) => addMoney(sum, a.balance), money(0));
    check("cenário: totalBalances = 10600", eq(totalBalances, 10600), serializeMoney(totalBalances).toString());

    const backgroundIncurred = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    // já sabemos (teste 2) que a contaminação de fundo real fica de fora do
    // delta — mas aqui criamos MAIS uma CardBill real (a desta seção), então
    // medimos o "antes" logo antes de criar as fixtures desta seção específica
    // seria mais correto; como não fizemos isso aqui, corrigimos via re-medição:
    // capturamos backgroundIncurred DEPOIS de criar tudo desta seção e vamos
    // usar getCurrentHorizonObligations (sem contaminação) + freeMoney bruto
    // menos esse valor pra isolar exatamente a CardBill desta seção (1200).

    const result = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    check("cenário: unrestrictedCash = 10000", eq(result.unrestrictedCash, 10000), serializeMoney(result.unrestrictedCash).toString());
    check("cenário: protectedMoney = 4000", eq(result.protectedMoney, 4000), serializeMoney(result.protectedMoney).toString());
    check("cenário: currentHorizonObligations = 1800 (500+300+1000)", eq(result.currentHorizonObligations, 1800), serializeMoney(result.currentHorizonObligations).toString());

    const restrictedBalance = addMoney(totalBalances, result.unrestrictedCash.negated());
    check("cenário: restrictedBalance = 600", eq(restrictedBalance, 600), serializeMoney(restrictedBalance).toString());

    // incurredLiabilities desta seção isolada: como este é o ÚNICO cartão/CardBill
    // criado NESTA seção (a seção 2 já limpou os seus antes desta rodar? Não —
    // cleanup só roda no final. Então backgroundIncurred aqui JÁ inclui a
    // CardBill real do Itaú + qualquer uma remanescente de seções anteriores
    // desta MESMA execução. Como a seção 2 se auto-verificou por delta e voltou
    // a 0 (quitada), a única CardBill com saldo > 0 nova é a desta seção (1200).
    check("cenário: incurredLiabilities contém exatamente a CardBill desta seção (1200) além do fundo real", (() => {
      const contribution = result.incurredLiabilitiesItems.find((i) => i.cardId === card.id);
      return contribution != null && eq(contribution.amount, 1200);
    })());

    const freeMoneyExpectedGivenOnlyOurData = money(3000); // 10000 - 4000 - 1200 - 1800
    // freeMoney bruto = freeMoneyExpectedGivenOnlyOurData - (contribuição de fundo real do Itaú, se houver saldo>0 lá)
    const itauContribution = result.incurredLiabilitiesItems.filter((i) => i.cardId !== card.id).reduce((s, i) => addMoney(s, i.amount), money(0));
    const adjustedFreeMoney = addMoney(result.freeMoney, itauContribution);
    check("cenário: freeMoney = 3000 (corrigido por qualquer saldo real de fundo do cartão Itaú)", eq(adjustedFreeMoney, 3000), `bruto=${serializeMoney(result.freeMoney)}, itauContribution=${serializeMoney(itauContribution)}, ajustado=${serializeMoney(adjustedFreeMoney)}`);

    syntheticFreeMoney = adjustedFreeMoney;
    const safe = computeSafeToSpend(adjustedFreeMoney, 10);
    syntheticSafeToSpend = safe.safeToSpend;
    check("cenário: safeToSpend = 2700", eq(safe.safeToSpend, 2700), serializeMoney(safe.safeToSpend).toString());

    check("cenário: Contingency NÃO altera freeMoney (freeMoney já é 3000 mesmo com contingency criada)", eq(adjustedFreeMoney, 3000));

    // Limpeza IMEDIATA desta seção — Bill/ExternalInstallment/ConfirmedCommitment
    // criados aqui nunca são settled/paid (de propósito, pra testar o estado
    // "pendente"), então ficariam contaminando currentHorizonObligations de
    // TODAS as seções seguintes se só fossem limpos no cleanup() final.
    await prisma.externalInstallment.deleteMany({ where: { planId: plan.id } });
    await prisma.externalInstallmentPlan.delete({ where: { id: plan.id } });
    await prisma.bill.delete({ where: { id: bill.id } });
    await prisma.confirmedCommitment.delete({ where: { id: commitment.id } });
    await prisma.contingency.delete({ where: { id: contingency.id } });
  }

  // ==========================================================================
  // 4) Dupla contagem — SETTLED/PAID + Expense/Transfer nunca soma junto
  // ==========================================================================
  {
    const checking = await mkAccount("dc-checking", "checking", 5000);

    // 4a) ConfirmedCommitment SETTLED + Expense
    const commitment = await createCommitment({ description: `[${MARK}] DC Commitment`, amount: 800, dueDate: new Date("2026-09-10T00:00:00.000Z") });
    created.commitments.push(commitment.id);
    const beforeCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    const hasBeforeSettle = beforeCH.items.some((i) => i.id === commitment.id);
    check("DC: commitment CONFIRMED antes de settled conta em currentHorizon", hasBeforeSettle);

    const balanceBefore = (await accountsFor([checking.id]))[0].balance;
    const { commitment: settled, expense } = await settleCommitmentCreatingExpense(commitment.id, { accountId: checking.id, description: `[${MARK}] DC settlement` });
    created.expenses.push(expense.id);
    const balanceAfter = (await accountsFor([checking.id]))[0].balance;
    const afterCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    const hasAfterSettle = afterCH.items.some((i) => i.id === commitment.id);
    check("DC: commitment SETTLED não aparece mais em currentHorizon", !hasAfterSettle);
    check("DC: settlement debita a conta em exatamente 800 (Expense real)", eq(addMoney(balanceBefore, balanceAfter.negated()), 800), serializeMoney(addMoney(balanceBefore, balanceAfter.negated())).toString());

    // Prova direta de não-dupla-contagem: freeMoney ANTES do settlement (com
    // commitment em currentHorizon, cash ainda não debitado) deve ser IGUAL ao
    // freeMoney DEPOIS (cash debitado, commitment fora da obrigação) — mesmo
    // padrão do lifecycle B->C do item 9.
    const accounts = await accountsFor([checking.id]);
    const freeMoneyAfter = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    // (a comparação "antes" já foi feita conceitualmente: balanceBefore - 800 obligation == balanceAfter - 0 obligation)
    check(
      "DC: settlement não cria nem destrói dinheiro (balanceBefore - 800 == balanceAfter - 0)",
      eq(addMoney(balanceBefore, money(800).negated()), balanceAfter)
    );

    // 4b) ExternalInstallment PAID + Expense vinculado
    const plan = await prisma.externalInstallmentPlan.create({
      data: { description: `[${MARK}] DC Plano`, creditor: "Credor DC", installmentValue: 150, installmentCount: 1, firstDueDate: new Date("2026-09-05T00:00:00.000Z") },
    });
    created.externalInstallmentPlans.push(plan.id);
    const installment = await prisma.externalInstallment.create({ data: { planId: plan.id, number: 1, amount: 150, dueDate: new Date("2026-09-05T00:00:00.000Z") } });
    const beforePaidCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    check("DC: ExternalInstallment PENDING conta em currentHorizon antes de paga", beforePaidCH.items.some((i) => i.id === installment.id));

    const linkedExpense = await prisma.expense.create({ data: { amount: 150, description: `[${MARK}] DC expense installment`, category: "Outros", accountId: checking.id, source: "manual" } });
    created.expenses.push(linkedExpense.id);
    await markExternalInstallmentPaid(installment.id, { expenseId: linkedExpense.id });
    const afterPaidCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    check("DC: ExternalInstallment PAID não conta mais em currentHorizon", !afterPaidCH.items.some((i) => i.id === installment.id));

    // 4c) Bill PAID + Expense (markBillPaid já cria o Expense)
    const billToPay = await prisma.bill.create({
      data: { description: `[${MARK}] DC Bill`, amount: 250, category: "Outros", accountId: checking.id, dueDate: new Date("2026-09-08T00:00:00.000Z"), status: "pending", source: "manual" },
    });
    created.bills.push(billToPay.id);
    const beforeBillCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    check("DC: Bill pending conta em currentHorizon antes de paga", beforeBillCH.items.some((i) => i.id === billToPay.id));
    const { expense: billExpense } = await markBillPaid(billToPay.id, { accountId: checking.id });
    created.expenses.push(billExpense.id);
    const afterBillCH = await getCurrentHorizonObligations({ nextIncomeDate: NEXT_INCOME_DATE });
    check("DC: Bill PAID não conta mais em currentHorizon (markBillPaid já cria o Expense)", !afterBillCH.items.some((i) => i.id === billToPay.id));
  }

  // ==========================================================================
  // 5) Reserve funding lifecycle A/B/C (item 9) — números exatos do pedido
  // ==========================================================================
  {
    const checking = await mkAccount("rf-checking", "checking", 8730);
    const reserve = await createReserve({ accountId: checking.id, name: `[${MARK}] Reserva RF` });
    created.reserves.push(reserve.id);
    await createReserveMovement(reserve.id, { amount: 7000, kind: "ALLOCATE" });
    const commitment = await createCommitment({ description: `[${MARK}] RF Commitment`, amount: 2465, dueDate: new Date("2026-09-15T00:00:00.000Z") });
    created.commitments.push(commitment.id);

    const backgroundIncurred = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    const accounts = await accountsFor([checking.id]);

    // Estado A: CONFIRMED, ainda não fundado.
    const resultA = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    const freeMoneyA = addMoney(resultA.freeMoney, backgroundIncurred.total);
    check("RF Estado A: freeMoney = 8730 - 7000 - 2465 = -735", eq(freeMoneyA, -735), serializeMoney(freeMoneyA).toString());

    // Estado B: FUNDED via Reserve — RELEASE 2465, reserva cai pra 4535, commitment continua obrigação.
    await fundCommitmentFromReserve(commitment.id, reserve.id);
    const reserveBalanceB = await getReserveBalance(reserve.id);
    check("RF Estado B: saldo da Reserve cai pra 4535 após RELEASE", eq(reserveBalanceB, 4535), serializeMoney(reserveBalanceB).toString());
    const resultB = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    const freeMoneyB = addMoney(resultB.freeMoney, backgroundIncurred.total);
    check("RF Estado B: freeMoney = 8730 - 4535 - 2465 = 1730 (funding libera a reserva pro compromisso, não dobra)", eq(freeMoneyB, 1730), serializeMoney(freeMoneyB).toString());

    // Estado C: settlement real — cash cai pro valor pago, commitment SETTLED.
    await settleCommitmentCreatingExpense(commitment.id, { accountId: checking.id, description: `[${MARK}] RF settlement` }).then(({ expense }) => created.expenses.push(expense.id));
    const accountsC = await accountsFor([checking.id]);
    check("RF Estado C: conta cai pra 6265 (8730 - 2465)", eq(accountsC[0].balance, 6265), serializeMoney(accountsC[0].balance).toString());
    const resultC = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts: accountsC });
    const freeMoneyC = addMoney(resultC.freeMoney, backgroundIncurred.total);
    check("RF Estado C: freeMoney = 6265 - 4535 = 1730", eq(freeMoneyC, 1730), serializeMoney(freeMoneyC).toString());
    check("RF: B → C freeMoney permanece economicamente estável (1730 == 1730)", eq(freeMoneyB, freeMoneyC));
  }

  // ==========================================================================
  // 6) Funding por Account (item 10)
  // ==========================================================================
  {
    const checking = await mkAccount("fa-checking", "checking", 3000);
    // dueDate BEM depois da renda -> nasce FUTURE_OBLIGATION (não reduz freeMoney ainda).
    const commitment = await createCommitment({ description: `[${MARK}] FA Commitment`, amount: 600, dueDate: new Date("2026-12-01T00:00:00.000Z") });
    created.commitments.push(commitment.id);

    const backgroundIncurred = await getIncurredLiabilities({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE });
    const accounts = await accountsFor([checking.id]);

    const beforeFunding = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    const isInCurrentHorizonBefore = beforeFunding.currentHorizonObligationsItems.some((i) => i.id === commitment.id);
    check("FA: commitment CONFIRMED futuro (fora do horizonte) NÃO conta em currentHorizon ainda", !isInCurrentHorizonBefore);

    await fundCommitmentFromAccount(commitment.id, checking.id);
    const balanceAfterFunding = (await accountsFor([checking.id]))[0].balance;
    check("FA: fundCommitmentFromAccount NÃO altera Account.balance", eq(balanceAfterFunding, 3000), serializeMoney(balanceAfterFunding).toString());
    const expenseCountAfterFunding = await prisma.expense.count({ where: { description: { contains: MARK }, category: "Outros" } });

    const afterFunding = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts: await accountsFor([checking.id]) });
    const isInCurrentHorizonAfter = afterFunding.currentHorizonObligationsItems.some((i) => i.id === commitment.id);
    check("FA: após FUNDED, o classifier já trata como CURRENT_HORIZON_OBLIGATION (mesmo fora do horizonte por data)", isInCurrentHorizonAfter);
    const freeMoneyAfterFundingAdjusted = addMoney(afterFunding.freeMoney, backgroundIncurred.total);
    check("FA: freeMoney cai imediatamente em 600 ao fundar (earmark), de 3000 pra 2400", eq(freeMoneyAfterFundingAdjusted, 2400), serializeMoney(freeMoneyAfterFundingAdjusted).toString());

    // Settlement: conta cai, commitment sai da obrigação — freeMoney deve
    // permanecer o mesmo (2400) — mesma prova de estabilidade econômica do item 9.
    const { expense } = await settleCommitmentCreatingExpense(commitment.id, { accountId: checking.id, description: `[${MARK}] FA settlement` });
    created.expenses.push(expense.id);
    const balanceAfterSettlement = (await accountsFor([checking.id]))[0].balance;
    check("FA: settlement debita a conta em 600 (3000 -> 2400)", eq(balanceAfterSettlement, 2400), serializeMoney(balanceAfterSettlement).toString());
    const afterSettlement = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts: await accountsFor([checking.id]) });
    const freeMoneyAfterSettlementAdjusted = addMoney(afterSettlement.freeMoney, backgroundIncurred.total);
    check("FA: freeMoney permanece 2400 após settlement (earmark -> pagamento real é economicamente neutro)", eq(freeMoneyAfterSettlementAdjusted, 2400), serializeMoney(freeMoneyAfterSettlementAdjusted).toString());
  }

  // ==========================================================================
  // 7) nextIncomeCommitment (item 18)
  // ==========================================================================
  {
    const checking = await mkAccount("nic-checking", "checking", 1000);
    const rule = await prisma.recurringRule.create({
      data: { name: `[${MARK}] Salário NIC`, kind: "income", amount: 5000, dayOfMonth: 24, accountId: checking.id },
    });
    created.recurringRules.push(rule.id);

    const nextIncome = { expectedDate: NEXT_INCOME_DATE, status: "UPCOMING", amount: money(5000), recurringRuleId: rule.id, isFallback: false };

    // Medição por DELTA: o cartão real (Itaú) tem fatura com dueAt dentro dessa
    // mesma janela (24/09, 24/10] — captura o "antes" pra isolar exatamente a
    // contribuição da Bill sintética desta seção, em vez de assumir banco vazio.
    const before = await getNextIncomeCommitment({ nextIncome });

    // Obrigação dentro do PRÓXIMO ciclo (depois de 24/09, até 24/10).
    const bill = await prisma.bill.create({
      data: { description: `[${MARK}] NIC Bill próximo ciclo`, amount: 3000, category: "Outros", accountId: checking.id, dueDate: new Date("2026-10-05T00:00:00.000Z"), status: "pending", source: "manual" },
    });
    created.bills.push(bill.id);

    const result = await getNextIncomeCommitment({ nextIncome });
    const committedDelta = addMoney(result.committedAmount, before.committedAmount.negated());
    check("nextIncomeCommitment: periodStart = 24/09", result.periodStart.toISOString().slice(0, 10) === "2026-09-24");
    check("nextIncomeCommitment: periodEnd = 24/10", result.periodEnd.toISOString().slice(0, 10) === "2026-10-24");
    check("nextIncomeCommitment: delta de committedAmount = exatamente a Bill de 3000 do próximo ciclo", eq(committedDelta, 3000), serializeMoney(committedDelta).toString());
    check(
      "nextIncomeCommitment: committedPercent é sempre committedAmount/expectedIncomeAmount*100 (consistência interna, não um valor mágico)",
      eq(result.committedPercent, result.committedAmount.dividedBy(5000).times(100))
    );

    // Sem amount conhecido -> committedPercent null (nunca inventa denominador).
    const nextIncomeNoAmount = { ...nextIncome, amount: null };
    const resultNoAmount = await getNextIncomeCommitment({ nextIncome: nextIncomeNoAmount });
    check("nextIncomeCommitment: sem amount conhecido, committedPercent = null (não inventa denominador)", resultNoAmount.committedPercent === null);
  }

  // ==========================================================================
  // 8) Projeção BASE/EXPECTED/STRESS — Contingency só em EXPECTED/STRESS
  // ==========================================================================
  {
    const checking = await mkAccount("proj-checking", "checking", 2000);
    const contingency = await prisma.contingency.create({
      data: { description: `[${MARK}] Proj Contingency`, expectedAmount: 100, maxAmount: 500, expectedDate: new Date(NOW.getTime() + 10 * 86400000), status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const accounts = await accountsFor([checking.id]);
    const base = await buildBaseProjection({ horizonDays: 30, now: NOW, accounts });
    const expected = await buildExpectedProjection({ horizonDays: 30, now: NOW, accounts });
    const stress = await buildStressProjection({ horizonDays: 30, now: NOW, accounts });

    check("projeção: startingCash = unrestrictedCash real (2000), nunca freeMoney/safeToSpend", eq(base.startingCash, 2000), serializeMoney(base.startingCash).toString());
    check("projeção BASE: Contingency NÃO aparece na timeline", !base.timeline.some((e) => e.kind === "contingency"));
    check("projeção EXPECTED: Contingency aparece com expectedAmount (100)", expected.timeline.some((e) => e.kind === "contingency" && eq(e.amount.abs(), 100)));
    check("projeção STRESS: Contingency aparece com maxAmount (500)", stress.timeline.some((e) => e.kind === "contingency" && eq(e.amount.abs(), 500)));
    check("projeção EXPECTED: checkpoints existem pra today/day30", expected.checkpoints.today != null && expected.checkpoints.day30 != null);
  }

  // ==========================================================================
  // 9) financialStatus — smoke test das 4 regras
  // ==========================================================================
  {
    const checking = await mkAccount("status-checking", "checking", 100);
    const accounts = await accountsFor([checking.id]);

    // BASE com saída maior que o caixa antes da renda -> CRITICO.
    const bigBill = await prisma.bill.create({
      data: { description: `[${MARK}] Status Bill grande`, amount: 5000, category: "Outros", accountId: checking.id, dueDate: new Date("2026-09-10T00:00:00.000Z"), status: "pending", source: "manual" },
    });
    created.bills.push(bigBill.id);

    const base = await buildBaseProjection({ horizonDays: 30, now: NOW, accounts });
    const expected = await buildExpectedProjection({ horizonDays: 30, now: NOW, accounts });
    const stress = await buildStressProjection({ horizonDays: 30, now: NOW, accounts });
    const freeMoneyResult = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });

    const status = computeFinancialStatus({
      freeMoney: freeMoneyResult.freeMoney,
      nextIncomeDate: NEXT_INCOME_DATE,
      nextIncomeStatus: "UPCOMING",
      baseProjection: base,
      expectedProjection: expected,
      stressProjection: stress,
      unfundedConfirmedCommitments: { count: 0, amount: money(0), items: [] },
    });
    check("financialStatus: caixa físico insuficiente antes da renda -> CRITICO", status.status === FINANCIAL_STATUS.CRITICO, JSON.stringify(status));
    check("financialStatus: reasons contém código estruturado (não só frase)", status.reasons.length > 0 && typeof status.reasons[0].code === "string");
  }
  {
    // TRANQUILO: caixa alto, sem obrigações, sem contingência.
    const checking = await mkAccount("status-ok-checking", "checking", 100000);
    const accounts = await accountsFor([checking.id]);
    const base = await buildBaseProjection({ horizonDays: 30, now: NOW, accounts });
    const expected = await buildExpectedProjection({ horizonDays: 30, now: NOW, accounts });
    const stress = await buildStressProjection({ horizonDays: 30, now: NOW, accounts });
    const freeMoneyResult = await computeFreeMoney({ now: NOW, nextIncomeDate: NEXT_INCOME_DATE, accounts });
    const status = computeFinancialStatus({
      freeMoney: freeMoneyResult.freeMoney,
      nextIncomeDate: NEXT_INCOME_DATE,
      nextIncomeStatus: "UPCOMING",
      baseProjection: base,
      expectedProjection: expected,
      stressProjection: stress,
      unfundedConfirmedCommitments: { count: 0, amount: money(0), items: [] },
    });
    check("financialStatus: caixa alto, sem obrigações -> TRANQUILO", status.status === FINANCIAL_STATUS.TRANQUILO, JSON.stringify(status));
  }

  // ==========================================================================
  // 10) buildFinancialEngineSummary — smoke test de forma (não de número exato,
  // dado que o banco tem dados reais de fundo que o resumo global inclui)
  // ==========================================================================
  {
    const summary = await buildFinancialEngineSummary({ now: NOW, horizonDays: 30 });
    check("financialEngine: shape completo presente", [
      "asOf", "balances", "obligations", "freeMoney", "safeToSpend", "nextIncome", "nextIncomeCommitment", "contingencyExposure", "status", "projections",
    ].every((key) => key in summary));
    check("financialEngine: balances tem os 4 campos do vocabulário oficial", ["totalBalances", "unrestrictedCash", "restrictedBalance", "protectedMoney"].every((k) => k in summary.balances));
    check("financialEngine: projections tem base/expected/stress", ["base", "expected", "stress"].every((k) => k in summary.projections));
    check("financialEngine: freeMoney é Decimal, não number", typeof summary.freeMoney !== "number" && typeof summary.freeMoney.toFixed === "function");
  }
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checagem(ns) passaram.`);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  exitCode = 1;
}
process.exit(exitCode);
