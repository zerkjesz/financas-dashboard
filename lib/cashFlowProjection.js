import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { listBills, ensureUpcomingRecurringBills } from "./bills.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";

export const HORIZON_OPTIONS = [7, 30, 60, 90, 180];
const DEFAULT_HORIZON_DAYS = 60;

// Linha do tempo: Hoje -> receitas recorrentes (salário, VA) -> Bill (contas a pagar) -> faturas -> saldo previsto.
// `accounts`/`cards` podem vir já calculados (dashboard já fez isso) pra não recalcular saldo/
// limite do zero de novo — quem chama isolado (ex: /api/cash-flow) deixa em branco e a função
// busca sozinha.
export async function buildCashFlowProjection({ horizonDays = DEFAULT_HORIZON_DAYS, accounts: accountsIn, cards: cardsIn } = {}) {
  await ensureUpcomingRecurringBills();

  const now = new Date();
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const [accounts, cards, incomeRules, bills] = await Promise.all([
    accountsIn || listAccountsWithBalances(),
    cardsIn || listCardsWithLimits(),
    prisma.recurringRule.findMany({ where: { isActive: true, kind: "income" } }),
    listBills({ status: ["pending", "overdue"], withinDays: horizonDays }),
  ]);

  const startingBalance = accounts.reduce((sum, a) => sum + a.balance, 0);
  const events = [];

  for (const rule of incomeRules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    events.push({ date, label: rule.name, amount: rule.amount, kind: "recurring_income" });
  }

  for (const bill of bills) {
    events.push({ date: bill.dueDate, label: bill.description, amount: -bill.amount, kind: "bill" });
  }

  const cardBillsByCard = await Promise.all(
    cards.map((card) =>
      prisma.cardBill.findMany({
        where: { cardId: card.id, status: { in: ["open", "closed"] }, dueAt: { gte: now, lte: horizon } },
        orderBy: { dueAt: "asc" },
      })
    )
  );
  cards.forEach((card, i) => {
    for (const bill of cardBillsByCard[i]) {
      events.push({ date: bill.dueAt, label: `Fatura ${card.name} (${bill.cycleMonth})`, amount: -bill.totalAmount, kind: "card_bill" });
    }
  });

  events.sort((a, b) => a.date - b.date);

  let running = startingBalance;
  const timeline = events.map((event) => {
    running += event.amount;
    return { ...event, daysFromNow: daysBetween(now, event.date), balanceAfter: running };
  });

  return {
    startingBalance,
    horizonDays,
    timeline,
    projectedBalance: running,
  };
}
