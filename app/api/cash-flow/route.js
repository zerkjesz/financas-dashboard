import { NextResponse } from "next/server";
import { buildBaseProjection, buildExpectedProjection, buildStressProjection } from "@/lib/financialProjection";
import { HORIZON_OPTIONS } from "@/lib/cashFlowProjection";
import { daysBetween } from "@/lib/recurringCycles";
import { deepSerializeMoney } from "@/lib/money";

// Fase 5.3B, item 15 — migrado de lib/cashFlowProjection.js (V1: só Bill +
// CardBill + RecurringRule income) pra lib/financialProjection.js (V2:
// também considera ConfirmedCommitment/ExternalInstallment — ver
// collectOutflowEvents). lib/cashFlowProjection.js NÃO foi deletado (ainda é
// consumido por lib/intelligence.js/lib/alerts.js — callers confirmados via
// grep antes desta mudança; LEGACY_DEPRECATION_PENDING até eles migrarem
// também).
//
// buildBaseProjection não tem os HORIZON_OPTIONS/shape exatos que
// FluxoCaixaView.jsx já espera (startingBalance/timeline/projectedBalance) —
// este adapter só RESHAPE o resultado (nomes de campo, `daysFromNow`
// calculado com o mesmo lib/recurringCycles.js:daysBetween que o V1 usava),
// nunca recalcula nenhum valor monetário.
// Fase 5.4D, item 76 — ADITIVO: `expected`/`stress` (mesmos helpers canônicos
// já usados por lib/financialEngine.js pra compor `financial.projectionSummary`
// no dashboard — nenhuma segunda engine, nenhuma fórmula nova) somados ao
// payload existente pra alimentar a página Fluxo (base/cenário
// esperado/cenário de pressão lado a lado). `timeline`/`startingBalance`/
// `projectedBalance`/`overdueExpectedIncome` continuam vindo 100% de BASE —
// zero mudança de comportamento pro shape antigo que FluxoCaixaView.jsx já lia
// (arquivo mantido, LEGACY_DEPRECATION_PENDING até a fase de remoção do V1).
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const daysParam = parseInt(searchParams.get("days"), 10);
  const horizonDays = HORIZON_OPTIONS.includes(daysParam) ? daysParam : 60;
  const now = new Date();

  const [base, expected, stress] = await Promise.all([
    buildBaseProjection({ horizonDays, now }),
    buildExpectedProjection({ horizonDays, now }),
    buildStressProjection({ horizonDays, now }),
  ]);
  const timeline = base.timeline.map((event) => ({ ...event, daysFromNow: daysBetween(now, event.date) }));
  const projectedBalance = timeline.length > 0 ? timeline[timeline.length - 1].balanceAfter : base.startingCash;

  const payload = {
    startingBalance: base.startingCash,
    horizonDays,
    timeline,
    projectedBalance,
    overdueExpectedIncome: base.overdueExpectedIncome,
    checkpoints: {
      base: base.checkpoints,
      expected: expected.checkpoints,
      stress: stress.checkpoints,
    },
    // Contingências não-datadas (sem expectedDate) — item 14 do V2: nunca
    // inventar data, só reportar separado. Idêntico pros dois cenários que as
    // usam (expected/stress têm o mesmo conjunto de contingências ativas).
    contingencyUndated: expected.contingencyUndated,
    riskExposure: { expectedRiskExposure: expected.expectedRiskExposure, maxRiskExposure: stress.maxRiskExposure },
  };
  return NextResponse.json(deepSerializeMoney(payload));
}
