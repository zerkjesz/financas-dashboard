import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";

const HORIZON_DAYS = 60;

// Linha do tempo: Hoje -> próximo salário -> próximo VA -> contas futuras -> faturas -> saldo previsto.
export async function buildCashFlowProjection() {
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const [accounts, cards, rules] = await Promise.all([
    listAccountsWithBalances(),
    listCardsWithLimits(),
    prisma.recurringRule.findMany({ where: { isActive: true } }),
  ]);

  const startingBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

  const events = [];

  for (const rule of rules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    events.push({
      date,
      label: rule.name,
      amount: rule.kind === "income" ? rule.amount : -rule.amount,
      kind: rule.kind === "income" ? "recurring_income" : "recurring_expense",
    });
  }

  for (const card of cards) {
    const bills = await prisma.cardBill.findMany({
      where: { cardId: card.id, status: { in: ["open", "closed"] }, dueAt: { gte: now, lte: horizon } },
      orderBy: { dueAt: "asc" },
    });
    for (const bill of bills) {
      events.push({
        date: bill.dueAt,
        label: `Fatura ${card.name} (${bill.cycleMonth})`,
        amount: -bill.totalAmount,
        kind: "card_bill",
      });
    }
  }

  events.sort((a, b) => a.date - b.date);

  let running = startingBalance;
  const timeline = events.map((event) => {
    running += event.amount;
    return { ...event, daysFromNow: daysBetween(now, event.date), balanceAfter: running };
  });

  return {
    startingBalance,
    horizonDays: HORIZON_DAYS,
    timeline,
    projectedBalance: running,
  };
}
