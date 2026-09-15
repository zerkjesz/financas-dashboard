import Link from "next/link";
import { ArrowRight, Banknote, CreditCard, Receipt, Repeat } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — "Chega e sai nos próximos dias": os itens mais
// próximos de `data.upcomingObligations` (lib/upcomingObligations.js, real,
// já ordenado/deduplicado) — nenhum evento inventado. Link "Ver projeção"
// leva pra /projecao, que tem a lista completa.
const KIND_ICON = { income: Banknote, card_bill: CreditCard, bill: Receipt };

export default function UpcomingEventsCard({ items }) {
  const top = [...(items || [])].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 5);

  return (
    <div className="rounded-card bg-surface shadow-card p-7">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-card-title text-text-primary">Chega e sai nos próximos dias</h2>
        <Link href="/projecao" className="focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
          Ver projeção
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {top.length === 0 ? (
        <p className="text-body text-text-muted">Nada previsto nos próximos dias.</p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {top.map((item, i) => {
            const Icon = KIND_ICON[item.kind] ?? Repeat;
            const isIncome = item.amount > 0;
            return (
              <div key={i} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="w-[4.75rem] shrink-0 text-eyebrow text-text-muted">{formatDate(item.date)}</span>
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile ${isIncome ? "bg-ink text-accent" : item.kind === "card_bill" ? "bg-warning-bg text-warning-text" : "bg-chip-bg text-text-secondary"}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text-primary">{item.name}</div>
                  <div className="text-caption text-text-muted capitalize">{item.status}</div>
                </div>
                <span className={`tabular shrink-0 text-sm font-semibold ${isIncome ? "text-positive" : "text-text-body"}`}>{formatMoney(item.amount)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
