import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listAccountsWithBalances } from "@/lib/accounts";
import { listCardsWithLimits } from "@/lib/cards";
import { getOrCreateBill } from "@/lib/cardBillCalculator";
import { buildFinancialSummary } from "@/lib/intelligence";
import { buildVaSnapshot } from "@/lib/vaPanel";
import { listUpcomingObligations } from "@/lib/upcomingObligations";
import { listBills } from "@/lib/bills";
import { buildAlerts } from "@/lib/alerts";
import { buildCashFlowProjection } from "@/lib/cashFlowProjection";

export async function GET() {
  // Saldo/limite de contas e cartões é a parte mais pesada (várias queries por conta/cartão)
  // e é usada em quase tudo abaixo — calcula uma vez só e reaproveita, em vez de deixar
  // intelligence/alerts/cash-flow recalcularem cada um por conta própria.
  const [accounts, cardsBase] = await Promise.all([listAccountsWithBalances(), listCardsWithLimits()]);
  const projection30 = await buildCashFlowProjection({ horizonDays: 30, accounts, cards: cardsBase });

  const [incomes, expenses, intelligence, vaSnapshot, upcomingObligations, pendingBills, alerts] = await Promise.all([
    prisma.income.findMany({ include: { account: true }, orderBy: { occurredAt: "desc" } }),
    prisma.expense.findMany({ include: { account: true, card: true }, orderBy: { occurredAt: "desc" } }),
    buildFinancialSummary({ accounts, cards: cardsBase, projection30 }),
    buildVaSnapshot(),
    listUpcomingObligations({ cards: cardsBase }),
    listBills({ status: ["pending", "overdue"] }),
    buildAlerts({ projection30 }),
  ]);

  const currentCycle = new Date().toISOString().slice(0, 7);
  const cards = await Promise.all(
    cardsBase.map(async (card) => ({ ...card, currentBill: await getOrCreateBill(card.id, currentCycle) }))
  );

  const entries = [
    ...incomes.map((i) => ({
      id: i.id,
      type: "income",
      amount: i.amount,
      category: i.category,
      description: i.description,
      isRecurring: i.isRecurring,
      occurredAt: i.occurredAt,
      targetName: i.account?.name || "—",
    })),
    ...expenses.map((e) => ({
      id: e.id,
      type: "expense",
      amount: e.amount,
      category: e.category,
      description: e.description,
      isRecurring: e.isRecurring,
      occurredAt: e.occurredAt,
      targetName: e.card ? `Cartão ${e.card.name}` : e.account?.name || "—",
      accountId: e.accountId,
      cardId: e.cardId,
    })),
  ].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

  const caixaAtual = accounts.filter((a) => a.type === "checking" || a.type === "cash").reduce((s, a) => s + a.balance, 0);
  const saldoTotal = accounts.reduce((s, a) => s + a.balance, 0);

  return NextResponse.json({
    accounts,
    cards,
    entries,
    intelligence,
    vaSnapshot,
    upcomingObligations,
    pendingBills,
    alerts,
    balances: {
      caixaAtual,
      saldoTotal,
      pix: accounts.find((a) => a.slug === "itau")?.balance || 0,
      dinheiro: accounts.find((a) => a.slug === "dinheiro")?.balance || 0,
      va: accounts.find((a) => a.slug === "vale-alimentacao")?.balance || 0,
    },
  });
}
