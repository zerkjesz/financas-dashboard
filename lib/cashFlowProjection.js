import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { listCardsWithLimits } from "./cards.js";
import { listBills, ensureUpcomingRecurringBills } from "./bills.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";
import { computeUnrestrictedCash, unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { money, addMoney, subtractMoney, multiplyMoney, maxMoney, ZERO } from "./money.js";

export const HORIZON_OPTIONS = [7, 30, 60, 90, 180];
const DEFAULT_HORIZON_DAYS = 60;

// Linha do tempo: Hoje -> receitas recorrentes (salário, VA) -> Bill (contas a pagar) -> faturas -> saldo previsto.
// `accounts`/`cards` podem vir já calculados (dashboard já fez isso) pra não recalcular saldo/
// limite do zero de novo — quem chama isolado (ex: /api/cash-flow) deixa em branco e a função
// busca sozinha.
//
// Decimal-first (Fase 3.1): startingBalance/amount/totalAmount/paidAmount já vêm como
// Decimal — a soma acumulada (`running`) roda inteira em Decimal, nunca passa por
// number no meio do loop.
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

  // Ponto de partida é unrestrictedCash (checking+cash reais, exclui VA — AUDITORIA,
  // achado P0-4), NÃO freeMoney (esse nome fica reservado pra quando reservas/dívidas/
  // compromissos existirem e forem descontados também — Fase 3). Antes essa projeção
  // somava o saldo de todas as contas, inflando o saldo previsto e o alerta de "tem
  // saldo suficiente pros próximos 30 dias" com o saldo de VA.
  const startingBalance = computeUnrestrictedCash(accounts);
  const unrestrictedAccountIds = unrestrictedCashAccountIds(accounts);
  const events = [];

  for (const rule of incomeRules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    // Receita recorrente presa a uma conta restrita (ex: recarga de VA) continua
    // aparecendo na linha do tempo pra informação (evento visível), mas não deve
    // mover o caixa monetário projetado — ver `restricted` no cálculo de `running`
    // abaixo. Uma receita recorrente presa a conta irrestrita SÓ altera a projeção
    // na data em que ela deveria acontecer (é um evento futuro na timeline), nunca
    // o saldo anterior a essa data.
    const restricted = rule.accountId ? !unrestrictedAccountIds.has(rule.accountId) : false;
    events.push({ date, label: rule.name, amount: money(rule.amount), kind: "recurring_income", restricted });
  }

  for (const bill of bills) {
    events.push({ date: bill.dueDate, label: bill.description, amount: multiplyMoney(bill.amount, -1), kind: "bill" });
  }

  const cardBillsByCard = await Promise.all(
    cards.map((card) =>
      prisma.cardBill.findMany({
        where: { cardId: card.id, status: { in: ["open", "closed", "partially_paid"] }, dueAt: { gte: now, lte: horizon } },
        orderBy: { dueAt: "asc" },
      })
    )
  );
  cards.forEach((card, i) => {
    for (const bill of cardBillsByCard[i]) {
      // Já pago parcialmente não entra de novo na projeção — só o que ainda falta.
      const remaining = maxMoney(ZERO, subtractMoney(bill.totalAmount, money(bill.paidAmount)));
      events.push({ date: bill.dueAt, label: `Fatura ${card.name} (${bill.cycleMonth})`, amount: multiplyMoney(remaining, -1), kind: "card_bill" });
    }
  });

  events.sort((a, b) => a.date - b.date);

  let running = startingBalance;
  const timeline = events.map((event) => {
    if (!event.restricted) running = addMoney(running, event.amount);
    return { ...event, daysFromNow: daysBetween(now, event.date), balanceAfter: running };
  });

  return {
    startingBalance,
    horizonDays,
    timeline,
    projectedBalance: running,
  };
}
