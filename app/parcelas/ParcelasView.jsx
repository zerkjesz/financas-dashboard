"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ParcelasView() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/purchases");
    setPurchases(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id) {
    if (!confirm("Excluir esta compra parcelada e todas as parcelas?")) return;
    await fetch(`/api/purchases/${id}`, { method: "DELETE" });
    load();
  }

  if (loading) {
    return (
      <div>
        <SkeletonBlock className="h-8 w-32 mb-6" />
        <SkeletonBlock className="h-40" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Parcelas</h1>

      {purchases.length === 0 && <div className="text-muted">Nenhuma compra parcelada registrada.</div>}

      {purchases.length > 0 && (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="bg-surface-2 text-left text-muted text-xs uppercase tracking-wide">
                <th className="px-3 py-2.5 font-medium">Compra</th>
                <th className="px-3 py-2.5 font-medium text-right">Valor total</th>
                <th className="px-3 py-2.5 font-medium">Progresso</th>
                <th className="px-3 py-2.5 font-medium text-right">Valor mensal</th>
                <th className="px-3 py-2.5 font-medium">Última parcela</th>
                <th className="px-3 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {purchases.map((p) => {
                const pct = Math.min(100, (p.currentInstallmentNumber / p.installmentCount) * 100);
                return (
                  <tr key={p.id}>
                    <td className="px-3 py-3 text-slate-200 max-w-[240px] truncate">{p.description}</td>
                    <td className="px-3 py-3 text-right tabular text-white">{formatMoney(p.totalAmount)}</td>
                    <td className="px-3 py-3 min-w-[140px]">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-surface-2 overflow-hidden">
                          <div className="h-full rounded-full bg-info" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-muted tabular shrink-0">{p.currentInstallmentNumber}/{p.installmentCount}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular text-white">{formatMoney(p.installmentValue)}</td>
                    <td className="px-3 py-3 text-muted">{p.lastInstallmentMonth}</td>
                    <td className="px-3 py-3 text-right">
                      <button onClick={() => remove(p.id)} className="text-muted hover:text-negative cursor-pointer transition-colors" title="Excluir" aria-label="Excluir">
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
