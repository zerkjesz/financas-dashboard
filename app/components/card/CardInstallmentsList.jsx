"use client";

import { formatMoney } from "@/lib/formatMoney";

// Fase 5.4D, item 18 — CARD installments (Purchase/Installment, sempre presa
// a este Card) separadas de EXTERNAL installments (ExternalInstallmentPlan,
// dívida fora do cartão — dono agora é /compromissos, item 19). Nunca
// misturadas na mesma tabela só porque as duas têm "parcelas" no nome.
export default function CardInstallmentsList({ purchases }) {
  if (purchases.length === 0) return null;

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">Compras parceladas no cartão</h2>
      <div className="divide-y divide-border-subtle">
        {purchases.map((p) => {
          const pct = Math.min(100, (p.currentInstallmentNumber / p.installmentCount) * 100);
          return (
            <div key={p.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <span className="min-w-0 truncate text-sm text-text-secondary">{p.description}</span>
                <span className="tabular shrink-0 text-sm font-medium text-text-primary">{formatMoney(p.installmentValue)}/mês</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-2">
                  <div className="h-full rounded-pill bg-restricted" style={{ width: `${pct}%` }} />
                </div>
                <span className="tabular shrink-0 text-caption text-text-muted">
                  {p.currentInstallmentNumber}/{p.installmentCount}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
