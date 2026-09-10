// Fase 5.6.2 — TELEGRAM INTENT SAFETY.
//
// Regressão do false-positive achado no smoke de cutover: a mensagem NÃO
// financeira `NORTE-PROD-VERIFY-231B329D` foi classificada como possível
// Expense de R$231 (o parser extraiu "231" de um token alfanumérico e o
// fallback do classificador assumia `expense` por default).
//
// A correção é CONCEITUAL, não um hardcode do challenge: (1) o extrator de
// valor descarta dígitos colados a letras (identificadores); (2) o
// classificador exige evidência POSITIVA de intenção financeira antes do
// fallback `expense` — sem isso -> `no_financial_intent`; (3) parseTransaction
// devolve null pra `no_financial_intent` -> o bot responde help neutro, ZERO
// PendingBotMessage.
//
// Este teste NÃO toca banco — só as libs puras de parsing.
//   node scripts/test-telegram-intent-safety.mjs
import assert from "node:assert/strict";
import { classifyIntent } from "../lib/intentClassifier.js";
import { extractAmount } from "../lib/amountExtractor.js";
import { parseTransaction } from "../lib/parseTransaction.js";

let pass = 0, fail = 0;
function check(cond, label, extra = "") {
  if (cond) { pass++; console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`); }
}

// ============================================================================
// FALSE POSITIVE CORPUS (item 7) — texto NÃO financeiro que contém dígitos.
// Cada um DEVE: classifyIntent != expense/income/transfer/... financeiro
// resolvível E parseTransaction() === null (nenhum candidato, nenhum
// PendingBotMessage financeiro).
// ============================================================================
const NON_FINANCIAL = [
  // challenge/token (o caso original + variações)
  "NORTE-PROD-VERIFY-231B329D",
  "NORTE-PROD-VERIFY-A1B2C3",
  "NORTE-PROD-VERIFY-9X8Y7Z6",
  // código / pedido
  "pedido ABC-1234 chegou?",
  "meu pedido 5567 foi enviado",
  "rastreio BR123456789BR",
  // data
  "dia 24 eu recebo?",
  "nos vemos dia 15",
  // hora
  "reuniao 14:30",
  "call as 9h30",
  // percentual
  "meta bateu 80%?",
  "desconto de 15% no site",
  // versão
  "versao 5.6.2",
  "atualizei pro app 12.4.1",
  // telefone-like
  "11 98765 4321",
  "meu numero e 21 99887 6655",
  // placa / modelo
  "produto X200",
  "comprar o modelo? ainda nao, so o X200",
  // UUID-like
  "a1b2c3d4-1234-5678-90ab-cdef12345678",
  // parcelamento como pergunta sem declaração de compra
  "posso parcelar em 3x?",
  "da pra dividir em 10 vezes?",
];

console.log("--- FALSE POSITIVE CORPUS: zero candidato financeiro ---\n");
for (const text of NON_FINANCIAL) {
  const parsed = await parseTransaction(text);
  check(parsed === null, `"${text}" -> parseTransaction() === null (zero candidato/PendingBotMessage)`,
    parsed ? `VAZOU: intent=${parsed.intent} amount=${parsed.data?.amount} needsConfirmation=${parsed.needsConfirmation}` : "");
}

// ============================================================================
// TRUE POSITIVE CORPUS (item 8) — a correção NÃO pode quebrar lançamentos
// legítimos. Continuam reconhecidos com o mesmo valor.
// ============================================================================
const FINANCIAL = [
  ["gastei 35 no almoco", "expense", 35],
  ["paguei 120 de gasolina", "expense", 120],
  ["recebi 500", "income", 500],
  ["comprei por 200 no cartao", "expense", 200],
  ["gastei 80", "expense", 80],
  ["gastei 80 ontem", "expense", 80],
  ["transferi 100 pra o pix", "transfer", 100],
  ["fatura 900", "expense", 900],
  ["meu saldo e 800", "balance_adjustment", 800],
  ["R$ 1.200,00 no mercado", "expense", 1200],
  ["50 reais de uber", "expense", 50],
  ["torrei 300 numa jaqueta", "expense", 300],
  ["custou 45,90", "expense", 45.9],
];

console.log("\n--- TRUE POSITIVE CORPUS: continuam reconhecidos ---\n");
for (const [text, expectedIntent, expectedAmount] of FINANCIAL) {
  const parsed = await parseTransaction(text);
  check(
    parsed && parsed.intent === expectedIntent && Number(parsed.data.amount) === expectedAmount,
    `"${text}" -> ${expectedIntent} amount=${expectedAmount}`,
    parsed ? `got intent=${parsed.intent} amount=${parsed.data.amount}` : "got null"
  );
}

// ============================================================================
// AMOUNT EXTRACTOR — dígito colado a letra nunca vira valor
// ============================================================================
console.log("\n--- extractAmount: identificador != valor ---\n");
check(extractAmount("NORTE-PROD-VERIFY-231B329D").amount === null, "digito colado em token alfanumerico -> amount null");
check(extractAmount("modelo X200").amount === null, "X200 -> amount null");
check(extractAmount("rastreio BR123456789BR").amount === null, "BR123...BR -> amount null");
check(extractAmount("gastei 50 no mercado").amount === 50, "numero isolado -> ainda extrai (50)");
check(extractAmount("custou R$ 200").amount === 200, "R$ 200 -> extrai 200");
check(extractAmount("paguei 50reais").amount === 50, "50reais (colado mas com contexto de moeda) -> ainda extrai 50");

// ============================================================================
// AMBIGUITY SAFETY (item 6) — números sem intenção clara nunca viram fato
// ============================================================================
console.log("\n--- ambiguity safety: no_financial_intent ---\n");
check(classifyIntent("NORTE-PROD-VERIFY-231B329D").intent === "no_financial_intent", "challenge -> no_financial_intent");
check(classifyIntent("versao 5.6.2").intent === "no_financial_intent", "versao -> no_financial_intent");
check(classifyIntent("reuniao 14:30").intent === "no_financial_intent", "hora -> no_financial_intent");

// ============================================================================
// READ INTENTS (item 10) — perguntas continuam READ, sem PendingBotMessage
// ============================================================================
console.log("\n--- read intents preservados ---\n");
for (const q of ["quanto tenho?", "quanto posso gastar?", "quanto tenho de vale?", "como eu to?"]) {
  const ci = classifyIntent(q);
  check(ci.intent.startsWith("read_"), `"${q}" -> ${ci.intent} (READ)`);
  const parsed = await parseTransaction(q);
  check(parsed === null || !parsed.needsConfirmation, `"${q}" -> nenhum PendingBotMessage financeiro`, parsed ? `intent=${parsed.intent}` : "null");
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail > 0 ? 1 : 0);
