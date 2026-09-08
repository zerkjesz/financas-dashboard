import { NextResponse } from "next/server";
import { listExternalInstallmentPlans, computeExternalInstallmentRunoff } from "@/lib/externalInstallments";
import { deepSerializeMoney } from "@/lib/money";

// Fase 5.3B, item 12/27 — read-model endpoint (GET only, nenhuma mutation
// nova nesta fase, auth ainda pendente — ver relatório 5.3A §21). Os 9 planos
// ativos (e as 38 parcelas) estavam completamente invisíveis no produto antes
// desta fase (confirmado por grep na Fase 5.3A: zero importadores em app/).
export async function GET() {
  const plans = await listExternalInstallmentPlans({ status: "ACTIVE" });
  const runoff = computeExternalInstallmentRunoff(plans);
  return NextResponse.json(deepSerializeMoney({ plans, runoff }));
}
