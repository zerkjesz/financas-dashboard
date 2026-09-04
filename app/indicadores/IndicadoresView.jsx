"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";

export default function IndicadoresView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/indicators")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, []);

  if (loading || !data) {
    return (
      <div>
        <SkeletonBlock className="h-8 w-40 mb-6" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
        <SkeletonBlock className="h-40" />
      </div>
    );
  }

  const maxMonth = Math.max(1, ...data.comprometimentoProximosMeses.map((m) => m.total));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Indicadores</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <Stat label="% do salário comprometido" value={data.percentualSalarioComprometido != null ? `${data.percentualSalarioComprometido}%` : "—"} />
        <Stat label="Total em contas futuras" value={formatMoney(data.totalContasFuturas)} />
        <Stat label="Total em parcelas" value={formatMoney(data.totalParcelas)} />
        <Stat label="Total em faturas em aberto" value={formatMoney(data.totalFaturas)} />
        <Stat label="Despesas fixas (mês)" value={formatMoney(data.despesasFixas)} />
        <Stat label="Despesas variáveis (mês)" value={formatMoney(data.despesasVariaveis)} />
        <Stat label="Patrimônio disponível" value={formatMoney(data.patrimonioDisponivel)} tone="positive" />
        <Stat label="Caixa livre" value={formatMoney(data.caixaLivre)} tone="positive" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="text-sm text-muted mb-4">Comprometimento dos próximos meses</div>
        <div className="space-y-3">
          {data.comprometimentoProximosMeses.map((m) => (
            <div key={m.month} className="flex items-center gap-3 text-sm">
              <span className="text-muted w-20 shrink-0">{m.month}</span>
              <div className="h-2 flex-1 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full rounded-full bg-info" style={{ width: `${(m.total / maxMonth) * 100}%` }} />
              </div>
              <span className="font-medium text-white tabular w-24 text-right shrink-0">{formatMoney(m.total)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className={`text-lg font-semibold tabular ${tone === "positive" ? "text-positive" : "text-white"}`}>{value}</div>
    </div>
  );
}
