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

  // Fase 5.3D.1, itens 2/3/15 — SEM "?" (a frase inteira do pedido) + com
  // acento + sem acento + variações de caixa/espaço, todas precisam
  // continuar classificando certo depois da correção de normalize().
  ["quanto tenho", true, "read_balance"],
  ["quanto eu tenho", true, "read_balance"],
  ["qual meu saldo", true, "read_balance"],
  ["como eu tô", true, "read_summary"],
  ["como eu to", true, "read_summary"],
  ["quanto posso gastar", true, "read_free_money"],
  ["quanto tenho livre", true, "read_free_money"],
  ["quanto é seguro gastar", true, "read_free_money"],
  ["quanto e seguro gastar", true, "read_free_money"],
  ["quanto ta minha fatura", true, "read_card"],
  ["quanto tá minha fatura", true, "read_card"],
  ["quanto tenho no caju", true, "read_va"],
  ["quanto tenho de vale", true, "read_va"],
  ["quando cai meu salario", true, "read_next_income"],
  ["quando cai meu salário", true, "read_next_income"],
  ["quanto do salario ta comprometido", true, "read_next_income"],
  ["quando minhas parcelas aliviam", true, "read_external_installments"],
  ["QUANTO TENHO", true, "read_balance"],
  ["  quanto tenho  ", true, "read_balance"],

  // item 3 — os MESMOS writes de sempre continuam WRITE mesmo sem "?" (nunca
  // tiveram "?" pra começo de conversa, mas reforçado explicitamente aqui
  // porque a ampliação da detecção de interrogação é exatamente o que
  // poderia ter quebrado isso).
  ["meu saldo e 800", false, "balance_adjustment"],
  ["gastei 80", false, "expense"],
  ["gastei 80 ontem", false, "expense"],
  ["recebi 500", false, "income"],
  ["transferi 100", false, "transfer"],
  ["fatura 900", false, "expense"],
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
