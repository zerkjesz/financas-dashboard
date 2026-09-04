export default function IntelligenceSummary({ intelligence }) {
  if (!intelligence) return null;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface-2 p-4 h-full">
      <div className="flex items-center gap-2 mb-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="text-positive">
          <path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
        </svg>
        <span className="text-sm font-medium text-white">Resumo inteligente</span>
      </div>
      <ul className="space-y-1.5">
        {intelligence.summaryLines.map((line, i) => (
          <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed text-slate-300">
            <span className="mt-2 h-1 w-1 rounded-full bg-slate-500 shrink-0" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
