import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { addMonthKey } from "./formatMoney.js";
import { computeFreeMoney } from "./freeMoney.js";

export async function buildIndicators() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const accounts = await listAccountsWithBalances();
  // Fonte única (lib/freeMoney.js) — ver AUDITORIA, achado P0-4.
  const caixaLivre = computeFreeMoney(accounts);
  // patrimonioDisponivel é de propósito diferente: soma TUDO (inclui VA) — é
  // "patrimônio total acompanhado", não "dinheiro livre pra gastar".
  const patrimonioDisponivel = accounts.reduce((s, a) => s + a.balance, 0);

  const salaryRule = await prisma.recurringRule.findFirst({ where: { kind: "income", name: { contains: "sal" } } });

  const [pendingBillsSum, openCardBillsSum, futureInstallmentsSum] = await Promise.all([
    prisma.bill.aggregate({ where: { status: { in: ["pending", "overdue"] } }, _sum: { amount: true } }),
    prisma.cardBill.aggregate({ where: { status: { not: "paid" } }, _sum: { totalAmount: true } }),
    prisma.installment.aggregate({ where: { billMonth: { gte: monthKey } }, _sum: { amount: true } }),
  ]);

  const totalContasFuturas = pendingBillsSum._sum.amount || 0;
  const totalFaturas = openCardBillsSum._sum.totalAmount || 0;
  const totalParcelas = futureInstallmentsSum._sum.amount || 0;

  const percentualSalarioComprometido =
    salaryRule?.amount ? Math.round(((totalContasFuturas + totalFaturas) / salaryRule.amount) * 1000) / 10 : null;

  const [fixedSum, monthExpenseSum] = await Promise.all([
    prisma.expense.aggregate({ where: { occurredAt: { gte: monthStart }, isRecurring: true }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { occurredAt: { gte: monthStart } }, _sum: { amount: true } }),
  ]);
  const despesasFixas = fixedSum._sum.amount || 0;
  const despesasVariaveis = (monthExpenseSum._sum.amount || 0) - despesasFixas;

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
      total: (billsSum._sum.amount || 0) + (cardBillsSum._sum.totalAmount || 0),
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
