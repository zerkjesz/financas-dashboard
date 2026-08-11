import { prisma } from "./prisma.js";
import { nextOccurrence } from "./recurringCycles.js";

export async function listUpcomingBills({ withinDays = 45 } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const items = [];

  const rules = await prisma.recurringRule.findMany({ where: { isActive: true, kind: "expense" } });
  for (const rule of rules) {
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const posted = await prisma.expense.findFirst({ where: { recurringRuleId: rule.id, occurredAt: { gte: monthStart } } });
    items.push({ name: rule.name, amount: rule.amount, date, status: posted ? "paga" : "pendente", kind: "recurring" });
  }

  const cards = await prisma.card.findMany();
  for (const card of cards) {
    const bills = await prisma.cardBill.findMany({
      where: { cardId: card.id, dueAt: { gte: now, lte: horizon }, status: { in: ["open", "closed", "paid"] } },
    });
    for (const bill of bills) {
      items.push({
        name: `Fatura ${card.name}`,
        amount: bill.totalAmount,
        date: bill.dueAt,
        status: bill.status === "paid" ? "paga" : "pendente",
        kind: "card_bill",
      });
    }
  }

  items.sort((a, b) => a.date - b.date);
  return items;
}
