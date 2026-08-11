"use client";

import { useEffect, useState } from "react";
import AddForm from "./AddForm.jsx";
import BalanceCards from "./dashboard/BalanceCards.jsx";
import CardsSection from "./dashboard/CardsSection.jsx";
import UpcomingBills from "./dashboard/UpcomingBills.jsx";
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
    return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Finanças</h1>
        <button
          onClick={() => setShowAddForm((v) => !v)}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium transition-colors"
        >
          + Adicionar lançamento
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

      <IntelligenceSummary intelligence={data.intelligence} />
      <BalanceCards balances={data.balances} />
      <CardsSection cards={data.cards} />
      <UpcomingBills bills={data.upcomingBills} />
      <CategoryBreakdown entries={data.entries} />
      <TopExpenses entries={data.entries} />
      <TransactionsTable accounts={data.accounts} cards={data.cards} entries={data.entries} onChanged={load} />
    </div>
  );
}
