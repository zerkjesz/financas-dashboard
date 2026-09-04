"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

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

  const stats = [
    { label: "Recebido no ciclo", value: snapshot.recebido, tone: "text-white" },
    { label: "Gasto no ciclo", value: snapshot.gasto, tone: "text-negative" },
    { label: "Saldo atual", value: snapshot.balance, tone: "text-white" },
    { label: "Meta diária", value: snapshot.metaDiaria, tone: "text-positive" },
  ];

  return (
    <div className="rounded-xl border border-border bg-surface p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-sm font-medium text-white">Vale Alimentação</span>
        {snapshot.nextRecharge && (
          <span className="text-xs text-muted text-right">
            próxima recarga {formatDate(snapshot.nextRecharge)} · {snapshot.diasRestantes} dia{snapshot.diasRestantes === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-surface-2/40 p-3">
            <div className="text-xs text-muted mb-1">{s.label}</div>
            <div className={`tabular text-lg font-semibold ${s.tone}`}>{formatMoney(s.value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
