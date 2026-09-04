import { prisma } from "./prisma.js";
import { listBills, ensureUpcomingRecurringBills } from "./bills.js";
import { nextOccurrence } from "./recurringCycles.js";

// Painel "Próximas Obrigações": Bill (pendente/atrasada) + fatura de cartão + próximas receitas
// recorrentes (salário, VA), tudo num único array ordenado por data.
export async function listUpcomingObligations({ withinDays = 45, cards: cardsIn } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const [, bills, cards, incomeRules] = await Promise.all([
    ensureUpcomingRecurringBills(),
    listBills({ status: ["pending", "overdue"], withinDays }),
    cardsIn || prisma.card.findMany(),
    prisma.recurringRule.findMany({ where: { isActive: true, kind: "income" } }),
  ]);

  const cardBillsByCard = await Promise.all(
    cards.map((card) =>
      prisma.cardBill.findMany({ where: { cardId: card.id, dueAt: { gte: now, lte: horizon }, status: { in: ["open", "closed", "partially_paid", "paid"] } } })
    )
  );

  const items = [];
  for (const bill of bills) {
    items.push({
      name: bill.description,
      amount: -bill.amount,
      date: bill.dueDate,
      status: bill.status === "overdue" ? "atrasada" : "pendente",
      kind: "bill",
    });
  }

  cards.forEach((card, i) => {
    for (const bill of cardBillsByCard[i]) {
      const remaining = Math.max(0, bill.totalAmount - (bill.paidAmount || 0));
      const status = bill.status === "paid" ? "paga" : bill.status === "partially_paid" ? "parcial" : "pendente";
      items.push({
        name: `Fatura ${card.name}`,
        amount: bill.status === "paid" ? 0 : -remaining,
        date: bill.dueAt,
        status,
        kind: "card_bill",
      });
    }
  });

  for (const rule of incomeRules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    items.push({ name: rule.name, amount: rule.amount, date, status: "prevista", kind: "income" });
  }

  items.sort((a, b) => a.date - b.date);
  return items;
}
