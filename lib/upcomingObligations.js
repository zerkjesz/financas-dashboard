import { prisma } from "./prisma.js";
import { listBills, ensureUpcomingRecurringBills } from "./bills.js";
import { nextOccurrence } from "./recurringCycles.js";

// Painel "Próximas Obrigações": Bill (pendente/atrasada) + fatura de cartão + próximas receitas
// recorrentes (salário, VA), tudo num único array ordenado por data.
export async function listUpcomingObligations({ withinDays = 45 } = {}) {
  await ensureUpcomingRecurringBills();

  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const items = [];

  const bills = await listBills({ status: ["pending", "overdue"], withinDays });
  for (const bill of bills) {
    items.push({
      name: bill.description,
      amount: -bill.amount,
      date: bill.dueDate,
      status: bill.status === "overdue" ? "atrasada" : "pendente",
      kind: "bill",
    });
  }

  const cards = await prisma.card.findMany();
  for (const card of cards) {
    const cardBills = await prisma.cardBill.findMany({
      where: { cardId: card.id, dueAt: { gte: now, lte: horizon }, status: { in: ["open", "closed", "paid"] } },
    });
    for (const bill of cardBills) {
      items.push({
        name: `Fatura ${card.name}`,
        amount: -bill.totalAmount,
        date: bill.dueAt,
        status: bill.status === "paid" ? "paga" : "pendente",
        kind: "card_bill",
      });
    }
  }

  const incomeRules = await prisma.recurringRule.findMany({ where: { isActive: true, kind: "income" } });
  for (const rule of incomeRules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    items.push({ name: rule.name, amount: rule.amount, date, status: "prevista", kind: "income" });
  }

  items.sort((a, b) => a.date - b.date);
  return items;
}
