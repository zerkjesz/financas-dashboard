import { NextResponse } from "next/server";
import { deepSerializeMoney } from "@/lib/money";
import { simulateFinancialScenario, SIMULATION_SCENARIO_TYPE, SimulationInputError } from "@/lib/simulation/financialSimulator";
import { buildItauModel } from "@/lib/cardsItau";
import { evaluateCardCapacity } from "@/lib/cardsItauPure";

// Fase 5.3E — /api/simulate. COMPUTE-ONLY: chama simulateFinancialScenario
// (100% leitura + overlay em memória, nunca escreve nada) e devolve o
// resultado serializado. Protegido pelo middleware.js igual a toda
// app/api/** (sessão web + checagem de origem/CSRF em mutação — POST aqui é
// só o VERBO HTTP; nenhum dado real é alterado, ver zeroWriteProof no corpo
// da resposta). Nenhuma validação de negócio nova é feita aqui além do
// parsing do corpo — toda validação de valor/limite/parcela vive em
// lib/simulation/financialSimulator.js (SimulationInputError), reaproveitada
// tal como está.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "corpo da requisição precisa ser JSON válido" }, { status: 400 });
  }

  const { type, ...rest } = body || {};
  if (!type || !SIMULATION_SCENARIO_TYPE[type]) {
    return NextResponse.json(
      { error: `scenario.type inválido ou ausente. Valores aceitos: ${Object.values(SIMULATION_SCENARIO_TYPE).join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await simulateFinancialScenario({ scenario: { type, ...rest } });
    // Fase 10 — o MESMO julgamento de limite da área /cartoes (limite disponível NÃO é autoritativo: faixa estimada +
    // teto certo). Aditivo: os campos antigos (cardFeasibility etc.) seguem intactos; o orçamento já é idêntico.
    if (result.cardFeasibility) {
      try {
        const itau = await buildItauModel({ cardId: result.cardFeasibility.cardId });
        if (itau) result.cardCapacity = evaluateCardCapacity(itau.limit, Number(result.cardFeasibility.totalAmount.toString()));
      } catch (e) {
        console.error("[api/simulate] capacidade do limite indisponível:", e.message);
      }
    }
    return NextResponse.json(deepSerializeMoney(result));
  } catch (err) {
    if (err instanceof SimulationInputError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error("[api/simulate] erro inesperado:", err);
    return NextResponse.json({ error: "erro interno ao simular o cenário" }, { status: 500 });
  }
}
