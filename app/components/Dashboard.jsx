"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import AddForm from "./AddForm.jsx";
import PageContainer from "./ui/PageContainer.jsx";
import Button from "./ui/Button.jsx";
import { DashboardSkeleton } from "./Skeleton.jsx";
import SpendableTodayCard from "./dashboard/SpendableTodayCard.jsx";
import MoneyBridgeCard from "./dashboard/MoneyBridgeCard.jsx";
import NotSpendableStrip from "./dashboard/NotSpendableStrip.jsx";
import WeightedPressuresCard from "./dashboard/WeightedPressuresCard.jsx";
import NextIncomeSpotlight from "./dashboard/NextIncomeSpotlight.jsx";
import UpcomingEventsCard from "./dashboard/UpcomingEventsCard.jsx";
import RiskSurface from "./dashboard/RiskSurface.jsx";
import { selectCriticalBannerReason, STATUS_COPY } from "@/lib/homePresentation";

const GREETING_BY_HOUR = (hour) => (hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite");
// Data de HOJE (não uma data de calendário armazenada em UTC-meia-noite) —
// nunca reaproveitar formatMoney.formatDate aqui (aquele força timeZone:UTC,
// certo pra vencimento/fechamento persistidos, errado pra "agora" no fuso
// local de verdade).
const formatToday = (date) => {
  const s = date.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const STATUS_DOT_CLASS = { TRANQUILO: "bg-positive", ATENCAO: "bg-warning", APERTADO: "bg-warning", CRITICO: "bg-danger" };

// ============================================================================
// Fase 6.0 (Design Freeze) — HOME reconstruída sobre a identidade final do
// ZIP aprovado, MESMA hierarquia de decisão já em vigor desde a 5.4C (nunca
// reordenada, só re-vestida):
//
//   1. Como eu tô / quanto dá pra gastar hoje -> SpendableTodayCard + bridge
//   2. Isso não é dinheiro livre (VA/limite)   -> NotSpendableStrip
//   3. O que mais pesa                          -> WeightedPressuresCard
//   4. A próxima renda alivia                   -> NextIncomeSpotlight
//   5. Existe risco em aberto?                  -> RiskSurface (condicional)
//   6. Chega e sai nos próximos dias             -> UpcomingEventsCard
//
// Nenhum cálculo financeiro novo: todo número continua vindo de
// `data.financial` (lib/productFinancialSnapshot.js) ou de
// `data.cards`/`data.upcomingObligations`/`cycleEntries` (já corretos desde
// a 5.3B/5.4C).
// ============================================================================
export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [now] = useState(() => new Date());

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

  const cycleStart = data.financialCycle ? new Date(data.financialCycle.start) : null;
  const cycleEntries = cycleStart ? data.entries.filter((e) => new Date(e.occurredAt) >= cycleStart) : data.entries;

  const { financial } = data;
  const criticalReason = financial.liquidity.status === "CRITICO" ? selectCriticalBannerReason(financial.liquidity.statusReasons) : null;
  const hasRisk = financial.contingency?.items?.length > 0;
  const statusCopy = STATUS_COPY[financial.liquidity.status] ?? STATUS_COPY.ATENCAO;
  const daysToIncome = financial.nextIncome?.expectedDate
    ? Math.max(0, Math.round((new Date(financial.nextIncome.expectedDate).setUTCHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86400000))
    : null;

  return (
    <PageContainer>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-7">
        <div>
          <div className="text-eyebrow text-text-muted mb-1">{formatToday(now)}</div>
          <h1 className="text-page-title text-text-primary">{GREETING_BY_HOUR(now.getHours())}.</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-2 rounded-pill bg-surface px-4 py-2 shadow-card">
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT_CLASS[financial.liquidity.status] ?? "bg-warning"}`} aria-hidden="true" />
            <span className="text-sm font-semibold text-text-primary">{statusCopy.label}</span>
            {daysToIncome != null && <span className="text-caption text-text-muted">faltam {daysToIncome} dias para a renda</span>}
          </div>
          <Button onClick={() => setShowAddForm((v) => !v)} variant="secondary">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Adicionar lançamento
          </Button>
        </div>
      </header>

      {showAddForm && (
        <div className="mb-7">
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

      {criticalReason && (
        <div role="alert" className="mb-7 rounded-card bg-danger-bg px-4 py-3 text-sm text-danger-text">
          {criticalReason.message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6 items-stretch">
        <SpendableTodayCard financial={financial} />
        <MoneyBridgeCard financial={financial} />
      </div>

      <div className="mb-6">
        <NotSpendableStrip restricted={financial.restricted} cards={data.cards} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4 mb-6 items-start">
        <WeightedPressuresCard entries={cycleEntries} />
        <NextIncomeSpotlight nextIncome={financial.nextIncome} nextIncomeCommitment={financial.nextIncomeCommitment} />
      </div>

      {hasRisk && (
        <div className="mb-6">
          <RiskSurface contingency={financial.contingency} />
        </div>
      )}

      <UpcomingEventsCard items={data.upcomingObligations} />
    </PageContainer>
  );
}
