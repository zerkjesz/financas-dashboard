import { ArrowRight } from "lucide-react";
import { formatMoney } from "@/lib/formatMoney";

const CHECKPOINTS = [
  { key: "day30", label: "30 dias" },
  { key: "day60", label: "60 dias" },
  { key: "day90", label: "90 dias" },
];

// Fase 5.4C.1, item 22 — "sentido de tempo/progressão" sem chart library.
// BUG REAL corrigido nesta fase (achado ao vivo em 390px): a 1ª versão
// (flex-row fixo + setas) cortava o valor de 90 dias — 3 colunas + 2 ícones
// de seta não cabiam num container de ~360px com valores de 12+ caracteres.
// Corrigido com o MESMO padrão "rail" de PhysicalMoneyContext.jsx (rail
// divide-y empilhado no mobile, divide-x lado a lado a partir de `sm`) —
// zero overflow garantido (cada checkpoint recebe largura total quando
// empilhado) e reforça consistência visual entre os dois "rails" da Home.
// A seta (sequência temporal) aparece só a partir de `sm`, onde há espaço.
export default function ProjectionSummary({ projectionSummary }) {
  if (!projectionSummary) return null;
  const { base, stress } = projectionSummary;

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">Como fico</h2>
      <div className="flex flex-col divide-y divide-border-subtle sm:flex-row sm:items-center sm:divide-x sm:divide-y-0">
        {CHECKPOINTS.map(({ key, label }, i) => {
          const value = base[key];
          const stressValue = stress[key];
          const stressCrossesZero = stressValue < 0;
          return (
            <div key={key} className="flex items-center gap-2 py-3 first:pt-0 last:pb-0 sm:flex-1 sm:py-0">
              <div className="min-w-0 sm:px-4 sm:first:pl-0 sm:last:pr-0">
                <div className="text-caption text-text-muted mb-1">{label}</div>
                <div className={`tabular text-base font-semibold ${value < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(value)}</div>
                {stressCrossesZero && <div className="text-caption text-warning mt-0.5">stress: {formatMoney(stressValue)}</div>}
              </div>
              {i < CHECKPOINTS.length - 1 && <ArrowRight className="ml-auto hidden h-3.5 w-3.5 shrink-0 text-border-strong sm:block" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
