import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { formatMoney } from "./formatMoney.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";
import { buildCashFlowProjection } from "./cashFlowProjection.js";
import { computeUnrestrictedCash } from "./unrestrictedCash.js";
import { money, addMoney, subtractMoney, divideMoney, sumMoney, maxMoney, compareMoney, isNegative, isPositive, serializeMoney, ZERO } from "./money.js";

// `accounts`/`cards`/`projection30` podem vir prontos do dashboard (que já calculou tudo
// isso) — evita recalcular saldo/limite/projeção do zero de novo pra montar o resumo.
//
// Decimal-first (Fase 3.1): todo campo monetário do objeto devolvido (caixaAtual,
// caixaLivre, antecipado, restanteFatura, topCategory.amount, projectedBalance30, e os
// campos monetários dentro de `nextBill`/`coversObligations`) é Decimal — a rota de API
// que consome isto (app/api/dashboard/route.js) serializa na borda.
export async function buildFinancialSummary({ accounts: accountsIn, cards: cardsIn, projection30: projection30In } = {}) {
  const [accounts, cards, rules] = await Promise.all([
    accountsIn || listAccountsWithBalances(),
    cardsIn || listCardsWithLimits(),
    prisma.recurringRule.findMany({ where: { isActive: true } }),
  ]);

  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // `caixaLivre` aqui é unrestrictedCash (checking+cash, exclui VA) — lib/unrestrictedCash.js.
  // Ainda NÃO é o freeMoney final do Norte v2 (que também vai descontar reservas/dívidas/
  // compromissos quando esses conceitos existirem — Fase 3). Antes essa conta era refeita
  // aqui, em indicators.js e (de forma diferente, incluindo VA por engano) em
  // cashFlowProjection.js. Ver AUDITORIA, achado P0-4.
  const caixaLivre = computeUnrestrictedCash(accounts);

  const salaryRule = rules.find((r) => r.kind === "income" && /sal[aá]rio/i.test(r.name));
  const nextSalaryDate = salaryRule ? nextOccurrence(salaryRule.dayOfMonth, now) : null;
  const daysToSalary = nextSalaryDate ? daysBetween(now, nextSalaryDate) : null;

  const vaRule = rules.find((r) => r.kind === "income" && /alimenta/i.test(r.name));
  const daysToVa = vaRule ? daysBetween(now, nextOccurrence(vaRule.dayOfMonth, now)) : null;

  // Tudo isso é independente entre si — dispara junto em vez de esperar um de cada vez.
  // Não assume mais um único cartão (achado P1-1): olha a próxima fatura entre TODOS os
  // cartões, não só o primeiro criado.
  const cardIds = cards.map((c) => c.id);
  const [nextBill, obligationsSums, pendingBillsCount, monthExpenses] = await Promise.all([
    cardIds.length > 0
      ? prisma.cardBill.findFirst({
          where: { cardId: { in: cardIds }, status: { in: ["open", "closed", "partially_paid"] }, dueAt: { gte: now } },
          orderBy: { dueAt: "asc" },
        })
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

  // Antecipado precisa ser o antecipado DESSA fatura específica (via cardBillId), não
  // "tudo que foi antecipado no mês calendário atual" — antes uma antecipação feita em
  // agosto pra fatura de setembro sumia do cálculo assim que virava setembro
  // (achado P1-2). anticipateBill agora sempre vincula cardBillId (achado P0-1).
  const antecipadoSum = nextBill
    ? await prisma.transfer.aggregate({
        where: { cardBillId: nextBill.id, kind: "installment_anticipation" },
        _sum: { amount: true },
      })
    : null;
  const antecipado = money(antecipadoSum?._sum.amount);
  const restanteFatura = nextBill
    ? maxMoney(ZERO, subtractMoney(subtractMoney(nextBill.totalAmount, money(nextBill.paidAmount)), antecipado))
    : null;

  let coversObligations = null;
  if (obligationsSums) {
    const [pendingBillsSum, cardBillsSum] = obligationsSums;
    const obligations = addMoney(money(pendingBillsSum._sum.amount), money(cardBillsSum._sum.totalAmount));
    coversObligations = { covers: compareMoney(salaryRule.amount, obligations) >= 0, obligations, salaryAmount: salaryRule.amount };
  }

  const topCategory = [...monthExpenses].sort((a, b) => compareMoney(b._sum.amount, a._sum.amount))[0];
  const monthExpenseTotal = sumMoney(monthExpenses.map((c) => c._sum.amount));
  const percentSalarySpent = salaryRule?.amount
    ? Math.round(divideMoney(monthExpenseTotal, salaryRule.amount).toNumber() * 1000) / 10
    : null;

  const projection30 = projection30In || (await buildCashFlowProjection({ horizonDays: 30, accounts, cards }));

  const lines = [];
  lines.push(`Você possui ${formatMoney(serializeMoney(caixaLivre))} livres.`);
  if (nextBill) {
    lines.push(`Sua próxima fatura é de ${formatMoney(serializeMoney(nextBill.totalAmount))}.`);
    if (isPositive(antecipado)) {
      lines.push(`Você já antecipou ${formatMoney(serializeMoney(antecipado))}. Restará pagar ${formatMoney(serializeMoney(restanteFatura))}.`);
    }
  }
  if (daysToSalary != null && coversObligations) {
    lines.push(
      coversObligations.covers
        ? "Seu próximo salário cobre todas as obrigações até lá."
        : `Seu próximo salário (${formatMoney(serializeMoney(coversObligations.salaryAmount))}) NÃO cobre as obrigações até lá (${formatMoney(serializeMoney(coversObligations.obligations))}).`
    );
  }
  if (daysToVa != null) {
    lines.push(daysToVa <= 0 ? "Seu Vale Alimentação recarrega hoje." : `Restam ${daysToVa} dia(s) para o Vale Alimentação.`);
  }
  lines.push(`Você possui ${pendingBillsCount} conta(s) pendente(s).`);
  if (topCategory) {
    lines.push(`Seu maior gasto do mês foi ${topCategory.category} (${formatMoney(serializeMoney(topCategory._sum.amount))}).`);
  }
  if (percentSalarySpent != null) {
    lines.push(`Você já gastou ${percentSalarySpent}% do salário este mês.`);
  }
  lines.push(
    !isNegative(projection30.projectedBalance)
      ? `Seu caixa ficará positivo em aproximadamente ${formatMoney(serializeMoney(projection30.projectedBalance))} (30 dias).`
      : `Seu caixa ficará negativo em aproximadamente ${formatMoney(serializeMoney(projection30.projectedBalance.abs()))} (30 dias).`
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
    topCategory: topCategory ? { category: topCategory.category, amount: money(topCategory._sum.amount) } : null,
    percentSalarySpent,
    projectedBalance30: projection30.projectedBalance,
    summaryText: lines.join(" "),
    summaryLines: lines,
  };
}
