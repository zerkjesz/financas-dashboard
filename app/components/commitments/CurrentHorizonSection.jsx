"use client";

import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { obligationItemLabel, obligationItemDate, obligationItemHref, OBLIGATION_CLASS_LABEL } from "@/lib/commitmentsPresentation";

// Fase 5.4D.1 — CORRIGIDO: "Já gasto" e "Antes da próxima renda" viviam em
// 2 cards `bg-surface-1` idênticos — nenhuma pista visual de que são,
// juntos, o "horizonte atual" (o que REALMENTE reduz dinheiro livre hoje —
// item 23/28 desta fase). Unificados num único bloco `surface-2` elevado
// (mesmo grau da Home hero) com 2 subseções internas — a hierarquia
// conceitual do próprio engine (INCURRED_LIABILITY + CURRENT_HORIZON_
// OBLIGATION = o horizonte atual) agora tem uma hierarquia VISUAL
// correspondente, em vez de 2 caixas soltas do mesmo peso.
export default function CurrentHorizonSection({ incurred, incurredTotal, dueBeforeIncome, dueBeforeIncomeTotal }) {
  if (incurred.length === 0 && dueBeforeIncome.length === 0) return null;
  const combinedTotal = Number(incurredTotal) + Number(dueBeforeIncomeTotal);

  return (
    <div className="rounded-card bg-surface-2 p-6 sm:p-7">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-label text-text-muted">Horizonte atual</h2>
        <span className="tabular text-metric-md text-text-primary">{formatMoney(combinedTotal)}</span>
      </div>
      <p className="text-caption text-text-muted mb-5">O que realmente reduz seu dinheiro livre agora — já aconteceu ou vence antes da próxima renda.</p>

      {incurred.length > 0 && (
        <Subsection title="Já gasto" total={incurredTotal} items={incurred} first />
      )}
      {dueBeforeIncome.length > 0 && (
        <Subsection title="Antes da próxima renda" total={dueBeforeIncomeTotal} items={dueBeforeIncome} />
      )}
    </div>
  );
}

function Subsection({ title, total, items, first = false }) {
  return (
    <div className={first ? "" : "mt-5 border-t border-border-subtle pt-5"}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-caption font-medium text-text-secondary">{title}</span>
        <span className="tabular text-sm font-medium text-text-primary">{formatMoney(total)}</span>
      </div>
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
            <Link key={i} href={href} className="focus-ring -mx-2 block rounded-control px-2 transition-colors hover:bg-surface-1/60">
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
