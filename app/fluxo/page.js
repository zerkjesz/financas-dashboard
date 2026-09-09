"use client";

import { useEffect, useState } from "react";
import PageContainer from "../components/ui/PageContainer.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import FlowChart from "../components/flow/FlowChart.jsx";
import FlowCheckpoints from "../components/flow/FlowCheckpoints.jsx";
import FlowEventList from "../components/flow/FlowEventList.jsx";
import { formatMoney } from "@/lib/formatMoney";

const HORIZON_OPTIONS = [7, 30, 60, 90, 180];

// Fase 5.4D, item 34 — FLUXO responde só "como meu caixa evolui daqui pra
// frente?" — explora projeção, NÃO gerencia Bill/Commitment (isso é
// Compromissos). Item 35 — fonte é EXCLUSIVAMENTE /api/cash-flow, que já
// usa lib/financialProjection.js V2 (buildBaseProjection/Expected/Stress) —
// zero consumer novo de lib/cashFlowProjection.js V1.
export default function FluxoPage() {
  const [horizonDays, setHorizonDays] = useState(90);
  const [projection, setProjection] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/cash-flow?days=${horizonDays}`)
      .then((r) => r.json())
      .then((data) => {
        setProjection(data);
        setLoading(false);
      });
  }, [horizonDays]);

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-page-title text-text-primary">Fluxo</h1>
          <p className="text-caption text-text-muted">Como seu caixa evolui daqui pra frente — trajetória, não gerenciamento</p>
        </div>
        {/* Fase 5.4E.1.1 — MEDIDO ao vivo: px-3 py-1.5 dava 34px de hit
            target real. `pointer-coarse:min-h-11` só em touch. */}
        <div className="flex gap-1">
          {HORIZON_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHorizonDays(d)}
              className={`focus-ring inline-flex items-center justify-center rounded-control px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer pointer-coarse:min-h-11 ${
                horizonDays === d ? "bg-surface-2 text-text-primary border border-border-strong" : "text-text-muted hover:text-text-primary hover:bg-surface-1"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {loading || !projection ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-4">
          <div className="rounded-card bg-surface-2 p-6 sm:p-7">
            <div className="text-label text-text-muted mb-1">Trajetória de caixa (base)</div>
            <p className="text-caption text-text-muted mb-4">Só o que já é conhecido — receita/fatura/conta/compromisso confirmado. Nunca inclui risco em aberto.</p>
            <FlowChart startingBalance={projection.startingBalance} timeline={projection.timeline} horizonDays={projection.horizonDays} projectedBalance={projection.projectedBalance} />
          </div>

          <FlowCheckpoints checkpoints={projection.checkpoints} horizonDays={projection.horizonDays} />

          {projection.riskExposure && (Number(projection.riskExposure.expectedRiskExposure) > 0 || Number(projection.riskExposure.maxRiskExposure) > 0) && (
            <div className="rounded-card border border-dashed border-warning/30 bg-surface-1 p-6">
              <h2 className="text-label text-text-muted mb-2">Exposição a risco (não está na trajetória acima)</h2>
              <p className="text-caption text-text-muted mb-1">
                esperado {formatMoney(projection.riskExposure.expectedRiskExposure)} · máximo {formatMoney(projection.riskExposure.maxRiskExposure)}
              </p>
              {projection.contingencyUndated && projection.contingencyUndated.length > 0 && (
                <p className="text-caption text-text-muted">
                  sem data prevista: {projection.contingencyUndated.map((c) => c.description).join(", ")} — por isso não aparece como ponto na trajetória.
                </p>
              )}
            </div>
          )}

          <FlowEventList startingBalance={projection.startingBalance} timeline={projection.timeline} horizonDays={projection.horizonDays} projectedBalance={projection.projectedBalance} />
        </div>
      )}
    </PageContainer>
  );
}
