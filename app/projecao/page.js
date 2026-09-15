"use client";

import { useEffect, useState } from "react";
import PageContainer from "../components/ui/PageContainer.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import FlowCheckpoints from "../components/flow/FlowCheckpoints.jsx";
import FlowEventList from "../components/flow/FlowEventList.jsx";
import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — rota renomeada de /fluxo pra /projecao (nome
// final do design aprovado — lib/navConfig.js já aponta pra cá). Mesma
// fonte de dados exclusiva de sempre (/api/cash-flow, lib/financialProjection.js
// V2) — zero mudança de fetch/cálculo, só a apresentação.
//
// O mock aprovado (Norte-standalone-src.html) NÃO tem gráfico de linha: é
// uma lista vertical de eventos discretos num único card branco (ver
// FlowEventList.jsx). O antigo FlowChart.jsx (SVG de linha custom) foi
// RETIRADO — não é mais importado em lugar nenhum do produto — em favor
// dessa lista, que já mostra a mesma trajetória (mesmos pontos, mesmo
// saldo por evento) sem depender de um gráfico.
//
// Range selector: o mock pede EXATAMENTE 3 pills ("30 dias"/"60 dias"/
// "90 dias", default 30). O código antigo tinha 5 opções (7/30/60/90/180).
// Decisão: dropar 7d e 180d pra bater com o design aprovado (é um freeze,
// não uma extensão de escopo) — ver relatório final.
const HORIZON_OPTIONS = [30, 60, 90];

export default function ProjecaoPage() {
  const [horizonDays, setHorizonDays] = useState(30);
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
          <div className="text-eyebrow text-text-muted mb-1.5">Projeção</div>
          <h1 className="text-page-title text-text-primary">O caminho do seu dinheiro</h1>
        </div>
        <div className="flex gap-1 rounded-control bg-chip-bg p-1">
          {HORIZON_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setHorizonDays(d)}
              className={`focus-ring inline-flex items-center justify-center rounded-control px-3 py-2 text-sm font-medium transition-colors cursor-pointer pointer-coarse:min-h-11 ${
                horizonDays === d ? "bg-ink text-white" : "text-text-secondary hover:bg-surface-3"
              }`}
            >
              {d} dias
            </button>
          ))}
        </div>
      </header>

      {loading || !projection ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-4">
          <FlowCheckpoints checkpoints={projection.checkpoints} horizonDays={projection.horizonDays} />

          {projection.riskExposure && (Number(projection.riskExposure.expectedRiskExposure) > 0 || Number(projection.riskExposure.maxRiskExposure) > 0) && (
            <div className="rounded-card border border-dashed border-warning/25 bg-warning-bg p-6">
              <h2 className="text-eyebrow text-warning-text mb-2">Exposição a risco (não está na trajetória acima)</h2>
              <p className="text-caption text-warning-text mb-1">
                esperado {formatMoney(projection.riskExposure.expectedRiskExposure)} · máximo {formatMoney(projection.riskExposure.maxRiskExposure)}
              </p>
              {projection.contingencyUndated && projection.contingencyUndated.length > 0 && (
                <p className="text-caption text-warning-text">
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
