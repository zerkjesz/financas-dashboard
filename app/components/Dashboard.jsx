"use client";

import { useEffect, useState } from "react";
import AddForm from "./AddForm.jsx";
import { DashboardSkeleton } from "./Skeleton.jsx";
import FinancialTruthPanel from "./dashboard/FinancialTruthPanel.jsx";
import BalanceCards from "./dashboard/BalanceCards.jsx";
import CardsSection from "./dashboard/CardsSection.jsx";
import ValeAlimentacaoCard from "./dashboard/ValeAlimentacaoCard.jsx";
import UpcomingObligations from "./dashboard/UpcomingObligations.jsx";
import AlertsPanel from "./dashboard/AlertsPanel.jsx";
import IntelligenceSummary from "./dashboard/IntelligenceSummary.jsx";
import CategoryBreakdown from "./dashboard/CategoryBreakdown.jsx";
import TopExpenses from "./dashboard/TopExpenses.jsx";
import TransactionsTable from "./dashboard/TransactionsTable.jsx";

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

  // Fase 5.3B, item 22/23 — "gastos do mês"/"maiores gastos do período" devem
  // significar o CICLO FINANCEIRO pessoal (24→23 por padrão), não mês
  // calendário nem todo o histórico (achado da Fase 5.3A: TopExpenses não
  // filtrava período nenhum). `data.financialCycle` vem de
  // lib/financialCycle.js (infra que já existia desde a Fase 4.0, nunca antes
  // consumida por nenhuma superfície de produto).
  const cycleStart = data.financialCycle ? new Date(data.financialCycle.start) : null;
  const cycleEntries = cycleStart ? data.entries.filter((e) => new Date(e.occurredAt) >= cycleStart) : data.entries;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Finanças</h1>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-positive hover:bg-positive-soft px-4 py-2 text-sm font-medium text-slate-950 transition-colors cursor-pointer"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          Adicionar lançamento
        </button>
      </header>

      {showAddForm && (
        <AddForm
          accounts={data.accounts}
          cards={data.cards}
          onSubmitted={() => {
            setShowAddForm(false);
            load();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <AlertsPanel alerts={data.alerts} />

      <FinancialTruthPanel financial={data.financial} />

      <div className="mb-4">
        <BalanceCards balances={data.balances} />
      </div>

      <div className="mb-4">
        <IntelligenceSummary intelligence={data.intelligence} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-4">
        <div className="lg:col-span-7">
          <CardsSection cards={data.cards} />
        </div>
        <div className="lg:col-span-5">
          <ValeAlimentacaoCard />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-4">
        <div className="lg:col-span-5">
          <CategoryBreakdown entries={cycleEntries} />
        </div>
        <div className="lg:col-span-4">
          <TopExpenses entries={cycleEntries} />
        </div>
        <div className="lg:col-span-3">
          <UpcomingObligations items={data.upcomingObligations} />
        </div>
      </div>

      <TransactionsTable accounts={data.accounts} cards={data.cards} entries={data.entries} onChanged={load} />
    </div>
  );
}
