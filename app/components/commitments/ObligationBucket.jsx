"use client";

import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { obligationItemLabel, obligationItemDate, obligationItemHref, OBLIGATION_CLASS_LABEL } from "@/lib/commitmentsPresentation";

// Fase 5.4D, itens 26/28/30 — bucket genérico reaproveitado pelas 4 seções
// de horizonte (Já gasto / Antes da próxima renda / Mais pra frente). "Sai
// da próxima renda" usa NextIncomeWindowSection (formato de decomposição
// diferente — cardAmount/externalAmount/otherAmount — não uma lista de
// items soltos). `muted` (item 30) reduz peso visual pra Mais pra frente —
// conhecimento, não urgência.
export default function ObligationBucket({ title, subtitle, items, total, emptyLabel, muted = false }) {
  if (items.length === 0) return null;

  return (
    <div className={`rounded-card p-6 ${muted ? "bg-surface-1/60" : "bg-surface-1"}`}>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-label text-text-muted">{title}</h2>
        {total != null && <span className={`tabular text-sm font-medium ${muted ? "text-text-secondary" : "text-text-primary"}`}>{formatMoney(total)}</span>}
      </div>
      {subtitle && <p className="text-caption text-text-muted mb-3">{subtitle}</p>}

      <div className="divide-y divide-border-subtle">
        {items.map((item, i) => {
          const label = obligationItemLabel(item);
          const date = obligationItemDate(item);
          const href = obligationItemHref(item);
          const classLabel = item.class ? OBLIGATION_CLASS_LABEL[item.class] : null;

          const content = (
            <div className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="text-text-secondary truncate">{label}</div>
                {date && (
                  <div className="text-caption text-text-muted">
                    {classLabel ? `${classLabel} · ` : ""}até {formatDate(date)}
                  </div>
                )}
              </div>
              <div className="tabular shrink-0 font-medium text-text-primary">{formatMoney(item.amount)}</div>
            </div>
          );

          return href ? (
            <Link key={i} href={href} className="focus-ring -mx-2 block rounded-control px-2 transition-colors hover:bg-surface-2/60">
              {content}
            </Link>
          ) : (
            <div key={i}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}
