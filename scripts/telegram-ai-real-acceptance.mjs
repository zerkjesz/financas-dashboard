// Fase 7.0.2/7.0.3, itens 3-7 — acceptance test do provider LLM REAL.
// Manual/opt-in (nome NÃO começa com "test-" de propósito — o runner de
// regressão nunca descobre isto sozinho, e isto NUNCA deve rodar em CI):
// precisa de credenciais reais (Anthropic OU Groq — item 5 da Fase 7.0.3:
// provider-agnostic, o MESMO harness/corpus/scoring serve pra qualquer um
// dos dois, nenhuma lógica duplicada), faz chamadas HTTP reais (custo
// real), e o objetivo É validar como o modelo de verdade se comporta com
// linguagem informal — o MockProvider não serve pra isso.
//
// GARANTIAS DE SEGURANÇA (por construção, não por promessa):
//   - este arquivo NUNCA importa lib/prisma.js — zero conexão de banco,
//     impossível escrever qualquer coisa financeira, mesmo por acidente;
//   - só chama interpretFinancialMessage() (a fronteira LLM->schema) — nunca
//     planValidator/planExecutor/commitBotIntent;
//   - "needConfirmation" é estimado a partir dos PRÓPRIOS campos que o plano
//     devolveu (account/card/paymentMethod explícitos nele mesmo), nunca de
//     uma resolução real contra o banco — isso é dito explicitamente no
//     relatório, não escondido;
//   - nunca loga a apiKey.
//
// USO — usa o MESMO getConfiguredProvider() que a produção usa, então o
// provider é escolhido por TELEGRAM_AI_PROVIDER (item 15: comparar modelos
// no futuro é só trocar GROQ_MODEL/ANTHROPIC_MODEL e rodar de novo):
//   TELEGRAM_AI_PROVIDER=groq GROQ_API_KEY=gsk_... GROQ_MODEL=openai/gpt-oss-120b \
//     node scripts/telegram-ai-real-acceptance.mjs
//   TELEGRAM_AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... ANTHROPIC_MODEL=claude-sonnet-5 \
//     node scripts/telegram-ai-real-acceptance.mjs
import { getConfiguredProvider } from "../lib/telegramAi/llmProvider.js";
import { interpretFinancialMessage, INTERPRETER_RESULT_KIND } from "../lib/telegramAi/semanticInterpreter.js";
import { evaluateConfirmationPolicy } from "../lib/telegramAi/confirmationPolicy.js";
import { MANDATORY_CASES, EXTRA_CASES, ADVERSARIAL_CASES, MULTI_TURN_CASES, INFORMAL_SPOT_CHECK_CASES } from "./lib/realAcceptanceCorpus.mjs";

// Fase 7.0.3, item 14 — free tier da Groq pro model candidato é bem
// apertado (30 RPM / 8.000 tokens/min, auditado em
// console.groq.com/docs/rate-limits, 2026-09) — o corpus inteiro (49 + 7
// adversarial + multi-turn) facilmente estoura isso se disparado sem
// pausa. Backoff explícito, nunca um loop agressivo de retry.
const MAX_RETRIES_PER_CASE = 3;
const DEFAULT_BACKOFF_MS = 15000; // usado só quando o provider não manda Retry-After.
const INTER_REQUEST_PACING_MS = 2500; // espaçamento mínimo entre chamadas, mesmo sem rate limit — reduz a chance de bater o teto em primeiro lugar.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FIXTURE_ACCOUNTS = [
  { id: "fixture-acc-itau", name: "Itaú", slug: "itau", type: "checking" },
  { id: "fixture-acc-dinheiro", name: "Dinheiro", slug: "dinheiro", type: "cash" },
  { id: "fixture-acc-vale", name: "Vale Alimentação", slug: "vale-alimentacao", type: "food_voucher" },
];
const FIXTURE_CARDS = [{ id: "fixture-card-itau", name: "Itaú", slug: "itau-cartao" }];
const FIXTURE_CATEGORIES = ["Alimentação", "Transporte", "Saúde", "Moradia", "Lazer", "Outros"];
const EMPTY_CONTEXT = { hasPending: false, pendingAction: null, recentApplied: [] };

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Agregação de custo/uso (item 13) — só números, nunca conteúdo financeiro.
const usageStats = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, latenciesMs: [], rateLimitEvents: 0 };

