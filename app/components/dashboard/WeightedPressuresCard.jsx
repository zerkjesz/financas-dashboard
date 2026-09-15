"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — "O que mais pesa": lista de barras horizontais
// ranqueadas por categoria de gasto do ciclo atual (substitui visualmente o
// antigo SpendingSection nesta posição da Home). Mesma fonte de dado —
// `entries` já filtradas pelo ciclo financeiro no pai (Dashboard.jsx) —
// nenhum cálculo novo, só reagrupamento por categoria + ranking, que já
// existia. Barra mais pesada sempre em `bg-accent` (lime — aqui é
// "destaque", não estado financeiro), as demais em tons neutros
// decrescentes — reproduz a hierarquia visual da referência sem inventar
// uma paleta de categoria nova.
const RANK_TONE = ["bg-accent", "bg-ink", "bg-gray-1", "bg-gray-2", "bg-gray-3"];

export default function WeightedPressuresCard({ entries }) {
  const rows = useMemo(() => {
    const totals = new Map();
    for (const e of entries) {
      if (e.type !== "expense") continue;
      totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
    }
    return Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [entries]);

  if (rows.length === 0) {
    return (
      <div className="rounded-card bg-surface shadow-card p-7">
        <h2 className="text-card-title text-text-primary mb-2">O que mais pesa</h2>
        <p className="text-body text-text-muted">Nenhum gasto registrado neste ciclo ainda.</p>
      </div>
    );
  }

  const max = rows[0][1];

  return (
    <div className="rounded-card bg-surface shadow-card p-7">
      <h2 className="text-card-title text-text-primary mb-5">O que mais pesa</h2>
      <div className="space-y-4">
        {rows.map(([category, value], i) => (
          <div key={category}>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <span className="truncate text-sm text-text-secondary">{category}</span>
              <span className="tabular shrink-0 text-sm font-semibold text-text-primary">{formatMoney(value)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-pill bg-track">
              <div className={`transition-bar h-full rounded-pill ${RANK_TONE[i] ?? "bg-gray-3"}`} style={{ width: `${(value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
