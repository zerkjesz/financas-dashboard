"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";
import { CATEGORY_COLORS } from "@/lib/categoryRules";

// Fase 5.4C, itens 26-28 — seção única "pra onde foi o dinheiro" substituindo
// CategoryBreakdown + TopExpenses separados (evita 2 cards dizendo coisas
// parecidas). Recebe `entries` JÁ filtradas pelo ciclo financeiro no pai
// (Dashboard.jsx, desde a Fase 5.3B — TOP_EXPENSES_PERIOD_STATUS =
// ALREADY_FIXED_AT_PARENT) — nenhum filtro novo aqui. Sem biblioteca de
// gráfico: barras horizontais com valor+% sempre visíveis (nunca exige
// hover) — donut fica deferido pra 5.4D se algum dia fizer sentido.
export default function SpendingSection({ entries }) {
  const { breakdown, max, total, topExpenses } = useMemo(() => {
    const totals = new Map();
    let sum = 0;
    const expenses = [];
    for (const e of entries) {
      if (e.type !== "expense") continue;
      totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
      sum += e.amount;
      expenses.push(e);
    }
    const list = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    const top = [...expenses].sort((a, b) => b.amount - a.amount).slice(0, 3);
    return { breakdown: list, max: list.length > 0 ? list[0][1] : 0, total: sum, topExpenses: top };
  }, [entries]);

  // Item 40 — empty state honesto, nunca um card vazio de layout.
  if (breakdown.length === 0) {
    return (
      <div className="rounded-card bg-surface-1 p-6">
        <h2 className="text-label text-text-muted mb-2">Pra onde foi o dinheiro</h2>
        <p className="text-body text-text-muted">Nenhum gasto registrado neste ciclo ainda.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">Pra onde foi o dinheiro (ciclo atual)</h2>
      <div className="space-y-3 mb-4">
        {breakdown.map(([category, value]) => {
          const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Outros;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <div key={category}>
              <div className="flex items-baseline justify-between mb-1 gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate text-sm text-text-secondary">{category}</span>
                  <span className="text-caption shrink-0 text-text-muted">{pct}%</span>
                </div>
                <span className="tabular shrink-0 text-sm font-medium text-text-primary">{formatMoney(value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2">
                <div className="h-full rounded-pill" style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, backgroundColor: color }} />
              </div>
            </div>
          );
        })}
      </div>

      {topExpenses.length > 0 && (
        <div className="border-t border-border-subtle pt-3">
          <div className="text-label text-text-muted mb-2">Maiores gastos</div>
          <div className="divide-y divide-border-subtle">
            {topExpenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-text-secondary">{e.description}</span>
                <span className="tabular shrink-0 font-medium text-text-primary">{formatMoney(e.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
