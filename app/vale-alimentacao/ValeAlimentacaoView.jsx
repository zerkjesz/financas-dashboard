"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import SummaryCard from "../components/SummaryCard.jsx";

export default function ValeAlimentacaoView() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/va")
      .then((r) => r.json())
      .then((data) => {
        setSnapshot(data);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="max-w-3xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;
  if (!snapshot) return <div className="max-w-3xl mx-auto px-4 py-8 text-white/40">Conta de Vale Alimentação não encontrada.</div>;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-6">Vale Alimentação</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <SummaryCard label="Recebido no ciclo" value={snapshot.recebido} />
        <SummaryCard label="Gasto no ciclo" value={snapshot.gasto} tone="rose" />
        <SummaryCard label="Saldo atual" value={snapshot.balance} />
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs text-white/50 mb-1">Meta diária de consumo</div>
          <div className="text-xl font-semibold">{formatMoney(snapshot.metaDiaria)}</div>
        </div>
      </div>

      {snapshot.nextRecharge && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
          Próxima recarga: {formatDate(snapshot.nextRecharge)} ({snapshot.diasRestantes} dia{snapshot.diasRestantes === 1 ? "" : "s"} restante{snapshot.diasRestantes === 1 ? "" : "s"})
        </div>
      )}
    </div>
  );
}
