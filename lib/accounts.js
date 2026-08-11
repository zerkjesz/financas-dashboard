import { prisma } from "./prisma.js";
import { occurrencesBetween, monthKeyOf } from "./recurringCycles.js";

// Saldo de uma conta = última âncora declarada (BalanceAdjustment) + lançamentos reais desde então.
// Recargas recorrentes (ex: VA dia 24) que já passaram mas ainda não foram lançadas como Income
// real entram como crédito "virtual" — soma no saldo sem criar um registro duplicado quando o
// usuário eventualmente lançar a recarga de verdade (ela é detectada pelo recurringRuleId do mês).
export async function computeAccountBalance(accountId) {
  const anchor = await prisma.balanceAdjustment.findFirst({
    where: { accountId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = anchor?.newBalance ?? 0;

  const [incomeSum, expenseSum, transfersOut, transfersIn, virtualRecurringCredit] = await Promise.all([
    prisma.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    computeVirtualRecurringCredit(accountId, since),
  ]);

  return (
    base +
    (incomeSum._sum.amount || 0) -
    (expenseSum._sum.amount || 0) +
    (transfersIn._sum.amount || 0) -
    (transfersOut._sum.amount || 0) +
    virtualRecurringCredit
  );
}

async function computeVirtualRecurringCredit(accountId, since) {
  const rules = await prisma.recurringRule.findMany({
    where: { accountId, kind: "income", isActive: true },
  });
  if (rules.length === 0) return 0;

  const now = new Date();
  let total = 0;
  for (const rule of rules) {
    if (rule.amount == null) continue;
    const occurrences = occurrencesBetween(rule.dayOfMonth, since, now);
    for (const occurrence of occurrences) {
      const month = monthKeyOf(occurrence);
      const posted = await prisma.income.findFirst({
        where: {
          recurringRuleId: rule.id,
          occurredAt: { gte: new Date(`${month}-01T00:00:00.000Z`) },
        },
      });
      if (!posted) total += rule.amount;
    }
  }
  return total;
}

export async function listAccountsWithBalances() {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      balance: await computeAccountBalance(account.id),
    }))
  );
}

export async function getAccountBySlug(slug) {
  return prisma.account.findUnique({ where: { slug } });
}
