"use client";

import { formatMoney } from "@/lib/formatMoney";
import { obligationItemLabel } from "@/lib/commitmentsPresentation";

// Fase 6.0 (Design Freeze) — RESTYLE. Não é um dos 4 "group cards" do
// design aprovado (esse cobre confirmadas/cartão/parcelas/risco) — é
// conteúdo real que a referência não mostra mas que já existia e continua
// funcional, só migrado pro vocabulário visual novo (eyebrow mono, card
// branco, tabular-nums). Nenhuma soma nova em JSX (item 29 original):
// `committedAmount` continua o total canônico; cardAmount/externalAmount/
// otherAmount continuam a MESMA decomposição pronta de
// lib/productFinancialSnapshot.js.
export default function NextIncomeWindowSection({ nextIncomeCommitment, nextWindowItems }) {
  const { committedAmount, baseCommittedPercent, cardAmount, externalAmount, otherAmount } = nextIncomeCommitment;
  if (Number(committedAmount) === 0) return null;

  const parts = [
    { label: "Fatura de cartão em aberto", amount: cardAmount },
    { label: "Parcelas externas", amount: externalAmount },
    { label: "Outros", amount: otherAmount },
  ].filter((p) => Number(p.amount) > 0);

  return (
    <div className="rounded-card bg-surface p-5 sm:p-7 shadow-card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-eyebrow text-text-muted">Sai da próxima renda</h2>
        <span className="tabular text-metric-md text-text-primary">{formatMoney(committedAmount)}</span>
      </div>
      <p className="text-caption text-text-muted mb-4">
        {baseCommittedPercent.toFixed(0)}% do valor-base da próxima renda já tem destino antes mesmo de cair.
      </p>

      {parts.length > 0 && (
        <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0 mb-1">
          {parts.map((p) => (
            <div key={p.label} className="py-2 first:pt-0 last:pb-0 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0">
              <div className="text-caption text-text-muted">{p.label}</div>
              <div className="tabular text-sm font-medium text-text-primary">{formatMoney(p.amount)}</div>
            </div>
          ))}
        </div>
      )}

      {nextWindowItems.length > 0 && (
        <div className="mt-4 border-t border-border-subtle pt-3">
          <div className="text-caption text-text-muted mb-2">Parcelas externas nesta janela</div>
          <div className="divide-y divide-border-subtle">
            {nextWindowItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate text-text-secondary">{obligationItemLabel(item)}</span>
                <span className="tabular shrink-0 font-medium text-text-primary">{formatMoney(item.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
