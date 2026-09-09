import { formatMoney } from "@/lib/formatMoney";

const CHECKPOINTS = [
  { key: "day30", label: "30 dias" },
  { key: "day60", label: "60 dias" },
  { key: "day90", label: "90 dias" },
];

// Fase 5.4C, itens 30/31 — resumo compacto de 30/60/90 usando SOMENTE
// `financial.projectionSummary` (recorte do motor V2, lib/financialProjection.js
// — ver lib/productFinancialSnapshot.js). Sem biblioteca de gráfico: 3
// valores discretos (BASE, o número principal) + aviso quando STRESS cruza
// zero — nunca reduz a um único número escondendo o cenário de risco.
export default function ProjectionSummary({ projectionSummary }) {
  if (!projectionSummary) return null;
  const { base, stress } = projectionSummary;

  return (
    <div className="rounded-card border border-border-subtle bg-surface-1 p-5">
      <h2 className="text-section-title text-text-primary mb-3">Como fico</h2>
      <div className="grid grid-cols-3 gap-3">
        {CHECKPOINTS.map(({ key, label }) => {
          const value = base[key];
          const stressValue = stress[key];
          const stressCrossesZero = stressValue < 0;
          return (
            <div key={key}>
              <div className="text-label text-text-muted mb-1">{label}</div>
              <div className={`tabular text-base font-semibold ${value < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(value)}</div>
              {stressCrossesZero && <div className="text-caption text-warning mt-0.5">stress: {formatMoney(stressValue)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
