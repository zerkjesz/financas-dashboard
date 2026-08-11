const LEVEL_TONE = {
  danger: "border-rose-500/30 bg-rose-500/[0.06] text-rose-300",
  warning: "border-amber-500/30 bg-amber-500/[0.06] text-amber-300",
  info: "border-sky-500/30 bg-sky-500/[0.06] text-sky-300",
};

export default function AlertsPanel({ alerts }) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="mb-6 space-y-2">
      {alerts.map((alert, i) => (
        <div key={i} className={`rounded-lg border px-3 py-2 text-sm ${LEVEL_TONE[alert.level] || LEVEL_TONE.info}`}>
          {alert.message}
        </div>
      ))}
    </div>
  );
}
