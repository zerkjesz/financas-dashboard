// Fase 3.2 — helper central pra resolver `confidence` na fronteira de criação dos
// models aprovados (Income, Expense, Transfer, BalanceAdjustment, CardLimitUpdate,
// Purchase, Bill). `confidence` é independente de `source` (source = de onde o
// registro veio; confidence = o quanto confiamos que o valor está certo) — os dois
// nunca devem ser derivados um do outro aqui.
//
// Regra explícita (Fase 3.2, item 6): sem heurística automática complexa. O parser
// de texto/áudio do bot NÃO deve inventar ESTIMATED só porque a origem foi áudio —
// se nada for passado explicitamente, o default é sempre CONFIRMED, ponto.
// ESTIMATED/UNCERTAIN/CONFIRMED_BY_MEMORY só acontecem quando alguém (usuário, uma
// tela futura, um fluxo de reconciliação) passa isso explicitamente.

export const DATA_CONFIDENCE_VALUES = Object.freeze([
  "CONFIRMED",
  "CONFIRMED_BY_MEMORY",
  "ESTIMATED",
  "UNCERTAIN",
  "RECONCILIATION_ADJUSTMENT",
]);

export const DEFAULT_CONFIDENCE = "CONFIRMED";

// `explicit == null` (omitido/undefined/null) -> default. Qualquer outro valor
// precisa estar exatamente na lista permitida, senão lança erro (fronteira de API
// já traduz isso pra 400 — ver app/api/*/route.js).
export function resolveConfidence(explicit) {
  if (explicit == null) return DEFAULT_CONFIDENCE;
  if (!DATA_CONFIDENCE_VALUES.includes(explicit)) {
    throw new Error(
      `confidence inválida: ${JSON.stringify(explicit)}. Valores permitidos: ${DATA_CONFIDENCE_VALUES.join(", ")}`
    );
  }
  return explicit;
}

export function isValidConfidence(value) {
  return DATA_CONFIDENCE_VALUES.includes(value);
}
