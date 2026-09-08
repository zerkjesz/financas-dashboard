import { prisma } from "./prisma.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { buildVaSnapshot } from "./vaPanel.js";
import { buildCashFlowProjection } from "./cashFlowProjection.js";
import { addMonthKey } from "./formatMoney.js";
import { money, subtractMoney, multiplyMoney, divideMoney, sumMoney, isNegative, compareMoney, serializeMoney } from "./money.js";

// `projection30`/`accounts`/`cards` podem vir prontos do dashboard — evita recalcular a
// projeção de caixa (e saldo/limite dentro dela) do zero de novo só pra montar os alertas.
//
// Fase 5.3B, item 20 — `productSnapshot` opcional adiciona UM alerta canônico
// (status APERTADO/CRITICO), sem tocar nos alertas legados existentes (fatura
// a vencer, conta atrasada, VA, gasto acima da média) nem no `goesNegative`
// abaixo — esses continuam usando lib/cashFlowProjection.js (V1). Migrar TODO
// alerts.js pra V2 ampliaria o escopo desta fase (arriscaria os 4 alertas que
// já funcionam corretamente); documentado como KNOWN_LIMITATION, não corrigido
// aqui. Não spam: só 1 alerta novo, e só quando o status realmente é ruim.
export async function buildAlerts({ projection30: projection30In, accounts, cards, productSnapshot } = {}) {
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
    alerts.push({ level: "warning", message: `Sua fatura ${bill.card.name} vence em ${days} dia(s): ${formatMoney(serializeMoney(bill.totalAmount))}.` });
  }
  for (const bill of overdueBills) {
    alerts.push({ level: "danger", message: `Você esqueceu de pagar "${bill.description}" (venceu em ${formatDate(bill.dueDate)}).` });
  }
  if (va?.diasRestantes != null && va.diasRestantes <= 5) {
    alerts.push({ level: "info", message: `Seu Vale Alimentação recarrega em ${va.diasRestantes} dia(s).` });
  }

  const goesNegative = projection.timeline.some((e) => isNegative(e.balanceAfter)) || isNegative(projection.projectedBalance);
  alerts.push(
    goesNegative
      ? { level: "danger", message: "Pela projeção, você não terá saldo suficiente nos próximos 30 dias." }
      : { level: "info", message: "Você tem saldo suficiente para as obrigações dos próximos 30 dias." }
  );

  if (spendingAlert) alerts.push(spendingAlert);

  if (productSnapshot) {
    const { status, freeMoney, safeToSpend } = productSnapshot.liquidity;
    if (status === "APERTADO" || status === "CRITICO") {
      alerts.push({
        level: status === "CRITICO" ? "danger" : "warning",
        message: `Situação financeira: ${status}. Dinheiro livre: ${formatMoney(serializeMoney(freeMoney))} · seguro pra gastar: ${formatMoney(serializeMoney(safeToSpend))}.`,
      });
    }
  }

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
  const currentTotal = money(currentSum._sum.amount);
  // `!= null` explícito, não truthiness — um Decimal(0) é um objeto, sempre truthy em
  // JS, então o antigo `.filter(Boolean)` (pensado pra number) pararia de excluir
  // corretamente "sem dado" depois da migration. Aqui só null (mês sem nenhuma Expense)
  // é excluído — um mês com gasto exatamente R$0,00 (raro, mas possível) conta.
  const pastMonthTotals = pastSums.map((s) => s._sum.amount).filter((v) => v != null).map(money);
  if (pastMonthTotals.length === 0) return null;

  const avgMonthTotal = divideMoney(sumMoney(pastMonthTotals), pastMonthTotals.length);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const expectedByNow = multiplyMoney(divideMoney(avgMonthTotal, daysInMonth), dayOfMonth);

  if (compareMoney(currentTotal, multiplyMoney(expectedByNow, 1.2)) > 0) {
    return { level: "warning", message: `Você já gastou ${formatMoney(serializeMoney(currentTotal))} este mês — acima da média dos últimos meses para essa altura.` };
  }
  return null;
}