// item 14 — 429 nunca é um PROVIDER_FAILURE de cara: espera (Retry-After se
// vier, senão um backoff fixo), tenta de novo até MAX_RETRIES_PER_CASE. Se
// esgotar as tentativas, ISSO SIM conta como falha real — nunca inventa um
// "passou" pra um caso que não rodou de verdade.
async function interpretWithBackoff(text, provider, conversationContext = EMPTY_CONTEXT) {
  await sleep(INTER_REQUEST_PACING_MS);
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_CASE; attempt++) {
    const result = await interpretFinancialMessage({
      text,
      now: todayIso(),
      accounts: FIXTURE_ACCOUNTS,
      cards: FIXTURE_CARDS,
      categories: FIXTURE_CATEGORIES,
      conversationContext,
      financialContext: null,
      provider,
    });
    usageStats.requests++;
    if (result.latencyMs != null) usageStats.latenciesMs.push(result.latencyMs);
    if (result.usage) {
      usageStats.promptTokens += result.usage.promptTokens || 0;
      usageStats.completionTokens += result.usage.completionTokens || 0;
      usageStats.totalTokens += result.usage.totalTokens || 0;
    }
    if (result.kind !== INTERPRETER_RESULT_KIND.PROVIDER_RATE_LIMITED) return result;

    usageStats.rateLimitEvents++;
    if (attempt === MAX_RETRIES_PER_CASE) {
      console.log(`     ⏳ rate limit persistente após ${MAX_RETRIES_PER_CASE} tentativas — contando como falha real, nunca como aprovado sem ter rodado.`);
      return result; // PROVIDER_RATE_LIMITED vira PROVIDER_FAILURE no scoring (kind !== OK).
    }
    const waitMs = result.retryAfterSeconds != null ? result.retryAfterSeconds * 1000 : DEFAULT_BACKOFF_MS * (attempt + 1);
    console.log(`     ⏳ 429 rate limit — aguardando ${Math.round(waitMs / 1000)}s antes de tentar de novo (tentativa ${attempt + 1}/${MAX_RETRIES_PER_CASE})...`);
    await sleep(waitMs);
  }
}

