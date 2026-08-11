import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { formatMoney } from "./formatMoney.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";

export async function buildFinancialSummary() {
  const [accounts, cards, rules] = await Promise.all([
    listAccountsWithBalances(),
    listCardsWithLimits(),
    prisma.recurringRule.findMany({ where: { isActive: true } }),
  ]);

  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const caixaAtual = accounts
    .filter((a) => a.type === "checking" || a.type === "cash")
    .reduce((sum, a) => sum + a.balance, 0);

  const card = cards[0] || null;
  const nextBill = card
    ? await prisma.cardBill.findFirst({
        where: { cardId: card.id, status: { in: ["open", "closed"] }, dueAt: { gte: now } },
        orderBy: { dueAt: "asc" },
      })
    : null;

  const salaryRule = rules.find((r) => r.kind === "income" && /sal[aá]rio/i.test(r.name));
  const daysToSalary = salaryRule ? daysBetween(now, nextOccurrence(salaryRule.dayOfMonth, now)) : null;

  const expenseRules = rules.filter((r) => r.kind === "expense");
  const unpaidThisCycle = [];
  for (const rule of expenseRules) {
    const posted = await prisma.expense.findFirst({
      where: { recurringRuleId: rule.id, occurredAt: { gte: currentMonthStart } },
    });
    if (!posted) unpaidThisCycle.push(rule.name);
  }

  const monthExpenses = await prisma.expense.groupBy({
    by: ["category"],
    where: { occurredAt: { gte: currentMonthStart } },
    _sum: { amount: true },
  });
  const topCategory = monthExpenses.sort((a, b) => (b._sum.amount || 0) - (a._sum.amount || 0))[0];

  const lines = [];
  lines.push(`Você possui ${formatMoney(caixaAtual)} em caixa.`);
  if (nextBill) {
    lines.push(`Sua próxima fatura (${card.name}) será de ${formatMoney(nextBill.totalAmount)}, vencendo em ${nextBill.dueAt.toLocaleDateString("pt-BR")}.`);
  }
  if (card) {
    lines.push(`Seu limite disponível no cartão ${card.name} é ${formatMoney(card.availableLimit)}.`);
  }
  if (daysToSalary != null) {
    lines.push(daysToSalary <= 0 ? "Seu salário cai hoje." : `Restam ${daysToSalary} dia(s) para o próximo salário.`);
  }
  if (unpaidThisCycle.length > 0) {
    lines.push(`Ainda faltam pagar este mês: ${unpaidThisCycle.join(", ")}.`);
  }
  if (topCategory) {
    lines.push(`Maior categoria de gasto do mês: ${topCategory.category} (${formatMoney(topCategory._sum.amount || 0)}).`);
  }

  return {
    caixaAtual,
    nextBill,
    daysToSalary,
    unpaidThisCycle,
    topCategory: topCategory ? { category: topCategory.category, amount: topCategory._sum.amount || 0 } : null,
    summaryText: lines.join(" "),
    summaryLines: lines,
  };
}
