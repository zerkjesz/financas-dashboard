import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";

function dayInMonthKey(monthKeyStr, day) {
  const [year, month] = monthKeyStr.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

// Intervalo de occurredAt que pertence ao ciclo `cycleMonth` deste cartão.
// Sem closingDay definido: o ciclo é simplesmente o mês calendário.
// Com closingDay definido: ciclo vai do dia seguinte ao fechamento anterior até o fechamento deste mês.
function cycleRange(card, cycleMonth) {
  if (card.closingDay == null) {
    const start = dayInMonthKey(cycleMonth, 1);
    const end = dayInMonthKey(addMonthKey(cycleMonth, 1), 1);
    return { start, end };
  }
  const end = new Date(dayInMonthKey(cycleMonth, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  const prevMonth = addMonthKey(cycleMonth, -1);
  const start = new Date(dayInMonthKey(prevMonth, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function computeClosesAt(card, cycleMonth) {
  if (card.closingDay == null) return dayInMonthKey(addMonthKey(cycleMonth, 1), 1);
  return dayInMonthKey(cycleMonth, card.closingDay);
}

function computeDueAt(card, cycleMonth) {
  return dayInMonthKey(addMonthKey(cycleMonth, 1), card.dueDay);
}

async function computeCycleTotal(card, cycleMonth) {
  const { start, end } = cycleRange(card, cycleMonth);
  const [expenseSum, installmentSum] = await Promise.all([
    prisma.expense.aggregate({
      where: { cardId: card.id, occurredAt: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.installment.aggregate({
      where: { billMonth: cycleMonth, purchase: { cardId: card.id } },
      _sum: { amount: true },
    }),
  ]);
  return (expenseSum._sum.amount || 0) + (installmentSum._sum.amount || 0);
}

export async function getOrCreateBill(cardId, cycleMonth) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  let bill = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  const closesAt = computeClosesAt(card, cycleMonth);
  const dueAt = computeDueAt(card, cycleMonth);

  if (!bill) {
    const totalAmount = await computeCycleTotal(card, cycleMonth);
    const status = closesAt < new Date() ? "closed" : "open";
    bill = await prisma.cardBill.create({
      data: { cardId, cycleMonth, closesAt, dueAt, totalAmount, status },
    });
    return bill;
  }

  if (bill.status === "open") {
    const totalAmount = await computeCycleTotal(card, cycleMonth);
    const shouldClose = closesAt < new Date();
    bill = await prisma.cardBill.update({
      where: { id: bill.id },
      data: { totalAmount, status: shouldClose ? "closed" : "open" },
    });
  }

  return bill;
}

export async function listBillsForCard(cardId, { monthsBack = 2, monthsForward = 12 } = {}) {
  const now = new Date();
  const currentCycle = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const months = [];
  for (let i = -monthsBack; i <= monthsForward; i++) {
    months.push(addMonthKey(currentCycle, i));
  }
  const bills = [];
  for (const month of months) {
    bills.push(await getOrCreateBill(cardId, month));
  }
  return bills.sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
}

export async function payBill(cardBillId, { fromAccountId, amount, description, source, rawMessage }) {
  const bill = await prisma.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.transfer.create({
      data: {
        amount,
        description: description || `Pagamento fatura ${bill.cycleMonth}`,
        fromAccountId,
        toCardId: bill.cardId,
        cardBillId: bill.id,
        kind: "card_bill_payment",
        source: source || "manual",
        rawMessage: rawMessage || null,
      },
    });
    const updated = await tx.cardBill.update({
      where: { id: bill.id },
      data: { status: "paid", paidAt: new Date(), paidAmount: amount },
    });
    return { transfer, bill: updated };
  });
}

// Antecipação: paga uma parte da fatura antes do vencimento sem quitá-la por completo —
// reduz o limite usado do cartão (via lib/cards.js), mas não fecha a CardBill.
export async function anticipateBill(cardId, { amount, description, source, rawMessage }) {
  return prisma.transfer.create({
    data: {
      amount,
      description: description || "Antecipação de fatura",
      toCardId: cardId,
      kind: "installment_anticipation",
      source: source || "manual",
      rawMessage: rawMessage || null,
    },
  });
}
