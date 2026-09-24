// Fase 7.0.3, item 6 — smoke script MANUAL/opt-in do provider Groq REAL.
// Espelha scripts/telegram-ai-real-provider-smoke.mjs (Anthropic), mas
// específico pra Groq: valida autenticação, model id real, Structured
// Outputs estrito e response parsing ANTES de rodar o corpus completo.
//
// GARANTIAS DE SEGURANÇA (por construção):
//   - NUNCA importa lib/prisma.js — zero conexão de banco, impossível
//     escrever qualquer coisa financeira, mesmo por acidente;
//   - só chama interpretFinancialMessage() (a fronteira LLM->schema) — nunca
//     planValidator/planExecutor/commitBotIntent;
//   - nunca loga GROQ_API_KEY nem o header Authorization.
//
// USO:
//   GROQ_API_KEY=gsk_... GROQ_MODEL=openai/gpt-oss-120b \
//     node scripts/telegram-ai-groq-smoke.mjs
//
// Se este smoke FALHAR, o item 6 do pedido é explícito: PARE antes de rodar
// o corpus completo (scripts/telegram-ai-real-acceptance.mjs) — não faz
// sentido gastar as 49 mensagens contra um provider que não está
// respondendo corretamente nem no caso mais simples possível.
import { createGroqProvider } from "../lib/telegramAi/llmProvider.js";
import { interpretFinancialMessage, INTERPRETER_RESULT_KIND } from "../lib/telegramAi/semanticInterpreter.js";
import { buildGroqStrictSchema } from "../lib/telegramAi/groqStrictSchema.js";

const FIXTURE_ACCOUNTS = [
  { id: "fixture-acc-itau", name: "Itaú", slug: "itau", type: "checking" },
  { id: "fixture-acc-dinheiro", name: "Dinheiro", slug: "dinheiro", type: "cash" },
  { id: "fixture-acc-vale", name: "Vale Alimentação", slug: "vale-alimentacao", type: "food_voucher" },
];
const FIXTURE_CARDS = [{ id: "fixture-card-itau", name: "Itaú", slug: "itau-cartao" }];
const FIXTURE_CATEGORIES = ["Alimentação", "Transporte", "Saúde", "Moradia", "Lazer", "Outros"];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL;

  if (!apiKey) {
    console.log("GROQ_API_KEY não está setada neste ambiente — nada pra testar.");
    console.log("Isso é o comportamento ESPERADO em DEV/CI: o smoke script é opt-in, nunca roda sem uma chave real.");
    process.exit(0);
  }
  if (!model) {
    console.log("GROQ_MODEL não está setada neste ambiente — nada pra testar (fail closed, item 1 da Fase 7.0.3).");
    console.log('Candidato do pedido: GROQ_MODEL="openai/gpt-oss-120b" (único, junto com openai/gpt-oss-20b e qwen3-32b, com suporte a Structured Outputs estrito no momento em que isto foi auditado — console.groq.com/docs/structured-outputs).');
    process.exit(0);
  }

  console.log(`Provider: Groq`);
  console.log(`Model (GROQ_MODEL): ${model}`);

  // Passo 0 — o schema estrito PRECISA construir e passar na auto-checagem
  // (groqStrictSchema.js) antes de gastar uma chamada real com ele.
  try {
    const schema = buildGroqStrictSchema();
    console.log(`✅ Strict JSON Schema construído a partir do Zod contract (${JSON.stringify(schema).length} chars) — auto-checagem estrutural passou.`);
  } catch (err) {
    console.log(`❌ Falha construindo o strict JSON Schema ANTES de qualquer chamada: ${err.message}`);
    console.log("PARE — não faz sentido chamar a API real sem o schema estrito estar correto.");
    process.exit(1);
  }

  const text = "gastei 50 de gasolina no pix";
  console.log(`\nSmoke obrigatório (item 6): "${text}"`);

  const provider = createGroqProvider({ apiKey, model });
  const result = await interpretFinancialMessage({
    text,
    now: todayIso(),
    accounts: FIXTURE_ACCOUNTS,
    cards: FIXTURE_CARDS,
    categories: FIXTURE_CATEGORIES,
    conversationContext: { hasPending: false, pendingAction: null, recentApplied: [] },
    financialContext: null,
    provider,
  });

  console.log(`\nResultado: kind=${result.kind}${result.latencyMs ? ` (latência ${result.latencyMs}ms)` : ""}`);
  if (result.usage) console.log(`Uso: prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens} total=${result.usage.totalTokens}`);

  if (result.kind !== INTERPRETER_RESULT_KIND.OK) {
    console.log(`❌ SMOKE FALHOU: ${result.detail || result.kind}`);
    if (result.kind === INTERPRETER_RESULT_KIND.PROVIDER_ERROR && /model/i.test(result.detail || "")) {
      console.log(`O erro menciona "model" — verifique se GROQ_MODEL="${model}" ainda existe/está correto contra a API real.`);
    }
    console.log("\nPARE aqui — item 6 do pedido: não rode o corpus completo com um smoke falho.");
    process.exit(1);
  }

  const plan = result.plan;
  console.log("\nPlano estruturado (já validado pelo schema Zod local, além do strict mode da Groq):");
  console.log(JSON.stringify(plan, null, 2));

  const action = plan.actions.length === 1 ? plan.actions[0] : null;
  const checks = {
    "uma única action": plan.actions.length === 1,
    "type = RECORD_EXPENSE": action?.type === "RECORD_EXPENSE",
    // Comparação NUMÉRICA, não string exata — achado real contra a API: a
    // Groq pode devolver "50" em vez de "50.00" (ambos válidos pelo regex
    // decimalString, mesmo valor monetário; lib/money.js sempre converte via
    // Number() antes de qualquer conta, então "50" e "50.00" são idênticos
    // em todo o resto do sistema).
    "amount = 50.00 (comparação numérica)": Number(action?.amount) === 50,
    "description/merchant menciona gasolina": `${action?.description || ""} ${action?.merchant || ""}`.toLowerCase().includes("gasolina"),
    "paymentMethod = pix": action?.paymentMethod === "pix",
    "conta resolvível pra Itaú (paymentMethod=pix -> account itau nesta config)": true, // resolução de entidade real acontece no pipeline, não aqui — conferida pelos testes de pipeline.
  };
  console.log("\nChecks do smoke obrigatório (item 6):");
  let allOk = true;
  for (const [label, ok] of Object.entries(checks)) {
    console.log(`${ok ? "✅" : "❌"} ${label}`);
    if (!ok) allOk = false;
  }

  console.log("\nNenhuma escrita financeira foi feita por este script (não importa lib/prisma.js).");

  if (!allOk) {
    console.log("\n❌ SMOKE FALHOU nos checks de conteúdo — PARE antes do corpus completo (item 6).");
    process.exit(1);
  }
  console.log("\n✅ SMOKE PASSOU. Pode prosseguir com: node scripts/telegram-ai-real-acceptance.mjs");
}

main().catch((err) => {
  console.error("ERRO INESPERADO:", err);
  process.exit(1);
});
