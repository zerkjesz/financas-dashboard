"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";

const CHART_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-rose-500", "bg-violet-500", "bg-cyan-500", "bg-white/30"];

export default function CategoryBreakdown({ entries }) {
  const { entries: breakdown, max } = useMemo(() => {
    const totals = new Map();
    for (const e of entries) {
      if (e.type !== "expense") continue;
      totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
    }
    const list = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    return { entries: list, max: list.length > 0 ? list[0][1] : 0 };
  }, [entries]);

  if (breakdown.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Gastos por categoria</div>
      <div className="space-y-2">
        {breakdown.map(([category, total], i) => (
          <div key={category} className="flex items-center gap-3">
            <div className="w-28 text-xs text-white/70 shrink-0 truncate">{category}</div>
            <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
              <div className={`h-full rounded-full ${CHART_COLORS[i % CHART_COLORS.length]}`} style={{ width: `${(total / max) * 100}%` }} />
            </div>
            <div className="w-24 text-xs text-white/70 text-right shrink-0">{formatMoney(total)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
