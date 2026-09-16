// Fase 7.0.1, item 6 — smoke script MANUAL/opt-in do provider REAL
// (Anthropic). Propositalmente NÃO é `test-*.mjs`: o runner de regressão
// (scripts/*.mjs descoberto automaticamente por nome) nunca roda isto, e ele
// nunca deve rodar em CI — precisa de ANTHROPIC_API_KEY de verdade e faz uma
// chamada HTTP real (custo real, ainda que pequeno).
//
// O QUE ESTE SCRIPT NUNCA FAZ:
//   - nunca importa lib/prisma.js — zero conexão com banco, zero possibilidade
//     de escrita financeira, mesmo por acidente;
//   - nunca chama planValidator/planExecutor/commitBotIntent — só
//     interpretFinancialMessage() (a fronteira exata entre "LLM fala" e
//     "sistema decide"), imprime o PLANO já validado pelo schema Zod, nunca
//     mais que isso;
//   - nunca loga a apiKey, headers, ou o corpo bruto da resposta HTTP.
//
// USO:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/telegram-ai-real-provider-smoke.mjs
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/telegram-ai-real-provider-smoke.mjs "gastei 50 de gasolina no pix"
//
// Item 6 explícito — "não assuma que claude-sonnet-5 existe: quando houver
// credencial, validar o model id de verdade via chamada real antes do
// acceptance test": rodar este script (com uma chave real) É exatamente essa
// validação. Se ANTHROPIC_MODEL (lib/telegramAi/llmProvider.js) estiver
// errado, a chamada abaixo falha com um erro claro da API — corrija o
// model id ali antes de confiar no pipeline em qualquer teste de aceite.
import { createAnthropicProvider } from "../lib/telegramAi/llmProvider.js";
import { interpretFinancialMessage, INTERPRETER_RESULT_KIND } from "../lib/telegramAi/semanticInterpreter.js";

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey) {
    console.log("ANTHROPIC_API_KEY não está setada neste ambiente — nada pra testar.");
    console.log("Isso é o comportamento ESPERADO em DEV/CI: o smoke script é opt-in, nunca roda sem uma chave real.");
    process.exit(0);
  }
  if (!model) {
    console.log("ANTHROPIC_MODEL não está setada neste ambiente — nada pra testar (fail closed, item 2 da Fase 7.0.2).");
    console.log('Sete, por exemplo: ANTHROPIC_MODEL="claude-sonnet-5" (ou o id real do modelo que você quer validar).');
    process.exit(0);
  }

  const text = process.argv[2] || "gastei 50 de gasolina no pix";
  console.log(`Provider: Anthropic`);
  console.log(`Model (ANTHROPIC_MODEL): ${model}`);
  console.log(`Mensagem de teste: "${text}"\n`);

  const provider = createAnthropicProvider({ apiKey, model });
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

  switch (result.kind) {
    case INTERPRETER_RESULT_KIND.OK:
      console.log(`✅ Interpretação OK (latência: ${result.latencyMs}ms)`);
      console.log("Plano estruturado (já validado pelo schema Zod — isto é EXATAMENTE o que o executor determinístico receberia):");
      console.log(JSON.stringify(result.plan, null, 2));
      break;
    case INTERPRETER_RESULT_KIND.MALFORMED_RESPONSE:
      console.log(`⚠️ Resposta malformada/schema inválido (latência: ${result.latencyMs ?? "?"}ms)`);
      console.log(`Detalhe: ${result.detail}`);
      console.log("Isso pode indicar que o prompt precisa de ajuste, OU que o model id está devolvendo algo inesperado.");
      break;
    case INTERPRETER_RESULT_KIND.PROVIDER_TIMEOUT:
      console.log("⚠️ Timeout — provider não respondeu a tempo.");
      break;
    case INTERPRETER_RESULT_KIND.PROVIDER_ERROR:
      console.log(`❌ Erro do provider: ${result.detail}`);
      console.log(`Se a mensagem mencionar o model id (404/'model not found' etc.), o valor de ANTHROPIC_MODEL ("${model}") está ERRADO — ajuste a env var antes de confiar no pipeline.`);
      break;
    case INTERPRETER_RESULT_KIND.PROVIDER_UNAVAILABLE:
      console.log("❌ Provider indisponível (não deveria acontecer — chave foi fornecida).");
      break;
    default:
      console.log(`Resultado inesperado: ${result.kind}`);
  }

  console.log("\nNenhuma escrita financeira foi feita por este script (não importa lib/prisma.js, não existe conexão de banco aqui).");
}

main().catch((err) => {
  console.error("ERRO INESPERADO:", err);
  process.exit(1);
});
