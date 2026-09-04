import { getCurrentFinancialCycle } from "./financialCycle.js";

// Fase 4.0, item 5 — estrutura pura de período financeiro. Objetivo: UM ponto
// central pra "que intervalo de datas isso cobre", em vez de cada tela/lib
// reimplementar o próprio recorte de datas (que é exatamente o problema que gerou
// P1-4/P1-5 na auditoria original — filtro de mês local no componente errado, "top
// gastos" sem recorte nenhum). Nesta fase só CURRENT_CYCLE tem implementação real
// — os outros tipos existem como vocabulário/contrato, não implementação, e
// lançam erro explícito se alguém tentar usá-los antes de existirem de verdade.
// Nenhuma UI/filtro é ligado a isto ainda (Fase 4.0, item 5).
export const FINANCIAL_PERIOD_TYPES = Object.freeze([
  "CURRENT_CYCLE",
  "CALENDAR_MONTH",
  "LAST_30_DAYS",
  "LAST_90_DAYS",
  "CUSTOM",
]);

// Resolve um FINANCIAL_PERIOD_TYPE pra um intervalo concreto { start, end }
// (ambos inclusive, mesma convenção de lib/financialCycle.js).
export function resolveFinancialPeriod(type, { settings, now = new Date(), custom } = {}) {
  switch (type) {
    case "CURRENT_CYCLE":
      if (!settings) throw new Error("CURRENT_CYCLE requer { settings } (AppSettings)");
      return getCurrentFinancialCycle(settings, now);
    case "CUSTOM":
      if (!custom?.start || !custom?.end) throw new Error("CUSTOM requer { custom: { start, end } }");
      return { start: custom.start, end: custom.end };
    case "CALENDAR_MONTH":
    case "LAST_30_DAYS":
    case "LAST_90_DAYS":
      throw new Error(
        `FINANCIAL_PERIOD_TYPE "${type}" ainda não implementado — Fase 4.0 só implementa CURRENT_CYCLE de verdade (ver lib/financialPeriod.js).`
      );
    default:
      throw new Error(`FINANCIAL_PERIOD_TYPE desconhecido: ${JSON.stringify(type)}`);
  }
}
