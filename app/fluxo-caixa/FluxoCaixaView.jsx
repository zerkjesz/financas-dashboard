"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";

const HORIZON_OPTIONS = [7, 30, 60, 90, 180];

const KIND_LABEL = {
  recurring_income: "Receita",
  bill: "Conta",
  card_bill: "Fatura",
};

export default function FluxoCaixaView() {
  const [horizonDays, setHorizonDays] = useState(60);
  const [projection, setProjection] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/cash-flow?days=${horizonDays}`)
      .then((r) => r.json())
      .then((data) => {
        setProjection(data);
        setLoading(false);
      });
  }, [horizonDays]);

  return (
    <div className="max-w-3xl mx-auto">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Fluxo de Caixa</h1>
        <div className="flex gap-1">
          {HORIZON_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHorizonDays(d)}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors cursor-pointer ${horizonDays === d ? "bg-surface-2 text-white border border-border-strong" : "text-muted hover:text-white hover:bg-surface-2/50"}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {(loading || !projection) ? (
        <SkeletonBlock className="h-72" />
      ) : (
        <div className="relative pl-6 border-l border-border space-y-6">
          <TimelineItem label="Hoje" value={formatMoney(projection.startingBalance)} highlight />

          {projection.timeline.length === 0 && (
            <div className="text-muted text-sm pl-2">Nenhuma conta ou fatura prevista nos próximos {projection.horizonDays} dias.</div>
          )}

          {projection.timeline.map((event, i) => (
            <TimelineItem
              key={i}
              label={event.label}
              sublabel={`${KIND_LABEL[event.kind] || ""} · ${formatDate(event.date)} (em ${event.daysFromNow} dia${event.daysFromNow === 1 ? "" : "s"})`}
              value={`${event.amount >= 0 ? "+" : "-"}${formatMoney(Math.abs(event.amount))}`}
              tone={event.amount >= 0 ? "positive" : "negative"}
              balanceAfter={formatMoney(event.balanceAfter)}
            />
          ))}

          <TimelineItem label={`Saldo previsto em ${projection.horizonDays} dias`} value={formatMoney(projection.projectedBalance)} highlight />
        </div>
      )}
    </div>
  );
}

function TimelineItem({ label, sublabel, value, tone, balanceAfter, highlight }) {
  return (
    <div className="relative pl-4">
      <div className={`absolute -left-[29px] top-1 w-3 h-3 rounded-full border-2 ${highlight ? "bg-positive border-positive" : "bg-bg border-border-strong"}`} />
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className={highlight ? "font-medium text-white" : "text-slate-200"}>{label}</div>
          {sublabel && <div className="text-xs text-muted">{sublabel}</div>}
        </div>
        <div className="text-right">
          <div className={`tabular ${tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "font-medium text-white"}`}>{value}</div>
          {balanceAfter && <div className="text-xs text-muted tabular">saldo: {balanceAfter}</div>}
        </div>
      </div>
    </div>
  );
}
