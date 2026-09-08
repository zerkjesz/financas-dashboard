"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";
import { CATEGORY_COLORS } from "@/lib/categoryRules";

export default function TopExpenses({ entries }) {
  const topExpenses = useMemo(
    () => entries.filter((e) => e.type === "expense").sort((a, b) => b.amount - a.amount).slice(0, 5),
    [entries]
  );

  if (topExpenses.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 h-full">
      <div className="text-sm font-medium text-white mb-2">Maiores gastos do ciclo atual</div>
      <div className="divide-y divide-border">
        {topExpenses.map((e) => (
          <div key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[e.category] || CATEGORY_COLORS.Outros }} />
            <span className="text-slate-300 truncate flex-1">{e.description}</span>
            <span className="tabular text-white font-medium shrink-0">{formatMoney(e.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
