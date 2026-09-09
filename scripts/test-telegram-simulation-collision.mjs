// Fase 5.3E, item 28 / Fase 5.3E.1, item 11 — SIMULATION vs CLARIFICATION vs
// READ vs WRITE collision matrix. Puro, sem banco — só
// lib/intentClassifier.js:classifyIntent. Fixtures 100% fictícias (frases
// genéricas, nenhum dado pessoal real — "reforma"/"contingência"/"carro" são
// categorias genéricas, não nomes reais de nenhuma contingência do usuário).
import { classifyIntent } from "../lib/intentClassifier.js";

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

console.log("--- Fase 5.3E.1: Simulation + Clarification Collision Matrix ---\n");

const CASES = [
  // [phrase, expectedIntent, expectedExtra?]

  // ---- Fase 5.3E.1, item 1 — "comprar"/"passar" sem método explícito é
  // AMBÍGUO, nunca mais degrada silenciosamente pra cash ----
  ["posso comprar 1200", "clarify_payment_method", { amount: 1200 }],
  ["posso comprar 1200?", "clarify_payment_method", { amount: 1200 }],
  ["e se eu comprar 1200", "clarify_payment_method", { amount: 1200 }],
  ["e se eu comprar 1200?", "clarify_payment_method", { amount: 1200 }],
  ["se eu comprar isso por 900 como fico?", "clarify_payment_method", { amount: 900 }],
  ["e se eu passar 500?", "clarify_payment_method", { amount: 500 }],

  // ---- item 3 — "gastar"/"pagar" continuam SEMPRE cash, por definição ----
  ["posso gastar 500 agora", "simulate_cash_expense", { amount: 500 }],
  ["posso gastar 500 no pix", "simulate_cash_expense", { amount: 500 }],
  ["posso gastar 500?", "simulate_cash_expense", { amount: 500 }],
  ["consigo gastar 300 reais?", "simulate_cash_expense", { amount: 300 }],
  ["e se eu gastar 500?", "simulate_cash_expense", { amount: 500 }],
  ["e se eu pagar 500 agora?", "simulate_cash_expense", { amount: 500 }],

  // ---- item 4 — cartão/crédito EXPLÍCITO nunca é ambíguo ----
  ["posso comprar 1200 no cartão", "simulate_card_purchase_single", { amount: 1200 }],
  ["posso comprar 1200 no cartão?", "simulate_card_purchase_single", { amount: 1200 }],
  ["e se eu comprar 1200 no cartão?", "simulate_card_purchase_single", { amount: 1200 }],
  ["e se eu passar 1200 no cartão?", "simulate_card_purchase_single", { amount: 1200 }],
  ["e se eu comprar 1200 no crédito?", "simulate_card_purchase_single", { amount: 1200 }],

  // ---- item 5 — parcelamento explícito nunca pede método (já é cartão por
  // definição) ----
  ["posso parcelar 1200 em 6x", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],
  ["e se eu parcelar 1200 em 6x?", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],
  ["posso comprar 1200 em 6x no cartão?", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],
  ["e se eu passar 1200 em 6 vezes?", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],

  // ---- WRITE reais, comportamento intacto (nunca viram simulação/clarificação) ----
  ["comprei 1200", "expense"],
  ["comprei 1200 em 6x", "installment_purchase"],
  ["gastei 500", "expense"],
  ["gastei 500 no mercado", "expense"],
  ["paguei 500 no pix", "expense"],
  ["recebi 500", "income"],
  ["transferi 100", "transfer"],
  ["saldo 800", "balance_adjustment"],

  // ---- item 6/7 — contingência SEM timing explícito -> ambíguo (o handler
  // decide perguntar; aqui só confirmamos que o classifier NUNCA marca isso
  // como timingExplicit="NOW" silenciosamente) ----
  ["se a reforma ficar 2000 como eu fico?", "simulate_contingency", { contingencyQuery: "reforma", amount: 2000, timingExplicit: null }],
  ["se a contingência ficar 2000", "simulate_contingency", { contingencyQuery: "contingencia", amount: 2000, timingExplicit: null }],
  ["se o carro ficar 5000 como fico?", "simulate_contingency", { contingencyQuery: "carro", amount: 5000, timingExplicit: null }],

  // ---- item 8 — contingência COM timing explícito -> nunca pergunta ----
  ["se eu pagar 2000 da reforma agora, como fico?", "simulate_contingency", { contingencyQuery: "reforma", amount: 2000, timingExplicit: "NOW" }],
  ["se eu pagar 2000 da contingência agora", "simulate_contingency", { contingencyQuery: "contingencia", amount: 2000, timingExplicit: "NOW" }],
  ["se a reforma ficar 2000 agora como eu fico?", "simulate_contingency", { contingencyQuery: "reforma", amount: 2000, timingExplicit: "NOW" }],

  // ---- READ genérico, sem valor pra simular -> nunca vira simulação ----
  ["quanto posso gastar?", "read_free_money"],
  ["quanto posso gastar", "read_free_money"],
  ["quanto tenho livre?", "read_free_money"],
  ["quanto tá minha fatura?", "read_card"],
];

for (const [phrase, expectedIntent, expectedExtra] of CASES) {
  const result = classifyIntent(phrase);
  check(result.intent === expectedIntent, `"${phrase}" -> intent="${result.intent}" (esperado "${expectedIntent}")`);
  if (expectedExtra) {
    for (const [key, value] of Object.entries(expectedExtra)) {
      check(result[key] === value, `"${phrase}" -> ${key}=${JSON.stringify(result[key])} (esperado ${JSON.stringify(value)})`);
    }
  }
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
