// ============================================================================
// Fase 5.4D — CARD PRESENTATION HELPERS. Mesmo padrão de lib/homePresentation.js
// (Fase 5.4C): pura derivação de apresentação sobre dados JÁ canônicos — NUNCA
// recalcula qual fatura é "a atual" (isso é 100% do engine, via
// getCardCycleForDate + getCardBillView — ver app/api/dashboard/route.js e
// app/api/cards/[id]/bills/route.js), nunca reimplementa
// usedLimit/totalLimit/availableLimit (lib/cards.js) nem o known-detail-gap
// (computeExpectedCardBillTotal, calculado no servidor). Este arquivo só
// agrupa/rotula o que já chegou pronto.
// ============================================================================

export const CARD_BILL_STATUS_LABEL = {
  open: "aberta",
  closed: "fechada",
  partially_paid: "paga parcial",
  paid: "paga",
};

// Badge variants (app/components/ui/Badge.jsx) — paid é o único estado que
// merece "positive" (dívida resolvida); os demais são informativos/neutros,
// nunca "danger" só por existir (uma fatura aberta não é um problema).
export const CARD_BILL_STATUS_BADGE_VARIANT = {
  open: "neutral",
  closed: "neutral",
  partially_paid: "warning",
  paid: "positive",
};

// Fase 5.4D, item 14 — CURRENT/NEXT/LATER em vez de uma grade de 10+ meses
// com o mesmo peso visual. `currentCycleMonth` vem de fora (a fatura
// "atual" já resolvida pelo engine, nunca re-derivada aqui por regra de
// saldo restante — essa regra já existe em lib/obligationClassifier.js e
// não deve ganhar uma segunda implementação client-side). Se
// `currentCycleMonth` não bater com nenhuma bill da lista (caso extremo,
// nunca visto em dado real), current fica null e tudo cai em `next`.
export function groupBillsByCycle(bills, currentCycleMonth) {
  const sorted = [...bills].sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const currentIdx = sorted.findIndex((b) => b.cycleMonth === currentCycleMonth);
  if (currentIdx === -1) {
    return { current: null, next: sorted.slice(0, 3), later: sorted.slice(3) };
  }
  const current = sorted[currentIdx];
  const after = sorted.slice(currentIdx + 1);
  const before = sorted.slice(0, currentIdx); // faturas passadas (paid/closed) — mostradas só dentro de "ver todas".
  return { current, next: after.slice(0, 3), later: [...after.slice(3), ...before].sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth)) };
}

// Fase 5.4D, itens 15/16 — KNOWN CARD DETAIL GAP. Copy humana pro caso em
// que o total confirmado (autoritativo, ver app/api/cards/[id]/bills/route.js)
// excede o que dá pra explicar com os lançamentos hoje persistidos. Nunca
// chama isso de "ajuste"/"despesa"/"lançamento" (item 16, explícito) — é
// só uma nota de transparência, não um valor que o produto está inventando.
export function detailGapLabel(bill) {
  if (!bill.hasDetailGap) return null;
  return `R$ ${Number(bill.undetailedAmount).toFixed(2).replace(".", ",")} ainda sem detalhamento individual`;
}

// Item 13 — proporção usado/total é legítima; cor nunca vem de um limiar
// inventado (ex: "> 80% = warning"). Só dois estados reais: dentro do
// limite (restricted — crédito nunca é riqueza, item 12) ou estourado de
// verdade (usedLimit > totalLimit, um FATO, não um threshold arbitrário).
export function creditUsageTone(usedLimit, totalLimit) {
  return Number(usedLimit) > Number(totalLimit) ? "danger" : "restricted";
}
