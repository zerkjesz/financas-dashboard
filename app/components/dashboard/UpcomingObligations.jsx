import { formatMoney, formatDate } from "@/lib/formatMoney";

const STATUS_TONE = {
  pendente: "bg-surface-2 text-slate-300",
  atrasada: "bg-negative/15 text-negative",
  paga: "bg-positive/15 text-positive",
  prevista: "bg-info/15 text-info",
};

const KIND_ICON = {
  bill: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  card_bill: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 10h18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  income: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

export default function UpcomingObligations({ items }) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 mb-6">
      <div className="text-sm font-medium text-white mb-2">Próximas obrigações</div>
      <div className="divide-y divide-border">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-3 py-2.5 text-sm">
            <span className={`shrink-0 ${item.amount >= 0 ? "text-positive" : "text-muted"}`}>{KIND_ICON[item.kind]}</span>
            <span className="text-slate-200 truncate flex-1">{item.name}</span>
            <span className="text-muted text-xs shrink-0 hidden sm:inline">{formatDate(item.date)}</span>
            <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${STATUS_TONE[item.status] || STATUS_TONE.pendente}`}>{item.status}</span>
            <span className={`tabular font-medium w-24 text-right shrink-0 ${item.amount >= 0 ? "text-positive" : "text-white"}`}>
              {item.amount >= 0 ? "+" : "-"}{formatMoney(Math.abs(item.amount))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
