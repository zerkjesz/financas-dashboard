import { prisma } from "./prisma.js";

// Saldo de uma conta = última âncora declarada (BalanceAdjustment) + lançamentos reais
// desde então (Income, Expense, Transfer). NÃO inclui receita recorrente esperada que
// ainda não foi lançada como Income de verdade, mesmo que a data já tenha passado —
// saldo real só reflete movimento real e persistido. Isso ficou explícito na Fase 1.1
// (removido um "crédito virtual" que somava recorrência vencida-mas-não-lançada aqui).
// Receita esperada continua disponível pra projeção/timeline/alertas — ver
// lib/cashFlowProjection.js, que projeta a PRÓXIMA ocorrência futura de cada
// RecurringRule independentemente do saldo — nunca pra saldo atual.
export async function computeAccountBalance(accountId) {
  const anchor = await prisma.balanceAdjustment.findFirst({
    where: { accountId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = anchor?.newBalance ?? 0;

  const [incomeSum, expenseSum, transfersOut, transfersIn] = await Promise.all([
    prisma.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);

  return (
    base +
    (incomeSum._sum.amount || 0) -
    (expenseSum._sum.amount || 0) +
    (transfersIn._sum.amount || 0) -
    (transfersOut._sum.amount || 0)
  );
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
