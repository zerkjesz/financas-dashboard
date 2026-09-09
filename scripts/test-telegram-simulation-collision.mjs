// Fase 5.3E, item 28 — SIMULATION vs READ vs WRITE collision matrix. Puro,
// sem banco — só lib/intentClassifier.js:classifyIntent. Fixtures 100%
// fictícias (frases genéricas, nenhum dado pessoal real).
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

console.log("--- Fase 5.3E: Simulation Collision Matrix ---\n");

const CASES = [
  // [phrase, expectedIntent, expectedExtra?]
  // ---- SIMULATION deve disparar ----
  ["posso gastar 500?", "simulate_cash_expense", { amount: 500 }],
  ["posso gastar 500", "simulate_cash_expense", { amount: 500 }],
  ["consigo gastar 300 reais?", "simulate_cash_expense", { amount: 300 }],
  ["e se eu gastar 500?", "simulate_cash_expense", { amount: 500 }],
  ["e se eu comprar 1200 no cartão?", "simulate_card_purchase_single", { amount: 1200 }],
  ["e se eu comprar 1200 reais no cartao", "simulate_card_purchase_single", { amount: 1200 }],
  ["e se eu parcelar 1200 em 6x?", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],
  ["e se eu comprar 1200 no cartao em 6x?", "simulate_card_purchase_installments", { amount: 1200, installmentCount: 6 }],
  ["se a reforma ficar 2000 como eu fico?", "simulate_contingency", { contingencyQuery: "reforma", amount: 2000 }],
  ["se a reforma ficar como eu fico?", "simulate_contingency", { contingencyQuery: "reforma", amount: null }],
  ["se o carro ficar 5000 como fico?", "simulate_contingency", { contingencyQuery: "carro", amount: 5000 }],

  // ---- NUNCA podem virar simulação (WRITE reais, comportamento intacto) ----
  ["gastei 500", "expense"],
  ["gastei 500 no mercado", "expense"],
  ["comprei 1200 em 6x", "installment_purchase"],
  ["comprei um notebook, parcelei em 10x", "installment_purchase"],
  ["paguei 500 no pix", "expense"],
  ["recebi 500", "income"],
  ["transferi 100", "transfer"],
  ["saldo 800", "balance_adjustment"],

  // ---- NUNCA podem virar simulação (READ genérico, sem valor pra simular) ----
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
