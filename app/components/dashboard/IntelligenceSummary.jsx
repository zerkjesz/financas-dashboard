export default function IntelligenceSummary({ intelligence }) {
  if (!intelligence) return null;

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4 mb-6">
      <div className="text-sm text-emerald-400 mb-2">Resumo inteligente</div>
      <ul className="space-y-1 text-sm text-white/80">
        {intelligence.summaryLines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