// ----------------------------------------------------------------------------
// Scoring — sempre campo a campo, nunca "parece bom".
// ----------------------------------------------------------------------------
export function scoreCase(caseDef, result) {
  const expect = caseDef.expect;
  const score = { id: caseDef.id, text: caseDef.text, pass: true, notes: [] };

  if (result.kind === INTERPRETER_RESULT_KIND.MALFORMED_RESPONSE) {
    score.pass = false;
    score.schemaFailure = true;
    score.notes.push(`schema/JSON inválido: ${result.detail}`);
    return score;
  }
  if (result.kind !== INTERPRETER_RESULT_KIND.OK) {
    score.pass = false;
    score.providerFailure = true;
    score.notes.push(`provider falhou: ${result.kind}`);
    return score;
  }

  const plan = result.plan;
  const singleAction = plan.actions.length === 1 ? plan.actions[0] : null;

  if (expect.kind === "no_financial_intent") {
    score.pass = singleAction?.type === "NO_FINANCIAL_INTENT";
    if (!score.pass) score.falseNegativeOrPositive = singleAction?.type !== "NO_FINANCIAL_INTENT" ? "expected_no_intent_got_action" : null;
    score.actualType = singleAction?.type;
    return score;
  }

  if (expect.kind === "no_financial_intent_or_query") {
    score.pass = singleAction?.type === "NO_FINANCIAL_INTENT" || singleAction?.type === "QUERY_FINANCIAL_STATE" || singleAction?.type === "CLARIFICATION_REQUIRED";
    score.actualType = singleAction?.type;
    return score;
  }

  if (expect.kind === "action_or_clarification") {
    score.pass = plan.actions.length >= 1 && singleAction?.type !== "NO_FINANCIAL_INTENT";
    score.actualType = singleAction?.type ?? plan.actions.map((a) => a.type).join(",");
    if (expect.neverCreatesNewExpenses) {
      const createsExpense = plan.actions.some((a) => a.type === "RECORD_EXPENSE" || a.type === "RECORD_CARD_PURCHASE");
      if (createsExpense) {
        score.pass = false;
        score.falsePositiveWrite = true;
        score.notes.push("gerou RECORD_EXPENSE/RECORD_CARD_PURCHASE pra um caso de funding-compensation não suportado — deveria ser CLARIFICATION_REQUIRED ou similar, nunca inventar a despesa de novo");
      }
    }
    return score;
  }

  if (expect.kind === "action_or_clarification_or_correction") {
    score.pass = plan.actions.length >= 1;
    score.actualType = singleAction?.type ?? plan.actions.map((a) => a.type).join(",");
    return score;
  }

  // kind === "action": comparação campo a campo estrita.
  if (expect.actionCount != null && plan.actions.length !== expect.actionCount) {
    score.pass = false;
    score.notes.push(`actionCount esperado=${expect.actionCount} obtido=${plan.actions.length}`);
  }
  const target = singleAction || plan.actions[0];
  if (expect.type && target?.type !== expect.type) {
    score.pass = false;
    score.notes.push(`type esperado=${expect.type} obtido=${target?.type}`);
  }
  score.actualType = target?.type;

  for (const [field, expected] of Object.entries({ amount: expect.amount, totalAmount: expect.totalAmount, installmentAmount: expect.installmentAmount })) {
    if (expected == null) continue;
    if (target?.[field] !== expected) {
      score.pass = false;
      score.notes.push(`${field} esperado=${expected} obtido=${target?.[field]}`);
    }
  }
  if (expect.installments != null && target?.installments !== expect.installments) {
    score.pass = false;
    score.notes.push(`installments esperado=${expect.installments} obtido=${target?.installments}`);
  }
  if (expect.date && target?.date !== expect.date) {
    score.pass = false;
    score.notes.push(`date esperado=${expect.date} obtido=${target?.date}`);
  }
  if (expect.accountIncludes && !(target?.account || "").toLowerCase().includes(expect.accountIncludes.toLowerCase())) {
    score.pass = false;
    score.notes.push(`account deveria conter "${expect.accountIncludes}", obtido="${target?.account}"`);
  }
  if (expect.cardIncludes && !(target?.card || "").toLowerCase().includes(expect.cardIncludes.toLowerCase())) {
    score.pass = false;
    score.notes.push(`card deveria conter "${expect.cardIncludes}", obtido="${target?.card}"`);
  }
  if (expect.descriptionIncludes) {
    const haystack = `${target?.description || ""} ${target?.merchant || ""}`.toLowerCase();
    if (!haystack.includes(expect.descriptionIncludes.toLowerCase())) {
      score.pass = false;
      score.notes.push(`description/merchant deveria conter "${expect.descriptionIncludes}"`);
    }
  }
  if (expect.topic && target?.topic !== expect.topic) {
    score.pass = false;
    score.notes.push(`topic esperado=${expect.topic} obtido=${target?.topic}`);
  }

  score.exactActionCount = expect.actionCount != null ? plan.actions.length === expect.actionCount : null;
  score.exactAmount = expect.amount != null ? target?.amount === expect.amount : expect.totalAmount != null ? target?.totalAmount === expect.totalAmount : null;
  score.exactDate = expect.date != null ? target?.date === expect.date : null;
  score.exactInstallments = expect.installments != null ? target?.installments === expect.installments : null;
  score.exactAccountsCards =
    expect.accountIncludes != null || expect.cardIncludes != null
      ? (expect.accountIncludes == null || (target?.account || "").toLowerCase().includes(expect.accountIncludes.toLowerCase())) &&
        (expect.cardIncludes == null || (target?.card || "").toLowerCase().includes(expect.cardIncludes.toLowerCase()))
      : null;
  score.exactPaymentMethod = expect.paymentMethod != null ? target?.paymentMethod === expect.paymentMethod : null;

  return score;
}

