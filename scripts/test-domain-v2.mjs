// Fase 3.3, item 16 — testes de domínio + integração dos Domain Models V2, contra
// o branch dev. Mesma disciplina das fases anteriores: marcador inconfundível em
// todo dado criado, assertTestEnvironment() antes de qualquer escrita, cleanup
// garantido em `finally`, verificação de evidência de que nada sobrou.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, serializeMoney } from "../lib/money.js";
import {
  createReserve,
  createReserveMovement,
  getReserveBalance,
  computeReplenishmentGap,
} from "../lib/reserves.js";
import {
  createExternalInstallmentPlan,
  markExternalInstallmentPaid,
  computePlanTotal,
  computePlanProgress,
} from "../lib/externalInstallments.js";
import {
  createCommitment,
  fundCommitmentFromReserve,
  settleCommitmentCreatingExpense,
  settleCommitmentWithExpense,
  cancelCommitment,
} from "../lib/commitments.js";
import { createContingency } from "../lib/contingencies.js";
import { createReceivable, markReceivableReceived } from "../lib/receivables.js";
import { setCategoryBudget, getCategoryBudget } from "../lib/categoryBudgets.js";
import { createCardCreditMovement, getCardCreditBalance } from "../lib/cardCredit.js";

const MARK = "TESTE_FASE33";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
async function expectThrow(name, fn) {
  try {
    await fn();
    check(name, false, "não lançou erro (esperado que lançasse)");
  } catch {
    check(name, true);
  }
}

