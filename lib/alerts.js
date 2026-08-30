import { prisma } from "./prisma.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { buildVaSnapshot } from "./vaPanel.js";
import { buildCashFlowProjection } from "./cashFlowProjection.js";
import { addMonthKey } from "./formatMoney.js";

// `projection30`/`accounts`/`cards` podem vir prontos do dashboard — evita recalcular a
// projeção de caixa (e saldo/limite dentro dela) do zero de novo só pra montar os alertas.
export async function buildAlerts({ projection30: projection30In, accounts, cards } = {}) {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const [dueSoonBills, overdueBills, va, projection, spendingAlert] = await Promise.all([
    prisma.cardBill.findMany({ where: { dueAt: { gte: now, lte: in3Days }, status: { not: "paid" } }, include: { card: true } }),
    prisma.bill.findMany({ where: { status: "overdue" } }),
    buildVaSnapshot(),
    projection30In || buildCashFlowProjection({ horizonDays: 30, accounts, cards }),
    buildSpendingAboveAverageAlert(now),
  ]);

  const alerts = [];
  for (const bill of dueSoonBills) {
    const days = Math.max(0, Math.ceil((bill.dueAt - now) / (24 * 60 * 60 * 1000)));
    alerts.push({ level: "warning", message: `Sua fatura ${bill.card.name} vence em ${days} dia(s): ${formatMoney(bill.totalAmount)}.` });
  }
  for (const bill of overdueBills) {
    alerts.push({ level: "danger", message: `Você esqueceu de pagar "${bill.description}" (venceu em ${formatDate(bill.dueDate)}).` });
  }
  if (va?.diasRestantes != null && va.diasRestantes <= 5) {
    alerts.push({ level: "info", message: `Seu Vale Alimentação recarrega em ${va.diasRestantes} dia(s).` });
  }

  const goesNegative = projection.timeline.some((e) => e.balanceAfter < 0) || projection.projectedBalance < 0;
  alerts.push(
    goesNegative
      ? { level: "danger", message: "Pela projeção, você não terá saldo suficiente nos próximos 30 dias." }
      : { level: "info", message: "Você tem saldo suficiente para as obrigações dos próximos 30 dias." }
  );

  if (spendingAlert) alerts.push(spendingAlert);

  return alerts;
}

async function buildSpendingAboveAverageAlert(now) {
  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const dayOfMonth = now.getUTCDate();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [currentSum, ...pastSums] = await Promise.all([
    prisma.expense.aggregate({ where: { occurredAt: { gte: monthStart } }, _sum: { amount: true } }),
    ...[1, 2, 3].map((i) => {
      const key = addMonthKey(currentMonthKey, -i);
      const [year, month] = key.split("-").map(Number);
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 1));
      return prisma.expense.aggregate({ where: { occurredAt: { gte: start, lt: end } }, _sum: { amount: true } });
    }),
  ]);
  const currentTotal = currentSum._sum.amount || 0;
  const pastMonthTotals = pastSums.map((s) => s._sum.amount).filter(Boolean);
  if (pastMonthTotals.length === 0) return null;

  const avgMonthTotal = pastMonthTotals.reduce((a, b) => a + b, 0) / pastMonthTotals.length;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const expectedByNow = (avgMonthTotal / daysInMonth) * dayOfMonth;

  if (currentTotal > expectedByNow * 1.2) {
    return { level: "warning", message: `Você já gastou ${formatMoney(currentTotal)} este mês — acima da média dos últimos meses para essa altura.` };
  }
  return null;
}