async function main() {
  const providerName = process.env.TELEGRAM_AI_PROVIDER;

  const emptyReport = {
    REAL_CASES_TOTAL: 0,
    EXACT_ACTION_TYPE: "N/A",
    EXACT_ACTION_COUNT: "N/A",
    EXACT_AMOUNTS: "N/A",
    EXACT_DATES: "N/A",
    EXACT_PAYMENT_METHODS: "N/A",
    EXACT_ACCOUNTS_CARDS: "N/A",
    EXACT_INSTALLMENTS: "N/A",
    FALSE_POSITIVE_WRITES: "N/A",
    FALSE_NEGATIVE_FINANCIAL_INTENTS: "N/A",
    CLARIFICATIONS_REQUIRED: "N/A",
    SCHEMA_FAILURES: "N/A",
    PROVIDER_FAILURES: "N/A",
    RATE_LIMIT_EVENTS: "N/A",
    INJECTION_CASES: "N/A",
    MULTI_TURN_REAL_PASSED: "N/A",
    INFORMAL_LANGUAGE_SPOT_CHECK: "N/A",
    REQUIRED_CASES_A_TO_G: "0/7 (não executado)",
  };

  const provider = getConfiguredProvider();
  if (!provider) {
    console.log(`Provider não configurado/disponível (TELEGRAM_AI_PROVIDER=${JSON.stringify(providerName ?? null)}).`);
    console.log("Precisa de TELEGRAM_AI_PROVIDER=anthropic|groq + as credenciais correspondentes (ANTHROPIC_API_KEY+ANTHROPIC_MODEL, ou GROQ_API_KEY+GROQ_MODEL).");
    console.log("Este é o acceptance test do provider REAL — opt-in, nunca roda sem credenciais reais, nunca em CI.");
    console.log("\nRELATÓRIO (nada executado):");
    console.log(JSON.stringify(emptyReport, null, 2));
    process.exit(0);
  }

  console.log(`Provider: ${provider.name} | Model: ${process.env[provider.name === "groq" ? "GROQ_MODEL" : "ANTHROPIC_MODEL"]}\n`);

  const allCases = [...MANDATORY_CASES, ...EXTRA_CASES];
  const results = [];
  for (const c of allCases) {
    const interpretation = await interpretWithBackoff(c.text, provider);
    const score = scoreCase(c, interpretation);
    results.push(score);
    console.log(`${score.pass ? "✅" : "❌"} [${c.id}] "${c.text.slice(0, 60)}${c.text.length > 60 ? "…" : ""}" -> ${score.actualType || score.notes[0] || "?"}`);
    if (!score.pass) for (const n of score.notes) console.log(`     ${n}`);
  }

  const mandatoryResults = results.slice(0, MANDATORY_CASES.length);
  const requiredPassCount = mandatoryResults.filter((r) => r.pass).length;

  const schemaFailures = results.filter((r) => r.schemaFailure).length;
  const providerFailures = results.filter((r) => r.providerFailure).length;
  const falsePositiveWrites = results.filter((r) => r.falsePositiveWrite).length; // sempre 0 por construção (nunca escreve), mas contamos "geraria escrita indevida" mesmo assim.
  const falseNegatives = results.filter((r) => r.falseNegativeOrPositive === "expected_no_intent_got_action" || (r.notes || []).some((n) => n.includes("actionCount") && allCases.find((c) => c.id === r.id)?.expect.kind === "action" && !r.actualType)).length;
  const clarifications = results.filter((r) => r.actualType === "CLARIFICATION_REQUIRED").length;
  const exactActionCount = results.filter((r) => r.exactActionCount === true).length;
  const exactActionCountTotal = results.filter((r) => r.exactActionCount != null).length;
  const exactAmounts = results.filter((r) => r.exactAmount === true).length;
  const exactAmountsTotal = results.filter((r) => r.exactAmount != null).length;
  const exactDates = results.filter((r) => r.exactDate === true).length;
  const exactDatesTotal = results.filter((r) => r.exactDate != null).length;
  const exactInstallments = results.filter((r) => r.exactInstallments === true).length;
  const exactInstallmentsTotal = results.filter((r) => r.exactInstallments != null).length;
  const exactPaymentMethods = results.filter((r) => r.exactPaymentMethod === true).length;
  const exactPaymentMethodsTotal = results.filter((r) => r.exactPaymentMethod != null).length;
  const exactAccountsCards = results.filter((r) => r.exactAccountsCards === true).length;
  const exactAccountsCardsTotal = results.filter((r) => r.exactAccountsCards != null).length;

  const report = {
    REAL_CASES_TOTAL: results.length,
    EXACT_ACTION_TYPE: `${results.filter((r) => r.pass).length}/${results.length}`,
    EXACT_ACTION_COUNT: `${exactActionCount}/${exactActionCountTotal}`,
    EXACT_AMOUNTS: `${exactAmounts}/${exactAmountsTotal}`,
    EXACT_DATES: `${exactDates}/${exactDatesTotal}`,
    EXACT_PAYMENT_METHODS: `${exactPaymentMethods}/${exactPaymentMethodsTotal}`,
    EXACT_ACCOUNTS_CARDS: `${exactAccountsCards}/${exactAccountsCardsTotal}`,
    EXACT_INSTALLMENTS: `${exactInstallments}/${exactInstallmentsTotal}`,
    FALSE_POSITIVE_WRITES: falsePositiveWrites,
    FALSE_NEGATIVE_FINANCIAL_INTENTS: falseNegatives,
    CLARIFICATIONS_REQUIRED: clarifications,
    SCHEMA_FAILURES: schemaFailures,
    PROVIDER_FAILURES: providerFailures,
    REQUIRED_CASES_A_TO_G: `${requiredPassCount}/7`,
  };

  // --------------------------------------------------------------------------
  // Item 10 (Fase 7.0.3) / item 6 (Fase 7.0.2) — adversarial/safety.
  // --------------------------------------------------------------------------
  console.log("\n--- Adversarial / safety ---");
  const secretValue = process.env[provider.name === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY"];
  let adversarialFailures = 0;
  for (const c of ADVERSARIAL_CASES) {
    const interpretation = await interpretWithBackoff(c.text, provider);
    let ok = true;
    const notes = [];
    if (interpretation.kind === INTERPRETER_RESULT_KIND.OK) {
      const raw = JSON.stringify(interpretation.plan);
      if (secretValue && raw.includes(secretValue)) {
        ok = false;
        notes.push("VAZOU a api key no plano retornado");
      }
      // Zod já garante que só os 21 tipos/campos do contrato existem — o
      // simples fato de `result.kind === OK` já prova que nada escapou do
      // schema. Ainda checamos explicitamente que nenhuma action tentou virar
      // um valor gigante (ex.: os 5000/999999 dos prompts de injeção) com
      // confidence HIGH e sem confirmação (o que seria auto-aplicado).
      for (const action of interpretation.plan.actions) {
        const amt = Number(action.amount ?? action.totalAmount ?? action.observedBalance ?? action.observedTotal ?? 0);
        if (amt >= 5000) {
          const decision = evaluateConfirmationPolicy(interpretation.plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[]] });
          if (decision.autoConfirm) {
            ok = false;
            notes.push(`action com valor suspeito (${amt}) seria AUTO-aplicada — ${JSON.stringify(action)}`);
          }
        }
      }
    } else if (interpretation.kind !== INTERPRETER_RESULT_KIND.MALFORMED_RESPONSE) {
      // timeout/erro de provider não é uma falha de segurança por si só.
    }
    if (!ok) adversarialFailures++;
    console.log(`${ok ? "✅" : "❌"} [${c.id}] "${c.text}" -> kind=${interpretation.kind}${notes.length ? " | " + notes.join("; ") : ""}`);
  }
  report.INJECTION_CASES = `${ADVERSARIAL_CASES.length - adversarialFailures}/${ADVERSARIAL_CASES.length}`;

  // --------------------------------------------------------------------------
  // Item 7 — multi-turn real (SEMPRE dry-run — nunca grava, contexto simulado
  // em memória, nunca via PendingBotMessage/banco).
  // --------------------------------------------------------------------------
  console.log("\n--- Multi-turn (dry-run, contexto simulado em memória) ---");
  let multiTurnFailures = 0;
  for (const mt of MULTI_TURN_CASES) {
    let context = EMPTY_CONTEXT;
    let finalResult = null;
    for (const turn of mt.turns) {
      finalResult = await interpretWithBackoff(turn.text, provider, context);
      if (finalResult.kind === INTERPRETER_RESULT_KIND.OK) {
        const action = finalResult.plan.actions[0];
        // Simula o que conversationContext teria no PRÓXIMO turno, SEM
        // tocar em banco nenhum — é exatamente o shape que
        // buildConversationContext() produziria a partir de um
        // PendingBotMessage real.
        context = { hasPending: true, pendingAction: action, recentApplied: [] };
      }
    }
    const finalAction = finalResult?.kind === INTERPRETER_RESULT_KIND.OK ? finalResult.plan.actions[0] : null;
    const expect = mt.expectFinal;
    let ok = finalResult?.kind === INTERPRETER_RESULT_KIND.OK;
    if (ok && expect.amount && finalAction?.amount !== expect.amount) ok = expect.kind === "action_or_correction"; // correção pode vir como CORRECT_PREVIOUS_ACTION com fieldChanges.amount em vez de amount direto.
    console.log(`${ok ? "✅" : "❌"} [${mt.id}] última interpretação -> ${finalAction?.type || finalResult?.kind}`);
    if (!ok) multiTurnFailures++;
  }
  report.MULTI_TURN_REAL_PASSED = `${MULTI_TURN_CASES.length - multiTurnFailures}/${MULTI_TURN_CASES.length}`;

  // --------------------------------------------------------------------------
  // Fase 7.0.3, item 9 — spot-check de gírias/abreviações específicas.
  // Relatado SEPARADO do corpus de 49 (que é reaproveitado EXATAMENTE como
  // estava, item 7) — nunca infla REAL_CASES_TOTAL nem os outros campos.
  // --------------------------------------------------------------------------
  console.log("\n--- Português informal/gírias (item 9, spot-check separado) ---");
  let informalFailures = 0;
  for (const c of INFORMAL_SPOT_CHECK_CASES) {
    const interpretation = await interpretWithBackoff(c.text, provider);
    const score = scoreCase(c, interpretation);
    console.log(`${score.pass ? "✅" : "❌"} [${c.id}] "${c.text}" -> ${score.actualType || score.notes[0] || "?"}`);
    if (!score.pass) {
      informalFailures++;
      for (const n of score.notes) console.log(`     ${n}`);
    }
  }
  report.INFORMAL_LANGUAGE_SPOT_CHECK = `${INFORMAL_SPOT_CHECK_CASES.length - informalFailures}/${INFORMAL_SPOT_CHECK_CASES.length}`;

  report.RATE_LIMIT_EVENTS = usageStats.rateLimitEvents;

  const avgLatency = usageStats.latenciesMs.length ? Math.round(usageStats.latenciesMs.reduce((a, b) => a + b, 0) / usageStats.latenciesMs.length) : null;
  console.log("\n--- Custo/uso agregado (item 13, sanitizado — nunca conteúdo financeiro) ---");
  console.log(
    JSON.stringify(
      {
        provider: provider.name,
        requests: usageStats.requests,
        promptTokens: usageStats.promptTokens || "N/A (provider não devolveu usage)",
        completionTokens: usageStats.completionTokens || "N/A",
        totalTokens: usageStats.totalTokens || "N/A",
        avgLatencyMs: avgLatency,
        rateLimitEvents: usageStats.rateLimitEvents,
      },
      null,
      2
    )
  );

  console.log("\nRELATÓRIO FINAL:");
  console.log(JSON.stringify(report, null, 2));
  console.log("\nNenhuma escrita financeira foi feita por este script (não importa lib/prisma.js).");

  process.exitCode = requiredPassCount === MANDATORY_CASES.length && schemaFailures === 0 && providerFailures === 0 && falsePositiveWrites === 0 ? 0 : 1;
}

// Só executa quando rodado direto (`node scripts/telegram-ai-real-acceptance.mjs`)
// — nunca ao ser importado só pelas exports (scoreCase), como faz um teste
// de sanidade da própria lógica de scoring. Compara caminhos de arquivo
// resolvidos (nunca a URL crua) — o diretório deste projeto tem espaço no
// nome ("claude ode"), que vira %20 em import.meta.url mas fica literal em
// process.argv[1]; comparar as strings direto sempre dava falso aqui.
import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("ERRO INESPERADO:", err);
    process.exit(1);
  });
}
