import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listAccountsWithBalances } from "@/lib/accounts";
import { listCardsWithLimits } from "@/lib/cards";
import { getOrCreateBill } from "@/lib/cardBillCalculator";
import { getCardCycleForDate } from "@/lib/cardCycle";
import { buildFinancialSummary } from "@/lib/intelligence";
import { buildVaSnapshot } from "@/lib/vaPanel";
import { listUpcomingObligations } from "@/lib/upcomingObligations";
import { listBills } from "@/lib/bills";
import { buildAlerts } from "@/lib/alerts";
import { buildCashFlowProjection } from "@/lib/cashFlowProjection";
import { computeUnrestrictedCash } from "@/lib/unrestrictedCash";
import { sumMoney, ZERO, deepSerializeMoney } from "@/lib/money";

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

  // Fase 4.0: ciclo real de CADA cartão (closingDay-aware) — antes era um "mês
  // calendário de hoje" único e compartilhado, que ignoraria closingDay se ele
  // existisse. Idêntico ao valor antigo enquanto closingDay continuar null.
  const cards = await Promise.all(
    cardsBase.map(async (card) => {
      const currentCycle = getCardCycleForDate(card, new Date());
      return { ...card, currentBill: await getOrCreateBill(card.id, currentCycle) };
    })
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

  // Fonte central (lib/unrestrictedCash.js) — elimina a reimplementação própria que
  // existia aqui (achado da auditoria Fase 3.0) e que, com Decimal, estava
  // funcionalmente quebrada (`+` nativo não soma Decimal). `saldoTotal` é um conceito
  // diferente (patrimônio total, inclui VA) — soma direta via sumMoney().
  const caixaAtual = computeUnrestrictedCash(accounts);
  const saldoTotal = sumMoney(accounts.map((a) => a.balance));

  const payload = {
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
      pix: accounts.find((a) => a.slug === "itau")?.balance ?? ZERO,
      dinheiro: accounts.find((a) => a.slug === "dinheiro")?.balance ?? ZERO,
      va: accounts.find((a) => a.slug === "vale-alimentacao")?.balance ?? ZERO,
    },
  };

  // Fronteira de serialização (Fase 3.1, Etapa 9) — este é o payload mais profundo/
  // aninhado do app; deepSerializeMoney() converte QUALQUER Prisma.Decimal em number
  // puro, em qualquer nível, antes do JSON sair. Ver lib/money.js.
  return NextResponse.json(deepSerializeMoney(payload));
}
