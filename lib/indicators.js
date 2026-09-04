import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { addMonthKey } from "./formatMoney.js";
import { computeUnrestrictedCash } from "./unrestrictedCash.js";
import { money, addMoney, subtractMoney, divideMoney, sumMoney } from "./money.js";

// Decimal-first (Fase 3.1): todo campo monetário do retorno é Decimal — serializeMoney()
// só na borda da API (app/api/indicators/route.js).
export async function buildIndicators() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const accounts = await listAccountsWithBalances();
  // `caixaLivre` aqui é unrestrictedCash (lib/unrestrictedCash.js), não o freeMoney
  // final do Norte v2 (esse nome fica reservado — ver Fase 3). Ver AUDITORIA, achado P0-4.
  const caixaLivre = computeUnrestrictedCash(accounts);
  // patrimonioDisponivel é totalBalances: soma TUDO (inclui VA) — é "patrimônio total
  // acompanhado", conceito diferente de unrestrictedCash/freeMoney.
  const patrimonioDisponivel = sumMoney(accounts.map((a) => a.balance));

  const salaryRule = await prisma.recurringRule.findFirst({ where: { kind: "income", name: { contains: "sal" } } });

  const [pendingBillsSum, openCardBillsSum, futureInstallmentsSum] = await Promise.all([
    prisma.bill.aggregate({ where: { status: { in: ["pending", "overdue"] } }, _sum: { amount: true } }),
    prisma.cardBill.aggregate({ where: { status: { not: "paid" } }, _sum: { totalAmount: true } }),
    prisma.installment.aggregate({ where: { billMonth: { gte: monthKey } }, _sum: { amount: true } }),
  ]);

  const totalContasFuturas = money(pendingBillsSum._sum.amount);
  const totalFaturas = money(openCardBillsSum._sum.totalAmount);
  const totalParcelas = money(futureInstallmentsSum._sum.amount);

  const percentualSalarioComprometido = salaryRule?.amount
    ? Math.round(divideMoney(addMoney(totalContasFuturas, totalFaturas), salaryRule.amount).toNumber() * 1000) / 10
    : null;

  const [fixedSum, monthExpenseSum] = await Promise.all([
    prisma.expense.aggregate({ where: { occurredAt: { gte: monthStart }, isRecurring: true }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { occurredAt: { gte: monthStart } }, _sum: { amount: true } }),
  ]);
  const despesasFixas = money(fixedSum._sum.amount);
  const despesasVariaveis = subtractMoney(money(monthExpenseSum._sum.amount), despesasFixas);

  const comprometimentoProximosMeses = [];
  for (let i = 0; i < 3; i++) {
    const key = addMonthKey(monthKey, i);
    const [year, month] = key.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    const [billsSum, cardBillsSum] = await Promise.all([
      prisma.bill.aggregate({
        where: { status: { in: ["pending", "overdue", "paid"] }, dueDate: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
      prisma.cardBill.aggregate({ where: { dueAt: { gte: start, lt: end } }, _sum: { totalAmount: true } }),
    ]);
    comprometimentoProximosMeses.push({
      month: key,
      total: addMoney(money(billsSum._sum.amount), money(cardBillsSum._sum.totalAmount)),
    });
  }

  return {
    percentualSalarioComprometido,
    totalContasFuturas,
    totalParcelas,
    totalFaturas,
    despesasFixas,
    despesasVariaveis,
    patrimonioDisponivel,
    caixaLivre,
    comprometimentoProximosMeses,
  };
}
