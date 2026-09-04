import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getOrCreateBill } from "../lib/cardBillCalculator.js";
import { computeAccountBalance } from "../lib/accounts.js";

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

// Saldo real (lib/accounts.js) precisa bater exatamente com o recompute independente
// (rawAccountBalance, acima) — os dois usam a MESMA fórmula (âncora + movimento real).
// Se algum dia alguém reintroduzir receita recorrente virtual na fórmula de saldo real
// (removida na Fase 1.1), essa checagem diverge e pega o regresso.
async function auditNoVirtualCreditInBalance() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const [real, raw] = await Promise.all([computeAccountBalance(account.id), rawAccountBalance(account.id)]);
    check(
      `Saldo real de "${account.name}" não inclui receita recorrente virtual`,
      Math.abs(real - raw) < 0.01,
      `computeAccountBalance=R$ ${real.toFixed(2)}, recompute independente=R$ ${raw.toFixed(2)}`
    );
  }
}

async function auditCardBills() {
  const openBills = await prisma.cardBill.findMany({ where: { status: { in: ["open", "partially_paid"] } } });
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

// Status derivado tem que bater com paidAmount vs totalAmount — pega qualquer fatura
// que ficou "paid" com pagamento parcial (bug corrigido na Fase 1, checa se sobrou
// dado antigo pra reconciliar) ou "partially_paid"/"open"/"closed" com paidAmount que
// já devia ter fechado como "paid".
async function auditCardBillStatus() {
  const bills = await prisma.cardBill.findMany();
  for (const bill of bills) {
    const paid = bill.paidAmount || 0;
    const expectedStatus =
      paid >= bill.totalAmount - 0.01 && paid > 0
        ? "paid"
        : paid > 0
          ? "partially_paid"
          : bill.status === "open" || bill.status === "closed"
            ? bill.status
            : null; // paidAmount 0 mas status "paid"/"partially_paid" também é inconsistente
    check(
      `CardBill ${bill.cardId}/${bill.cycleMonth} status bate com paidAmount`,
      expectedStatus === null ? bill.status !== "paid" && bill.status !== "partially_paid" : bill.status === expectedStatus,
      `status=${bill.status}, paidAmount=${paid.toFixed(2)}, totalAmount=${bill.totalAmount.toFixed(2)}`
    );
  }
}

// Antecipação sem fromAccountId é o bug P0-1 da auditoria (dinheiro contado duas
// vezes) — depois da Fase 1, toda antecipação NOVA sempre tem fromAccountId; esta
// checagem existe pra pegar histórico ainda não reconciliado (Fase 4).
async function auditAnticipations() {
  const orphanAnticipations = await prisma.transfer.count({
    where: { kind: "installment_anticipation", fromAccountId: null },
  });
  check(
    "Nenhuma antecipação de fatura sem conta de origem (fromAccountId)",
    orphanAnticipations === 0,
    `${orphanAnticipations} encontrada(s) — reconciliação histórica pendente (Fase 4 da auditoria)`
  );
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
  await auditNoVirtualCreditInBalance();
  await auditCardBills();
  await auditCardBillStatus();
  await auditAnticipations();
  await auditMigrationSums();
  await auditOrphans();

  console.log(`\n${problems.length === 0 ? "✅ Tudo consistente." : `❌ ${problems.length} divergência(s) encontrada(s).`}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