const created = {
  accounts: [],
  cards: [],
  reserves: [],
  externalInstallmentPlans: [],
  commitments: [],
  contingencies: [],
  receivables: [],
  categoryBudgets: [],
  expenses: [],
  incomes: [],
};

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.commitments) await prisma.confirmedCommitment.delete({ where: { id: c } }).catch(() => {});
  for (const r of created.receivables) await prisma.receivable.delete({ where: { id: r } }).catch(() => {});
  for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallment.deleteMany({ where: { planId: p } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallmentPlan.delete({ where: { id: p } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserveMovement.deleteMany({ where: { reserveId: r } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserve.delete({ where: { id: r } }).catch(() => {});
  for (const c of created.cards) await prisma.cardCreditMovement.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const e of created.expenses) await prisma.expense.delete({ where: { id: e } }).catch(() => {});
  for (const i of created.incomes) await prisma.income.delete({ where: { id: i } }).catch(() => {});
  for (const cb of created.categoryBudgets) await prisma.categoryBudget.delete({ where: { id: cb } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase33" } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase33" } } }),
    prisma.reserve.count({ where: { name: { contains: MARK } } }),
    prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } }),
    prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }),
    prisma.contingency.count({ where: { description: { contains: MARK } } }),
    prisma.receivable.count({ where: { description: { contains: MARK } } }),
    prisma.categoryBudget.count({ where: { category: { contains: MARK } } }),
    prisma.expense.count({ where: { description: { contains: MARK } } }),
    prisma.income.count({ where: { description: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de Domain Models V2 (branch dev) — Fase 3.3, item 16 ---\n");

  const account = await prisma.account.create({ data: { slug: "teste-fase33-conta", name: `[${MARK}] Conta`, type: "checking" } });
  created.accounts.push(account.id);
  const card = await prisma.card.create({ data: { slug: "teste-fase33-cartao", name: `[${MARK}] Cartão`, totalLimit: 5000, dueDay: 10 } });
  created.cards.push(card.id);

  // ============================================================================
  // RESERVE
  // ============================================================================
  const reserve = await createReserve({ accountId: account.id, name: `[${MARK}] Importação`, targetAmount: 7000 });
  created.reserves.push(reserve.id);

  await createReserveMovement(reserve.id, { amount: 7000, kind: "ALLOCATE" });
  let balance = await getReserveBalance(reserve.id);
  check("RESERVE: allocate 7000 → saldo 7000", compareMoney(balance, 7000) === 0, serializeMoney(balance).toString());

  await createReserveMovement(reserve.id, { amount: 2465, kind: "RELEASE" });
  balance = await getReserveBalance(reserve.id);
  check("RESERVE: release 2465 → saldo 4535", compareMoney(balance, 4535) === 0, serializeMoney(balance).toString());

  await createReserveMovement(reserve.id, { amount: 1000, kind: "REPLENISH" });
  balance = await getReserveBalance(reserve.id);
  check("RESERVE: replenish 1000 → saldo 5535", compareMoney(balance, 5535) === 0, serializeMoney(balance).toString());

  await expectThrow("RESERVE: amount negativo rejeitado", () => createReserveMovement(reserve.id, { amount: -100, kind: "ALLOCATE" }));
  await expectThrow("RESERVE: amount zero rejeitado", () => createReserveMovement(reserve.id, { amount: 0, kind: "ALLOCATE" }));

  const gap = computeReplenishmentGap(7000, balance);
  check("RESERVE: replenishmentGap = max(0, 7000 - 5535) = 1465", compareMoney(gap, 1465) === 0, serializeMoney(gap).toString());
  const gapWhenAbove = computeReplenishmentGap(1000, balance);
  check("RESERVE: replenishmentGap = 0 quando saldo já passou do target", compareMoney(gapWhenAbove, 0) === 0);

  // ============================================================================
  // EXTERNAL INSTALLMENT
  // ============================================================================
  const plan = await createExternalInstallmentPlan({
    description: `[${MARK}] MacBook`,
    creditor: "Loja X",
    installmentValue: 500,
    installmentCount: 12,
    firstDueDate: new Date("2026-10-05T00:00:00.000Z"),
  });
  created.externalInstallmentPlans.push(plan.id);

  check("EXTERNAL INSTALLMENT: plano 12x gera 12 parcelas", plan.installments.length === 12, String(plan.installments.length));
  const total = computePlanTotal(plan);
  check("EXTERNAL INSTALLMENT: soma = 500*12 = 6000", compareMoney(total, 6000) === 0, serializeMoney(total).toString());
  const numbers = plan.installments.map((i) => i.number).sort((a, b) => a - b);
  check("EXTERNAL INSTALLMENT: números 1..12", JSON.stringify(numbers) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i + 1)));

  const firstInstallment = plan.installments.find((i) => i.number === 1);
  const secondInstallment = plan.installments.find((i) => i.number === 2);
  await markExternalInstallmentPaid(firstInstallment.id, {});
  const secondAfter = await prisma.externalInstallment.findUnique({ where: { id: secondInstallment.id } });
  check("EXTERNAL INSTALLMENT: pagar uma parcela não marca outra", secondAfter.status === "PENDING", secondAfter.status);

  await expectThrow("EXTERNAL INSTALLMENT: pagamento duplicado rejeitado", () => markExternalInstallmentPaid(firstInstallment.id, {}));

  const installmentsAfterOnePaid = await prisma.externalInstallment.findMany({ where: { planId: plan.id } });
  const progress = computePlanProgress(installmentsAfterOnePaid);
  check("EXTERNAL INSTALLMENT: completed derivável (1/12 pago, não completo)", progress.paidCount === 1 && !progress.isFullyPaid, JSON.stringify(progress));

  // ============================================================================
  // CONFIRMED COMMITMENT
  // ============================================================================
  const commitment = await createCommitment({ description: `[${MARK}] Tattoo`, amount: 2465, dueDate: new Date(Date.now() + 15 * 86400000) });
  created.commitments.push(commitment.id);
  check("COMMITMENT: confirmed não é settled", commitment.status === "CONFIRMED", commitment.status);

  const reserve2 = await createReserve({ accountId: account.id, name: `[${MARK}] Reserva Funding` });
  created.reserves.push(reserve2.id);
  await createReserveMovement(reserve2.id, { amount: 7000, kind: "ALLOCATE" });

  const { commitment: fundedCommitment, reserveMovement: releaseMovement } = await fundCommitmentFromReserve(commitment.id, reserve2.id);
  check("COMMITMENT: fund por Reserve cria RELEASE atomicamente", releaseMovement.kind === "RELEASE" && compareMoney(money_(releaseMovement.amount), 2465) === 0, releaseMovement.kind);
  check("COMMITMENT: status vira FUNDED", fundedCommitment.status === "FUNDED", fundedCommitment.status);
  const expenseCountAfterFunding = await prisma.expense.count({ where: { description: { contains: MARK } } });
  check("COMMITMENT: funding não cria Expense", expenseCountAfterFunding === 0, String(expenseCountAfterFunding));

  const { commitment: settledCommitment, expense: settlementExpense } = await settleCommitmentCreatingExpense(commitment.id, { accountId: account.id, description: `[${MARK}] Tattoo paga` });
  created.expenses.push(settlementExpense.id);
  check("COMMITMENT: settlement vincula Expense", settledCommitment.expenseId === settlementExpense.id && settledCommitment.status === "SETTLED", settledCommitment.status);

  await expectThrow("COMMITMENT: settlement duplicado rejeitado", () => settleCommitmentWithExpense(commitment.id, settlementExpense.id));

  const commitment2 = await createCommitment({ description: `[${MARK}] Outro compromisso`, amount: 100, dueDate: new Date(Date.now() + 5 * 86400000) });
  created.commitments.push(commitment2.id);
  await cancelCommitment(commitment2.id);
  await expectThrow(
    "COMMITMENT: cancelado não pode ser settled sem transição válida",
    () => settleCommitmentCreatingExpense(commitment2.id, { accountId: account.id })
  );

  // ============================================================================
  // CONTINGENCY
  // ============================================================================
  const contingency = await createContingency({ description: `[${MARK}] Tiger`, expectedAmount: 300, maxAmount: 500 });
  created.contingencies.push(contingency.id);
  check("CONTINGENCY: expected <= max aceito", compareMoney(money_(contingency.expectedAmount), 300) === 0);

  await expectThrow("CONTINGENCY: expected > max rejeita", () => createContingency({ description: `[${MARK}] Tiger inválido`, expectedAmount: 600, maxAmount: 500 }));

  // ============================================================================
  // RECEIVABLE
  // ============================================================================
  const { computeAccountBalance } = await import("../lib/accounts.js");
  const balancePriorToReceivable = await computeAccountBalance(account.id);
  const receivable = await createReceivable({ description: `[${MARK}] Reembolso`, counterparty: "Empresa X", amount: 400 });
  created.receivables.push(receivable.id);
  const balanceAfterCreatingReceivable = await computeAccountBalance(account.id);
  check(
    "RECEIVABLE: pending não altera saldo (delta zero entre antes/depois de criar)",
    compareMoney(balancePriorToReceivable, balanceAfterCreatingReceivable) === 0,
    `antes=${serializeMoney(balancePriorToReceivable)} depois=${serializeMoney(balanceAfterCreatingReceivable)}`
  );

  const { receivable: receivedReceivable, income: receivableIncome } = await markReceivableReceived(receivable.id, { accountId: account.id });
  created.incomes.push(receivableIncome.id);
  check("RECEIVABLE: received vincula Income", receivedReceivable.incomeId === receivableIncome.id && receivedReceivable.status === "RECEIVED");

  await expectThrow("RECEIVABLE: recebimento duplicado não cria Income duplicado", () => markReceivableReceived(receivable.id, { accountId: account.id }));
  const incomeCountForReceivable = await prisma.income.count({ where: { description: { contains: `[${MARK}] Reembolso` } } });
  check("RECEIVABLE: confirma só 1 Income criado (não 2)", incomeCountForReceivable === 1, String(incomeCountForReceivable));

  // ============================================================================
  // CATEGORY BUDGET
  // ============================================================================
  const budgetCategory = `${MARK}_Alimentação`;
  const cycle1 = new Date("2026-08-24T00:00:00.000Z");
  const cycle2 = new Date("2026-09-24T00:00:00.000Z");
  const budget1 = await setCategoryBudget({ category: budgetCategory, cycleStart: cycle1, amount: 800 });
  created.categoryBudgets.push(budget1.id);
  await expectThrow("BUDGET: único por category+cycleStart (create direto duplicado rejeita)", () =>
    prisma.categoryBudget.create({ data: { category: budgetCategory, cycleStart: cycle1, amount: 900 } })
  );
  const budget2 = await setCategoryBudget({ category: budgetCategory, cycleStart: cycle2, amount: 850 });
  created.categoryBudgets.push(budget2.id);
  check("BUDGET: histórico de outro ciclo permitido (mesma categoria, cycleStart diferente)", budget1.id !== budget2.id);
  const readBack1 = await getCategoryBudget(budgetCategory, cycle1);
  check("BUDGET: getCategoryBudget lê de volta o valor certo do ciclo 1", compareMoney(money_(readBack1.amount), 800) === 0);

  // ============================================================================
  // CARD CREDIT
  // ============================================================================
  const expenseOnCard = await prisma.expense.create({ data: { amount: 35, description: `[${MARK}] Alimentação no cartão`, category: "Outros", cardId: card.id, source: "manual" } });
  created.expenses.push(expenseOnCard.id);

  await createCardCreditMovement(card.id, { amount: 209.11, kind: "CREDIT_GRANTED" });
  let creditBalance = await getCardCreditBalance(card.id);
  check("CARD CREDIT: grant 209.11", compareMoney(creditBalance, 209.11) === 0, serializeMoney(creditBalance).toString());

  await createCardCreditMovement(card.id, { amount: 35, kind: "CREDIT_APPLIED" });
  creditBalance = await getCardCreditBalance(card.id);
  check("CARD CREDIT: apply 35 → saldo = 174.11", compareMoney(creditBalance, 174.11) === 0, serializeMoney(creditBalance).toString());

  const expenseAfter = await prisma.expense.findUnique({ where: { id: expenseOnCard.id } });
  check("CARD CREDIT: Purchase/Expense original não é alterado (continua 35)", compareMoney(money_(expenseAfter.amount), 35) === 0, serializeMoney(money_(expenseAfter.amount)).toString());

  // ============================================================================
  // PRECISÃO
  // ============================================================================
  check("PRECISÃO: getReserveBalance devolve Decimal (Prisma.Decimal), não number", typeof balance !== "number" && typeof balance.toFixed === "function");
  check("PRECISÃO: getCardCreditBalance devolve Decimal, não number", typeof creditBalance !== "number" && typeof creditBalance.toFixed === "function");
}

// Pequeno helper local — `money()` já é importado indiretamente pelos services,
// mas aqui só precisamos empacotar um valor cru de volta pra Decimal pra comparar.
function money_(v) {
  return v; // Prisma já devolve Decimal; mantido por clareza semântica nas comparações acima.
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
