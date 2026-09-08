import { NextResponse } from "next/server";
import { buildBaseProjection } from "@/lib/financialProjection";
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
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const daysParam = parseInt(searchParams.get("days"), 10);
  const horizonDays = HORIZON_OPTIONS.includes(daysParam) ? daysParam : 60;
  const now = new Date();

  const base = await buildBaseProjection({ horizonDays, now });
  const timeline = base.timeline.map((event) => ({ ...event, daysFromNow: daysBetween(now, event.date) }));
  const projectedBalance = timeline.length > 0 ? timeline[timeline.length - 1].balanceAfter : base.startingCash;

  const payload = {
    startingBalance: base.startingCash,
    horizonDays,
    timeline,
    projectedBalance,
    // Renda esperada já vencida e ainda não lançada (Fase 4.1) — informativo,
    // nunca injetada na timeline com data passada. Campo NOVO, aditivo — não
    // quebra FluxoCaixaView.jsx, que simplesmente ainda não o lê.
    overdueExpectedIncome: base.overdueExpectedIncome,
  };
  return NextResponse.json(deepSerializeMoney(payload));
}
