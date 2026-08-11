"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/formatMoney";

export default function TopExpenses({ entries }) {
  const topExpenses = useMemo(
    () => entries.filter((e) => e.type === "expense").sort((a, b) => b.amount - a.amount).slice(0, 5),
    [entries]
  );

  if (topExpenses.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Maiores gastos do período</div>
      <div className="space-y-1.5">
        {topExpenses.map((e) => (
          <div key={e.id} className="flex items-center justify-between text-sm">
            <span className="text-white/70 truncate pr-4">{e.description}</span>
            <span className="text-rose-400 font-medium shrink-0">{formatMoney(e.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
