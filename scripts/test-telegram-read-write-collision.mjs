// Fase 5.3D — READ/WRITE COLLISION MATRIX (item 30). Puro, sem banco/servidor
// — só lib/intentClassifier.js:classifyIntent. Fixtures 100% fictícias
// (frases genéricas, nenhum dado pessoal real).
import { classifyIntent } from "../lib/intentClassifier.js";
import { READ_INTENTS } from "../lib/telegramReads.js";

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

function isRead(phrase) {
  return READ_INTENTS.has(classifyIntent(phrase).intent);
}
function intentOf(phrase) {
  return classifyIntent(phrase).intent;
}

console.log("--- Fase 5.3D: Read/Write Collision Matrix ---\n");

const CASES = [
  // [phrase, expectedRead, expectedIntentIfKnown]
  ["saldo 800", false, "balance_adjustment"],
  ["meu saldo é 800", false, "balance_adjustment"],
  ["meu saldo no itau é 800 reais", false, "balance_adjustment"],
  ["qual meu saldo?", true, "read_balance"],
  ["quanto eu tenho?", true, "read_balance"],
  ["como tá meu saldo?", true, "read_balance"],
  ["quanto tá minha fatura?", true, "read_card"],
  ["quanto tenho de limite?", true, "read_card"],
  ["paguei minha fatura, 900 reais", false, "bill_payment"],
  ["tenho 1500 disponiveis no cartao", false, "limit_update"],
  ["quanto pago de parcelas?", true, "read_external_installments"],
  ["quando minhas parcelas aliviam?", true, "read_external_installments"],
  ["comprei um notebook, parcelei em 10x", false, "installment_purchase"],
  ["quanto tenho livre?", true, "read_free_money"],
  ["quanto posso gastar?", true, "read_free_money"],
  ["quanto tenho no caju?", true, "read_va"],
  ["quanto tenho de vale?", true, "read_va"],
  ["recebi meu vale alimentacao, 1300 reais", false, "income"],
  ["como eu to?", true, "read_summary"],
  ["me da um resumo", true, "read_summary"],
  ["quando cai meu salario?", true, "read_next_income"],
  ["recebi meu salario, 4900 reais", false, "income"],
  ["gastei 50 no mercado", false, "expense"],
];

for (const [phrase, expectedRead, expectedIntent] of CASES) {
  const read = isRead(phrase);
  const intent = intentOf(phrase);
  check(read === expectedRead, `"${phrase}" -> isRead=${read} (esperado ${expectedRead})`, `intent=${intent}`);
  if (expectedIntent) {
    check(intent === expectedIntent, `"${phrase}" -> intent="${intent}" (esperado "${expectedIntent}")`);
  }
}

// Garantia geral (item 30): NENHUM READ pode cair em mutation por
// precedência ruim — testado individualmente acima, reforçado aqui como
// invariante agregada.
const readCasesCount = CASES.filter(([, expectedRead]) => expectedRead).length;
const readCasesActuallyRead = CASES.filter(([phrase, expectedRead]) => expectedRead && isRead(phrase)).length;
check(readCasesCount === readCasesActuallyRead, "[invariante] todas as frases READ do matrix são classificadas como READ_*", `${readCasesActuallyRead}/${readCasesCount}`);

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
