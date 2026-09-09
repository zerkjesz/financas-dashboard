"use client";

import { useEffect, useState } from "react";
import AddForm from "./AddForm.jsx";
import PageContainer from "./ui/PageContainer.jsx";
import Button from "./ui/Button.jsx";
import { DashboardSkeleton } from "./Skeleton.jsx";
import FinancialHero from "./dashboard/FinancialHero.jsx";
import NextIncomeCard from "./dashboard/NextIncomeCard.jsx";
import RiskSurface from "./dashboard/RiskSurface.jsx";
import PhysicalMoneyContext from "./dashboard/PhysicalMoneyContext.jsx";
import SpendingSection from "./dashboard/SpendingSection.jsx";
import ProjectionSummary from "./dashboard/ProjectionSummary.jsx";
import { selectCriticalBannerReason } from "@/lib/homePresentation";

// ============================================================================
// Fase 5.4C — HOME REDESIGN / DECISION-FIRST DASHBOARD.
//
// A Home deixa de ser "todos os componentes do produto empilhados" e passa a
// responder, nesta ordem — a MESMA ordem tanto no DOM quanto visualmente em
// qualquer viewport (item 44: nunca usar CSS `order` pra criar uma leitura
// visual diferente da leitura por teclado/screen reader):
//
//   1. Como eu tô?            -> FinancialHero (status + freeMoney + safeToSpend + motivo)
//   2. O que vem a seguir?    -> NextIncomeCard
//   3. Onde estão os números físicos? -> PhysicalMoneyContext
//   4. Existe risco em aberto? -> RiskSurface (só quando há contingência ativa)
//   5. Pra onde foi o dinheiro? -> SpendingSection
//   6. Como fico? (30/60/90)  -> ProjectionSummary
//
// Removidos da Home nesta fase (LEGACY_HOME_CALLER_REMOVED — arquivos
// preservados, só deixam de ser renderizados; ver relatório da fase pro
// HOME_LEGACY_COMPONENT_MAP completo): AlertsPanel, BalanceCards,
// CardsSection, ValeAlimentacaoCard, UpcomingObligations, IntelligenceSummary,
// CategoryBreakdown/TopExpenses antigos (substituídos por SpendingSection),
// TransactionsTable completa (70+ linhas — Histórico ainda não existe, 5.4D).
//
// Nenhum cálculo financeiro novo: todo número vem de `data.financial`
// (lib/productFinancialSnapshot.js) ou de `data.cards`/`cycleEntries`
// (já filtrados no próprio parent desde a Fase 5.3B).
// ============================================================================
export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/dashboard");
    const json = await res.json();
    setData(json);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  if (loading || !data) {
    return <DashboardSkeleton />;
  }

  // Fase 5.3B, item 22/23 — "gastos do ciclo" significam o CICLO FINANCEIRO
  // pessoal (24→23 por padrão), não mês calendário nem todo o histórico.
  // TOP_EXPENSES_PERIOD_STATUS = ALREADY_FIXED_AT_PARENT (auditado na Fase
  // 5.4B): este filtro já existia desde a Fase 5.3B — SpendingSection não
  // reimplementa nada, só recebe `cycleEntries` pronto.
  const cycleStart = data.financialCycle ? new Date(data.financialCycle.start) : null;
  const cycleEntries = cycleStart ? data.entries.filter((e) => new Date(e.occurredAt) >= cycleStart) : data.entries;

  const { financial } = data;
  const criticalReason = financial.liquidity.status === "CRITICO" ? selectCriticalBannerReason(financial.liquidity.statusReasons) : null;
  const hasRisk = financial.contingency?.items?.length > 0;

  return (
    <PageContainer>
      {/* Item 5 — greeting sem timestamp fake. "Visão atual" é honesto (o
          dado É o estado atual do fetch); nunca "atualizado há 2 min" sem
          rastrear isso de verdade. */}
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-page-title text-text-primary">Olá</h1>
          <p className="text-caption text-text-muted">Visão atual dos seus números</p>
        </div>
        <Button onClick={() => setShowAddForm((v) => !v)} variant="secondary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          Adicionar lançamento
        </Button>
      </header>

      {showAddForm && (
        <div className="mb-6">
          <AddForm
            accounts={data.accounts}
            cards={data.cards}
            onSubmitted={() => {
              setShowAddForm(false);
              load();
            }}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Item 24 — consolidação de banners: TRANQUILO/ATENÇÃO/APERTADO nunca
          têm banner de status (Apertado já tem o CTA discreto dentro do
          hero). CRÍTICO é o ÚNICO status com banner permitido — e só com o
          motivo estruturado REAL (lib/financialStatus.js), nunca uma frase
          inventada aqui nem duplicando o que o hero já diz. */}
      {criticalReason && (
        <div role="alert" className="mb-6 rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-text-primary">
          {criticalReason.message}
        </div>
      )}

      {/* 1. Como eu tô? + 2. O que vem a seguir? (lado a lado no desktop, sem
          reordenar o DOM em mobile — só o grid muda de 1 pra 2 colunas). */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <FinancialHero financial={financial} />
        </div>
        <NextIncomeCard nextIncome={financial.nextIncome} nextIncomeCommitment={financial.nextIncomeCommitment} />
      </div>

      {/* 3. Onde estão os números físicos? */}
      <div className="mb-4">
        <PhysicalMoneyContext liquidity={financial.liquidity} cards={data.cards} restricted={financial.restricted} />
      </div>

      {/* 4. Existe risco em aberto? — só existe no DOM quando há contingência ativa. */}
      {hasRisk && (
        <div className="mb-4">
          <RiskSurface contingency={financial.contingency} />
        </div>
      )}

      {/* 5. Pra onde foi o dinheiro? + 6. Como fico? */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SpendingSection entries={cycleEntries} />
        <ProjectionSummary projectionSummary={financial.projectionSummary} />
      </div>
    </PageContainer>
  );
}
