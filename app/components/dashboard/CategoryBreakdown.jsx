"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";
import { CATEGORY_COLORS } from "@/lib/categoryRules";

export default function CategoryBreakdown({ entries }) {
  const { breakdown, max, total } = useMemo(() => {
    const totals = new Map();
    let sum = 0;
    for (const e of entries) {
      if (e.type !== "expense") continue;
      totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
      sum += e.amount;
    }
    const list = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    return { breakdown: list, max: list.length > 0 ? list[0][1] : 0, total: sum };
  }, [entries]);

  if (breakdown.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 mb-6">
      <div className="text-sm font-medium text-white mb-4">Gastos por categoria</div>
      <div className="space-y-3">
        {breakdown.map(([category, value]) => {
          const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Outros;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <div key={category}>
              <div className="flex items-baseline justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                  <span className="text-sm text-slate-200 truncate">{category}</span>
                  <span className="text-xs text-muted shrink-0">{pct}%</span>
                </div>
                <span className="tabular text-sm text-white font-medium shrink-0 pl-2">{formatMoney(value)}</span>
              </div>
              <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full rounded-full transition-[width]" style={{ width: `${(value / max) * 100}%`, backgroundColor: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
