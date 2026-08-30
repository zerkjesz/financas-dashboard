const LEVEL_STYLE = {
  danger: { classes: "border-negative/30 bg-negative/[0.07] text-red-200", icon: "text-negative" },
  warning: { classes: "border-warning/30 bg-warning/[0.07] text-amber-100", icon: "text-warning" },
  info: { classes: "border-info/30 bg-info/[0.07] text-sky-100", icon: "text-info" },
};

function AlertIcon({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </svg>
  );
}

export default function AlertsPanel({ alerts }) {
  if (!alerts || alerts.length === 0) return null;

  return (
    <div className="mb-6 space-y-2">
      {alerts.map((alert, i) => {
        const style = LEVEL_STYLE[alert.level] || LEVEL_STYLE.info;
        return (
          <div key={i} className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${style.classes}`}>
            <AlertIcon className={`shrink-0 mt-0.5 ${style.icon}`} />
            <span>{alert.message}</span>
          </div>
        );
      })}
    </div>
  );
}
