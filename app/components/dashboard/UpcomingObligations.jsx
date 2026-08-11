import { formatMoney, formatDate } from "@/lib/formatMoney";

const STATUS_TONE = {
  pendente: "bg-white/10 text-white/60",
  atrasada: "bg-rose-500/10 text-rose-400",
  paga: "bg-emerald-500/10 text-emerald-400",
  prevista: "bg-sky-500/10 text-sky-400",
};

export default function UpcomingObligations({ items }) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Próximas obrigações</div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-white/80">{item.name}</span>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-white/50 text-xs">{formatDate(item.date)}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_TONE[item.status] || "bg-white/10 text-white/60"}`}>{item.status}</span>
              <span className={`font-medium w-24 text-right ${item.amount >= 0 ? "text-emerald-400" : ""}`}>
                {item.amount >= 0 ? "+" : "-"}{formatMoney(Math.abs(item.amount))}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
