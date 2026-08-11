"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";

const KIND_LABEL = {
  recurring_income: "Receita",
  recurring_expense: "Conta",
  card_bill: "Fatura",
};

export default function FluxoCaixaView() {
  const [projection, setProjection] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/cash-flow")
      .then((r) => r.json())
      .then((data) => {
        setProjection(data);
        setLoading(false);
      });
  }, []);

  if (loading || !projection) return <div className="max-w-3xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-6">Fluxo de Caixa</h1>

      <div className="relative pl-6 border-l border-white/10 space-y-6">
        <TimelineItem label="Hoje" value={formatMoney(projection.startingBalance)} highlight />

        {projection.timeline.length === 0 && (
          <div className="text-white/40 text-sm pl-2">Nenhuma conta ou fatura prevista nos próximos {projection.horizonDays} dias.</div>
        )}

        {projection.timeline.map((event, i) => (
          <TimelineItem
            key={i}
            label={event.label}
            sublabel={`${KIND_LABEL[event.kind] || ""} · ${new Date(event.date).toLocaleDateString("pt-BR")} (em ${event.daysFromNow} dia${event.daysFromNow === 1 ? "" : "s"})`}
            value={`${event.amount >= 0 ? "+" : "-"}${formatMoney(Math.abs(event.amount))}`}
            tone={event.amount >= 0 ? "emerald" : "rose"}
            balanceAfter={formatMoney(event.balanceAfter)}
          />
        ))}

        <TimelineItem label={`Saldo previsto em ${projection.horizonDays} dias`} value={formatMoney(projection.projectedBalance)} highlight />
      </div>
    </div>
  );
}

function TimelineItem({ label, sublabel, value, tone, balanceAfter, highlight }) {
  return (
    <div className="relative pl-4">
      <div className={`absolute -left-[29px] top-1 w-3 h-3 rounded-full border-2 ${highlight ? "bg-emerald-500 border-emerald-500" : "bg-[#0b0f14] border-white/30"}`} />
      <div className="flex items-center justify-between">
        <div>
          <div className={highlight ? "font-medium" : ""}>{label}</div>
          {sublabel && <div className="text-xs text-white/50">{sublabel}</div>}
        </div>
        <div className="text-right">
          <div className={tone === "emerald" ? "text-emerald-400" : tone === "rose" ? "text-rose-400" : "font-medium"}>{value}</div>
          {balanceAfter && <div className="text-xs text-white/40">saldo: {balanceAfter}</div>}
        </div>
      </div>
    </div>
  );
}
