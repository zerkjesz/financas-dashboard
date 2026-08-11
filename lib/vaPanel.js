import { prisma } from "./prisma.js";
import { getAccountBySlug, computeAccountBalance } from "./accounts.js";
import { nextOccurrence, daysBetween, occurrencesBetween, monthKeyOf } from "./recurringCycles.js";

// Recebido/gasto/saldo precisam usar a MESMA janela que computeAccountBalance (desde a
// última âncora), senão os números não batem entre si — saldo tem que ser sempre
// anchor + recebido - gasto.
export async function buildVaSnapshot() {
  const account = await getAccountBySlug("vale-alimentacao");
  if (!account) return null;

  const rule = await prisma.recurringRule.findFirst({ where: { accountId: account.id, kind: "income", isActive: true } });
  const now = new Date();

  const anchor = await prisma.balanceAdjustment.findFirst({
    where: { accountId: account.id },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);

  const [incomeSum, expenseSum] = await Promise.all([
    prisma.income.aggregate({ where: { accountId: account.id, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId: account.id, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);

  let virtualRecharge = 0;
  let nextRecharge = null;
  let diasRestantes = null;

  if (rule?.amount != null) {
    nextRecharge = nextOccurrence(rule.dayOfMonth, now);
    diasRestantes = daysBetween(now, nextRecharge);
    for (const occurrence of occurrencesBetween(rule.dayOfMonth, since, now)) {
      const month = monthKeyOf(occurrence);
      const posted = await prisma.income.findFirst({
        where: { recurringRuleId: rule.id, occurredAt: { gte: new Date(`${month}-01T00:00:00.000Z`) } },
      });
      if (!posted) virtualRecharge += rule.amount;
    }
  }

  const recebido = (incomeSum._sum.amount || 0) + virtualRecharge;
  const gasto = expenseSum._sum.amount || 0;
  const balance = (anchor?.newBalance ?? 0) + recebido - gasto;
  const metaDiaria = diasRestantes && diasRestantes > 0 ? balance / diasRestantes : balance;

  return { account, balance, recebido, gasto, diasRestantes, nextRecharge, metaDiaria };
}
