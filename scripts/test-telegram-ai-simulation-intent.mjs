// Fase 7.0.3b — testes MOCK de generalização do SIMULATE_PURCHASE (item 6 do
// pedido: "simulation intent tests", offline, zero chamada Groq). O caso 26
// do corpus ("se eu comprar um negócio de 500 em 5x dá ruim?") voltou
// NO_FINANCIAL_INTENT da Groq real — o ajuste de prompt (promptBuilder.js)
// tenta generalizar o reconhecimento pra várias formulações de pergunta
// hipotética de compra, não só a frase exata do corpus.
//
// O que este arquivo PROVA (com MockProvider, fixture por frase — nunca
// chama a Groq): SE o modelo devolver um plano SIMULATE_PURCHASE pra cada
// uma dessas 5+ formulações diferentes, o pipeline (schema Zod + roteamento
// em pipeline.js) trata isso corretamente — nunca como compra real, sempre
// via o motor de simulação determinístico (nunca o LLM calculando/narrando
// números), e SEMPRE zero escrita financeira.
//
// O que este arquivo NÃO PROVA (e não pode provar sem gastar uma chamada
// real): que a Groq de fato reconhece cada uma dessas frases como
// SIMULATE_PURCHASE. Isso é exatamente o que o rerun real (S1/S2/S3 + caso
// 26) verifica depois deste gate offline passar.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { createMockProvider } from "../lib/telegramAi/llmProvider.js";
import { handleConversationalMessage, PIPELINE_RESULT_KIND } from "../lib/telegramAi/pipeline.js";

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment", "cardLimitUpdate", "purchase",
  "installment", "cardBill", "recurringRule", "bill", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency", "receivable",
];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

function simulatePurchasePlan({ amount, installments, paymentMethod }) {
  return JSON.stringify({
    kind: "financial_plan",
    actions: [
      {
        type: "SIMULATE_PURCHASE",
        localId: "a1",
        confidence: "HIGH",
        notes: null,
        referencesToPreviousMessage: null,
        amount: amount.toFixed(2),
        installments: installments ?? null,
        paymentMethod: paymentMethod ?? null,
        card: null,
      },
    ],
  });
}

// Fase 7.0.3b, item 2 — pelo menos 5 formulações diferentes de simulação
// hipotética de compra, cobrindo os 3 novos casos reais (S1/S2/S3), o caso
// 26 original do corpus, e uma formulação adicional nunca vista em nenhum
// dos dois ("à vista", sem cartão/parcelamento — testa o branch
// CASH_EXPENSE_NOW do pipeline).
const CASES = [
  { label: "26 (corpus original)", text: "se eu comprar um negócio de 500 em 5x dá ruim?", plan: simulatePurchasePlan({ amount: 500, installments: 5, paymentMethod: "cartao_credito" }) },
  { label: "S1", text: "se eu gastar 800 em 4 vezes vai ficar apertado?", plan: simulatePurchasePlan({ amount: 800, installments: 4, paymentMethod: "cartao_credito" }) },
  { label: "S2", text: "consigo comprar uma parada de 300 no cartão?", plan: simulatePurchasePlan({ amount: 300, installments: null, paymentMethod: "cartao_credito" }) },
  { label: "S3", text: "da ruim pegar um negócio de 1200 em 6x?", plan: simulatePurchasePlan({ amount: 1200, installments: 6, paymentMethod: "cartao_credito" }) },
  { label: "formulação extra (à vista, sem cartão)", text: "vou apertar se eu comprar um notebook de 2500 à vista?", plan: simulatePurchasePlan({ amount: 2500, installments: null, paymentMethod: null }) },
];

async function run() {
  console.log("--- Fase 7.0.3b: SIMULATE_PURCHASE — generalização (mock, zero chamada Groq) ---\n");
  const fpBefore = await fingerprint();

  for (const c of CASES) {
    const provider = createMockProvider(new Map([[c.text, c.plan]]));
    let result;
    let threw = false;
    try {
      result = await handleConversationalMessage(c.text, `TESTE_SIM_INTENT_${c.label.replace(/\W+/g, "_")}`, { client: prisma, provider, rawMessage: c.text });
    } catch (err) {
      threw = true;
      result = { reply: `EXCEÇÃO: ${err.message}` };
    }
    check(`[${c.label}] não lança exceção`, !threw, result.reply);
    check(`[${c.label}] pipeline devolve REPLY (nunca CONFIRM/escrita)`, !threw && result.kind === PIPELINE_RESULT_KIND.REPLY, JSON.stringify(result));
    check(`[${c.label}] reply é uma string não-vazia (simulação formatada, nunca o LLM narrando)`, !threw && typeof result.reply === "string" && result.reply.length > 0);
  }

  const fpAfter = await fingerprint();
  check("zero-write: nenhum model financeiro mudou de contagem em nenhum dos 5+ casos", JSON.stringify(fpBefore) === JSON.stringify(fpAfter), JSON.stringify({ fpBefore, fpAfter }));

  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: "TESTE_SIM_INTENT_" } } }).catch(() => {});
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await prisma.$disconnect();
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
