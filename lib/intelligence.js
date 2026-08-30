import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { formatMoney } from "./formatMoney.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";
import { buildCashFlowProjection } from "./cashFlowProjection.js";

// `accounts`/`cards`/`projection30` podem vir prontos do dashboard (que já calculou tudo
// isso) — evita recalcular saldo/limite/projeção do zero de novo pra montar o resumo.
export async function buildFinancialSummary({ accounts: accountsIn, cards: cardsIn, projection30: projection30In } = {}) {
  const [accounts, cards, rules] = await Promise.all([
    accountsIn || listAccountsWithBalances(),
    cardsIn || listCardsWithLimits(),
    prisma.recurringRule.findMany({ where: { isActive: true } }),
  ]);

  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const caixaLivre = accounts
    .filter((a) => a.type === "checking" || a.type === "cash")
    .reduce((sum, a) => sum + a.balance, 0);

  const card = cards[0] || null;
  const salaryRule = rules.find((r) => r.kind === "income" && /sal[aá]rio/i.test(r.name));
  const nextSalaryDate = salaryRule ? nextOccurrence(salaryRule.dayOfMonth, now) : null;
  const daysToSalary = nextSalaryDate ? daysBetween(now, nextSalaryDate) : null;

  const vaRule = rules.find((r) => r.kind === "income" && /alimenta/i.test(r.name));
  const daysToVa = vaRule ? daysBetween(now, nextOccurrence(vaRule.dayOfMonth, now)) : null;

  // Tudo isso é independente entre si — dispara junto em vez de esperar um de cada vez.
  const [nextBill, antecipadoSum, obligationsSums, pendingBillsCount, monthExpenses] = await Promise.all([
    card
      ? prisma.cardBill.findFirst({ where: { cardId: card.id, status: { in: ["open", "closed"] }, dueAt: { gte: now } }, orderBy: { dueAt: "asc" } })
      : null,
    card
      ? prisma.transfer.aggregate({ where: { toCardId: card.id, kind: "installment_anticipation", occurredAt: { gte: currentMonthStart } }, _sum: { amount: true } })
      : null,
    salaryRule?.amount && nextSalaryDate
      ? Promise.all([
          prisma.bill.aggregate({ where: { status: { in: ["pending", "overdue"] }, dueDate: { lte: nextSalaryDate } }, _sum: { amount: true } }),
          prisma.cardBill.aggregate({ where: { status: { not: "paid" }, dueAt: { lte: nextSalaryDate } }, _sum: { totalAmount: true } }),
        ])
      : null,
    prisma.bill.count({ where: { status: { in: ["pending", "overdue"] } } }),
    prisma.expense.groupBy({ by: ["category"], where: { occurredAt: { gte: currentMonthStart } }, _sum: { amount: true } }),
  ]);

  const antecipado = antecipadoSum?._sum.amount || 0;
  const restanteFatura = nextBill ? Math.max(0, nextBill.totalAmount - antecipado) : null;

  let coversObligations = null;
  if (obligationsSums) {
    const [pendingBillsSum, cardBillsSum] = obligationsSums;
    const obligations = (pendingBillsSum._sum.amount || 0) + (cardBillsSum._sum.totalAmount || 0);
    coversObligations = { covers: salaryRule.amount >= obligations, obligations, salaryAmount: salaryRule.amount };
  }

  const topCategory = [...monthExpenses].sort((a, b) => (b._sum.amount || 0) - (a._sum.amount || 0))[0];
  const monthExpenseTotal = monthExpenses.reduce((s, c) => s + (c._sum.amount || 0), 0);
  const percentSalarySpent = salaryRule?.amount ? Math.round((monthExpenseTotal / salaryRule.amount) * 1000) / 10 : null;

  const projection30 = projection30In || (await buildCashFlowProjection({ horizonDays: 30, accounts, cards }));

  const lines = [];
  lines.push(`Você possui ${formatMoney(caixaLivre)} livres.`);
  if (nextBill) {
    lines.push(`Sua próxima fatura é de ${formatMoney(nextBill.totalAmount)}.`);
    if (antecipado > 0) {
      lines.push(`Você já antecipou ${formatMoney(antecipado)}. Restará pagar ${formatMoney(restanteFatura)}.`);
    }
  }
  if (daysToSalary != null && coversObligations) {
    lines.push(
      coversObligations.covers
        ? "Seu próximo salário cobre todas as obrigações até lá."
        : `Seu próximo salário (${formatMoney(coversObligations.salaryAmount)}) NÃO cobre as obrigações até lá (${formatMoney(coversObligations.obligations)}).`
    );
  }
  if (daysToVa != null) {
    lines.push(daysToVa <= 0 ? "Seu Vale Alimentação recarrega hoje." : `Restam ${daysToVa} dia(s) para o Vale Alimentação.`);
  }
  lines.push(`Você possui ${pendingBillsCount} conta(s) pendente(s).`);
  if (topCategory) {
    lines.push(`Seu maior gasto do mês foi ${topCategory.category} (${formatMoney(topCategory._sum.amount || 0)}).`);
  }
  if (percentSalarySpent != null) {
    lines.push(`Você já gastou ${percentSalarySpent}% do salário este mês.`);
  }
  lines.push(
    projection30.projectedBalance >= 0
      ? `Seu caixa ficará positivo em aproximadamente ${formatMoney(projection30.projectedBalance)} (30 dias).`
      : `Seu caixa ficará negativo em aproximadamente ${formatMoney(Math.abs(projection30.projectedBalance))} (30 dias).`
  );

  return {
    caixaAtual: caixaLivre,
    caixaLivre,
    nextBill,
    antecipado,
    restanteFatura,
    daysToSalary,
    daysToVa,
    coversObligations,
    pendingBillsCount,
    topCategory: topCategory ? { category: topCategory.category, amount: topCategory._sum.amount || 0 } : null,
    percentSalarySpent,
    projectedBalance30: projection30.projectedBalance,
    summaryText: lines.join(" "),
    summaryLines: lines,
  };
}
