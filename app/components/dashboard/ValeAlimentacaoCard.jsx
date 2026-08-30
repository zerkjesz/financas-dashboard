"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import SummaryCard from "../SummaryCard.jsx";

export default function ValeAlimentacaoCard() {
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

  if (loading || !snapshot) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Vale Alimentação</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Recebido no ciclo" value={snapshot.recebido} />
        <SummaryCard label="Gasto no ciclo" value={snapshot.gasto} tone="rose" />
        <SummaryCard label="Saldo atual" value={snapshot.balance} />
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-xs text-white/50 mb-1">Meta diária</div>
          <div className="text-xl font-semibold">{formatMoney(snapshot.metaDiaria)}</div>
        </div>
      </div>
      {snapshot.nextRecharge && (
        <div className="text-sm text-white/50 mt-3">
          Próxima recarga: {formatDate(snapshot.nextRecharge)} ({snapshot.diasRestantes} dia{snapshot.diasRestantes === 1 ? "" : "s"})
        </div>
      )}
    </div>
  );
}
