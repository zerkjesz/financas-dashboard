// ============================================================================
// Fase 5.4C — HOME PRESENTATION HELPERS. Puro presentation-derivation
// (sorting/top-N/copy selection) sobre o read model canônico já composto por
// lib/productFinancialSnapshot.js — NUNCA recomputa freeMoney/safeToSpend/
// status/obligation classification/projection aqui. Nenhuma função deste
// arquivo acessa o banco.
// ============================================================================

// Item 11 — motivo dominante: maior valor absoluto entre os itens que
// REALMENTE reduzem freeMoney hoje. `currentObligations.breakdown` (do read
// model) já vem restrito a INCURRED_LIABILITY + CURRENT_HORIZON_OBLIGATION —
// nunca inclui futureObligation/contingency/VA/card-limit/hipotético, então
// não precisa filtrar de novo aqui, só ordenar.
export function selectDominantReason(breakdown) {
  if (!breakdown || breakdown.length === 0) return null;
  return [...breakdown].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
}

// Fase 5.4A/5.4C, item 14 — taxonomia humana (nunca mostrar enum técnico).
export const OBLIGATION_CLASS_LABEL = {
  INCURRED_LIABILITY: "já gasto",
  CURRENT_HORIZON_OBLIGATION: "antes da próxima renda",
};

// Item 13 — label humana de um item de breakdown; item 21/16 — fatura de
// cartão nunca aparece como "CardBill", sempre com o nome do cartão.
export function obligationItemLabel(item) {
  if (item.type === "CardBill") return `Fatura ${item.cardName} (${item.cycleMonth})`;
  return item.description;
}

export function obligationItemDate(item) {
  return item.dueDate ?? item.dueAt ?? null;
}

// Item 13 — só card bill tem destino real hoje (/cartoes já existe);
// Compromissos ainda não existe como rota (isso é 5.4D) — nunca cria href
// fake pra uma página que não existe.
export function obligationItemHref(item) {
  return item.type === "CardBill" ? "/cartoes" : null;
}

// ============================================================================
// Item 7 — copy de status FACTUAL, nunca julgadora. Descreve TIMING (há mais
// compromisso do que dinheiro livre agora), nunca CARÁTER da pessoa.
// ============================================================================
export const STATUS_COPY = {
  TRANQUILO: {
    label: "Tranquilo",
    headline: "O que está confirmado cabe com folga no que é livre.",
  },
  ATENCAO: {
    label: "Atenção",
    headline: "Algo no cenário esperado merece acompanhar.",
  },
  APERTADO: {
    label: "Apertado",
    headline: "Há mais compromisso confirmado do que dinheiro livre disponível agora.",
  },
  CRITICO: {
    label: "Crítico",
    headline: "O caixa físico projetado fica negativo antes da próxima renda.",
  },
};

// Item 8 — freeMoney negativo precisa de legenda, nunca só o sinal.
export function freeMoneyLegend(freeMoney) {
  if (freeMoney == null) return null;
  return freeMoney < 0 ? "além do que está livre hoje" : null;
}

// Item 24 — CRÍTICO é o único status com banner permitido por padrão, e só
// quando existe o motivo estruturado real (nunca uma frase solta inventada
// aqui) — reaproveita `financial.liquidity.statusReasons`, já escrito por
// lib/financialStatus.js (a MESMA mensagem que qualquer outra superfície
// usaria), nunca uma segunda redação.
export function selectCriticalBannerReason(statusReasons) {
  if (!statusReasons) return null;
  return statusReasons.find((r) => r.code === "BASE_CASH_NEGATIVE_BEFORE_INCOME") ?? null;
}

// Item 32/43 — quando sugerir "simular antes de comprar": só em
// Apertado/Crítico, nunca como banner extra — é um CTA discreto dentro do
// hero (ver FinancialHero.jsx).
export function shouldSuggestSimulation(status) {
  return status === "APERTADO" || status === "CRITICO";
}
