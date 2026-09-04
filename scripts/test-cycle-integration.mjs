// Fase 4.0, item 17 — testes de integração contra o branch dev: card cycle real
// (via getOrCreateBill com cartão SINTÉTICO com closingDay configurado —
// NUNCA o cartão real), resolução de fatura, funding por Account, e confirmação
// de que funding por Reserve (Fase 3.3) continua funcionando lado a lado.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney } from "../lib/money.js";
import { getOrCreateBill, resolveCurrentBillSafely } from "../lib/cardBillCalculator.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";
import { createExternalInstallmentPlan, computePlanProgress } from "../lib/externalInstallments.js";
import { createCommitment, fundCommitmentFromAccount, fundCommitmentFromReserve } from "../lib/commitments.js";
import { createReserve, createReserveMovement } from "../lib/reserves.js";

const MARK = "TESTE_FASE40";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const created = { accounts: [], cards: [], externalInstallmentPlans: [], commitments: [], reserves: [], expenses: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.commitments) await prisma.confirmedCommitment.delete({ where: { id: c } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallment.deleteMany({ where: { planId: p } }).catch(() => {});
  for (const p of created.externalInstallmentPlans) await prisma.externalInstallmentPlan.delete({ where: { id: p } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserveMovement.deleteMany({ where: { reserveId: r } }).catch(() => {});
  for (const r of created.reserves) await prisma.reserve.delete({ where: { id: r } }).catch(() => {});
  for (const c of created.cards) await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const e of created.expenses) await prisma.expense.delete({ where: { id: e } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase40" } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase40" } } }),
    prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } }),
    prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }),
    prisma.reserve.count({ where: { name: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de integração: card cycle + funding (branch dev) — Fase 4.0, item 17 ---\n");

  const account = await prisma.account.create({ data: { slug: "teste-fase40-conta", name: `[${MARK}] Conta`, type: "checking" } });
  created.accounts.push(account.id);

  // Cartão SINTÉTICO com closingDay configurado — NUNCA o cartão real (que
  // continua com closingDay null nesta fase, por instrução explícita).
  const card = await prisma.card.create({ data: { slug: "teste-fase40-cartao", name: `[${MARK}] Cartão`, totalLimit: 5000, closingDay: 4, dueDay: 11 } });
  created.cards.push(card.id);

  // ---- Card cycle real via getOrCreateBill ----
  const now = new Date();
  const cycleReference = getCardCycleForDate(card, now);
  const bill = await getOrCreateBill(card.id, cycleReference);
  check("getOrCreateBill materializa a fatura no cycleReference correto (closingDay-aware)", bill.cycleMonth === cycleReference, bill.cycleMonth);
  // dueAt deve estar no mesmo mês do cycleReference (dueDay=11 >= closingDay=4).
  const dueMonth = `${bill.dueAt.getUTCFullYear()}-${String(bill.dueAt.getUTCMonth() + 1).padStart(2, "0")}`;
  check("dueAt cai no MESMO mês do cycleReference (fix do bug original, dueDay >= closingDay)", dueMonth === cycleReference, `dueAt=${bill.dueAt.toISOString()}, cycleReference=${cycleReference}`);

  // ---- CardBill resolution (resolveCurrentBillSafely, arquitetura definitiva) ----
  const resolved = await resolveCurrentBillSafely(card.id);
  check("resolveCurrentBillSafely resolve deterministicamente a fatura do ciclo atual", resolved.id === bill.id, resolved.id);

  // ---- External plan derivado ----
  const plan = await createExternalInstallmentPlan({
    description: `[${MARK}] TV`,
    creditor: "Loja Y",
    installmentValue: 200,
    installmentCount: 3,
    firstDueDate: new Date("2026-10-01T00:00:00.000Z"),
  });
  created.externalInstallmentPlans.push(plan.id);
  const progress = computePlanProgress(plan.installments);
  check("plano externo derivado corretamente (0/3 pago, não completo)", progress.paidCount === 0 && progress.totalCount === 3 && !progress.isFullyPaid, JSON.stringify(progress));

  // ---- Funding por Account (novo, Fase 4.0 item 15) ----
  const commitmentByAccount = await createCommitment({ description: `[${MARK}] Compromisso via conta`, amount: 500, dueDate: new Date(Date.now() + 10 * 86400000) });
  created.commitments.push(commitmentByAccount.id);
  const fundedByAccount = await fundCommitmentFromAccount(commitmentByAccount.id, account.id);
  check("fundCommitmentFromAccount: status vira FUNDED", fundedByAccount.status === "FUNDED", fundedByAccount.status);
  check("fundCommitmentFromAccount: fundingAccountId setado", fundedByAccount.fundingAccountId === account.id);
  check("fundCommitmentFromAccount: fundedAt setado", fundedByAccount.fundedAt != null);

  const balanceAfterFunding = await (await import("../lib/accounts.js")).computeAccountBalance(account.id);
  check("fundCommitmentFromAccount: NÃO altera Account.balance (earmark, não movimento real)", compareMoney(balanceAfterFunding, 0) === 0, balanceAfterFunding.toString());
  const expenseCount = await prisma.expense.count({ where: { description: { contains: MARK } } });
  check("fundCommitmentFromAccount: NÃO cria Expense", expenseCount === 0, String(expenseCount));
  const reserveMovementCount = await prisma.reserveMovement.count({ where: { note: { contains: MARK } } });
  check("fundCommitmentFromAccount: NÃO cria ReserveMovement", reserveMovementCount === 0, String(reserveMovementCount));

  // ---- Funding por Reserve continua funcionando (regressão da Fase 3.3) ----
  const reserve = await createReserve({ accountId: account.id, name: `[${MARK}] Reserva` });
  created.reserves.push(reserve.id);
  await createReserveMovement(reserve.id, { amount: 1000, kind: "ALLOCATE" });
  const commitmentByReserve = await createCommitment({ description: `[${MARK}] Compromisso via reserva`, amount: 300, dueDate: new Date(Date.now() + 10 * 86400000) });
  created.commitments.push(commitmentByReserve.id);
  const { commitment: fundedByReserve, reserveMovement } = await fundCommitmentFromReserve(commitmentByReserve.id, reserve.id);
  check("fundCommitmentFromReserve continua funcionando (Fase 3.3 intacta)", fundedByReserve.status === "FUNDED" && reserveMovement.kind === "RELEASE");
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
