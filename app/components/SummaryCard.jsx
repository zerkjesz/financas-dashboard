import { formatMoney } from "@/lib/formatMoney";

const TONE_CLASSES = {
  emerald: "text-positive",
  rose: "text-negative",
  white: "text-white",
};

export default function SummaryCard({ label, value, tone = "white" }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 h-full flex flex-col justify-center">
      <div className="text-xs text-muted mb-1.5">{label}</div>
      <div className={`tabular text-xl font-semibold ${TONE_CLASSES[tone] || TONE_CLASSES.white}`}>{formatMoney(value)}</div>
    </div>
  );
}
