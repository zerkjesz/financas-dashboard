"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";

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

  if (loading || !data) return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-6">Indicadores</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <Stat label="% do salário comprometido" value={data.percentualSalarioComprometido != null ? `${data.percentualSalarioComprometido}%` : "—"} />
        <Stat label="Total em contas futuras" value={formatMoney(data.totalContasFuturas)} />
        <Stat label="Total em parcelas" value={formatMoney(data.totalParcelas)} />
        <Stat label="Total em faturas em aberto" value={formatMoney(data.totalFaturas)} />
        <Stat label="Despesas fixas (mês)" value={formatMoney(data.despesasFixas)} />
        <Stat label="Despesas variáveis (mês)" value={formatMoney(data.despesasVariaveis)} />
        <Stat label="Patrimônio disponível" value={formatMoney(data.patrimonioDisponivel)} tone="emerald" />
        <Stat label="Caixa livre" value={formatMoney(data.caixaLivre)} tone="emerald" />
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-sm text-white/50 mb-3">Comprometimento dos próximos meses</div>
        <div className="space-y-2">
          {data.comprometimentoProximosMeses.map((m) => (
            <div key={m.month} className="flex items-center justify-between text-sm">
              <span className="text-white/70">{m.month}</span>
              <span className="font-medium">{formatMoney(m.total)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs text-white/50 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${tone === "emerald" ? "text-emerald-400" : ""}`}>{value}</div>
    </div>
  );
}
