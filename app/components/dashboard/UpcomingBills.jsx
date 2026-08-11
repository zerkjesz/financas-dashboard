import { formatMoney } from "@/lib/formatMoney";

export default function UpcomingBills({ bills }) {
  if (bills.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Próximas contas</div>
      <div className="space-y-1.5">
        {bills.map((bill, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-white/80">{bill.name}</span>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-white/50 text-xs">{new Date(bill.date).toLocaleDateString("pt-BR")}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${bill.status === "paga" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
                {bill.status}
              </span>
              <span className="font-medium w-24 text-right">{formatMoney(bill.amount)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
