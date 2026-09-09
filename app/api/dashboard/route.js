import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listAccountsWithBalances } from "@/lib/accounts";
import { listCardsWithLimits } from "@/lib/cards";
import { getCardBillView } from "@/lib/cardBillCalculator";
import { getCardCycleForDate } from "@/lib/cardCycle";
import { buildVaSnapshot } from "@/lib/vaPanel";
import { listUpcomingObligations } from "@/lib/upcomingObligations";
import { listBills } from "@/lib/bills";
import { computeUnrestrictedCash } from "@/lib/unrestrictedCash";
import { buildProductFinancialSnapshot } from "@/lib/productFinancialSnapshot";
import { getAppSettings } from "@/lib/settings";
import { getCurrentFinancialCycle } from "@/lib/financialCycle";
import { sumMoney, ZERO, deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const now = new Date();

  // Saldo/limite de contas e cartões é a parte mais pesada (várias queries por conta/cartão)
  // e é usada em quase tudo abaixo — calcula uma vez só e reaproveita.
  const [accounts, cardsBase, settings] = await Promise.all([listAccountsWithBalances(), listCardsWithLimits(), getAppSettings()]);

  // Fase 5.3B — bloco canônico: `financial` vem 100% de
  // lib/productFinancialSnapshot.js, que compõe os helpers canônicos
  // (financialEngine/freeMoney/obligationClassifier) — a MESMA verdade
  // financeira reconciliada nas Fases 5.1D-5.2D.
  //
  // Fase 5.4F — REMOVIDO: `intelligence` (lib/intelligence.js) e `alerts`
  // (lib/alerts.js), junto com o `buildCashFlowProjection` que só existia
  // pra alimentar os dois. Confirmado por grep completo (FINAL_V1_CALLER_MAP
  // do relatório da fase): nenhum componente ativo lia `data.intelligence`
  // ou `data.alerts` deste payload — eram computados em toda request e
  // nunca renderizados. `/api/intelligence` e `/api/alerts` (rotas standalone
  // que também expunham esses mesmos builders) também tinham zero caller e
  // foram removidas junto.
  const financial = await buildProductFinancialSnapshot({ now });

  const [incomes, expenses, vaSnapshot, upcomingObligations, pendingBills] = await Promise.all([
    prisma.income.findMany({ include: { account: true }, orderBy: { occurredAt: "desc" } }),
    prisma.expense.findMany({ include: { account: true, card: true }, orderBy: { occurredAt: "desc" } }),
    buildVaSnapshot(),
    listUpcomingObligations({ cards: cardsBase, productSnapshot: financial }),
    listBills({ status: ["pending", "overdue"] }),
  ]);

  // Fase 4.0: ciclo real de CADA cartão (closingDay-aware) — antes era um "mês
  // calendário de hoje" único e compartilhado, que ignoraria closingDay se ele
  // existisse. Idêntico ao valor antigo enquanto closingDay continuar null.
  //
  // Fase 4.1.3: getCardBillView (não getOrCreateBill) — GET nunca materializa;
  // devolve a fatura persistida se existir, senão uma PROJEÇÃO em memória
  // (id: null), sem nenhum INSERT/UPDATE.
  const cards = await Promise.all(
    cardsBase.map(async (card) => {
      const currentCycle = getCardCycleForDate(card, new Date());
      return { ...card, currentBill: await getCardBillView(card, currentCycle) };
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

  // Fase 5.3B, item 22 — ciclo financeiro pessoal (24→23 por padrão), pra
  // componentes que significam "meu ciclo atual" (ex: TopExpenses) filtrarem
  // por ele em vez de mês calendário. lib/financialCycle.js já existia como
  // infra pronta desde a Fase 4.0, só nunca tinha sido consumida por nenhuma
  // superfície de produto.
  const financialCycle = getCurrentFinancialCycle(settings, now);

  const payload = {
    accounts,
    cards,
    entries,
    vaSnapshot,
    upcomingObligations,
    pendingBills,
    financial,
    financialCycle,
    balances: {
      caixaAtual,
      saldoTotal,
      // item 7 — "Saldo total" continua existindo (não removido nesta fase),
      // mas marcado explicitamente como incluindo saldo restrito (VA) — a UI
      // usa esta flag pra qualificar o label, nunca apresentá-lo como dinheiro
      // livre pra gastar.
      saldoTotalIncludesRestricted: true,
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
