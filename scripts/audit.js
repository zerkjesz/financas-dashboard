import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getOrCreateBill } from "../lib/cardBillCalculator.js";

const prisma = new PrismaClient();
const problems = [];

function check(label, ok, detail) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) problems.push(label);
}

// Recomputo independente do lib/accounts.js, só pra cruzar os dois caminhos.
async function rawAccountBalance(accountId) {
  const anchor = await prisma.balanceAdjustment.findFirst({ where: { accountId }, orderBy: { occurredAt: "desc" } });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = anchor?.newBalance ?? 0;
  const [inc, exp, tOut, tIn] = await Promise.all([
    prisma.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);
  return base + (inc._sum.amount || 0) - (exp._sum.amount || 0) + (tIn._sum.amount || 0) - (tOut._sum.amount || 0);
}

async function auditAccountBalances() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const balance = await rawAccountBalance(account.id);
    check(`Saldo de "${account.name}" é finito e >= -0.01`, Number.isFinite(balance) && balance >= -0.01, `R$ ${balance.toFixed(2)}`);
  }
}

async function auditCardBills() {
  const openBills = await prisma.cardBill.findMany({ where: { status: "open" } });
  for (const bill of openBills) {
    const before = bill.totalAmount;
    const recomputed = await getOrCreateBill(bill.cardId, bill.cycleMonth);
    check(
      `CardBill ${bill.cycleMonth} bate com o recomputo ao vivo`,
      Math.abs(before - recomputed.totalAmount) < 0.01,
      `armazenado R$ ${before.toFixed(2)}, recomputado R$ ${recomputed.totalAmount.toFixed(2)}`
    );
  }
}

async function auditMigrationSums() {
  const legacyRows = await prisma.legacyTransaction.findMany();
  const legacyByType = legacyRows.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] || 0) + r.amount;
    return acc;
  }, {});
  const [incomeSum, expenseSum] = await Promise.all([
    prisma.income.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
  ]);
  check(
    "Soma de Income migrado bate com transaction_legacy",
    Math.abs((legacyByType.income || 0) - (incomeSum._sum.amount || 0)) < 0.01
  );
  check(
    "Soma de Expense migrado bate com transaction_legacy",
    Math.abs((legacyByType.expense || 0) - (expenseSum._sum.amount || 0)) < 0.01
  );
}

async function auditOrphans() {
  const orphanExpenses = await prisma.expense.count({ where: { accountId: null, cardId: null } });
  check("Nenhuma Expense órfã (sem conta nem cartão)", orphanExpenses === 0, `${orphanExpenses} encontrada(s)`);

  const orphanBillRules = await prisma.bill.count({
    where: { recurringRuleId: { not: null }, recurringRule: { is: null } },
  });
  check("Nenhuma Bill com recurringRuleId inválido", orphanBillRules === 0, `${orphanBillRules} encontrada(s)`);

  const inactiveRuleBills = await prisma.bill.findMany({
    where: { status: { in: ["pending", "overdue"] }, recurringRuleId: { not: null }, recurringRule: { isActive: false } },
  });
  check("Nenhuma Bill pendente presa a RecurringRule inativa", inactiveRuleBills.length === 0, `${inactiveRuleBills.length} encontrada(s)`);
}

async function main() {
  console.log("--- Auditoria de consistência ---\n");
  await auditAccountBalances();
  await auditCardBills();
  await auditMigrationSums();
  await auditOrphans();

  console.log(`\n${problems.length === 0 ? "✅ Tudo consistente." : `❌ ${problems.length} divergência(s) encontrada(s).`}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
