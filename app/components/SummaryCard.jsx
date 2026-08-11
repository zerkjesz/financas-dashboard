import { formatMoney } from "@/lib/formatMoney";

export default function SummaryCard({ label, value, tone = "emerald" }) {
  const toneClass = tone === "emerald" ? "text-emerald-400" : tone === "rose" ? "text-rose-400" : "text-white/90";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs text-white/50 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${toneClass}`}>{formatMoney(value)}</div>
    </div>
  );
}
