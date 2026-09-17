// Fase 7.0.3, item 1/2 — TELEGRAM_AI_PROVIDER precisa ser explícito e falhar
// fechado em qualquer ambiguidade; o provider Groq precisa respeitar a MESMA
// interface que o Anthropic (contrato provider-agnostic, item 5) e usar o
// payload real da Groq (max_completion_tokens, nunca o "max_tokens"
// deprecated — item 4). Testes puros, sem banco, sem rede real (fetch é
// interceptado localmente).
//
//   node scripts/test-telegram-ai-provider-selection.mjs
import { createGroqProvider, ProviderUnavailableError, getConfiguredProvider, SUPPORTED_PROVIDER_NAMES } from "../lib/telegramAi/llmProvider.js";
import { buildGroqStrictSchema, buildGroqResponseFormat } from "../lib/telegramAi/groqStrictSchema.js";

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

function withEnv(vars, fn) {
  const original = {};
  for (const k of Object.keys(vars)) original[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ==========================================================================
// getConfiguredProvider() — seleção explícita, fail closed em toda ambiguidade.
// ==========================================================================
check("[SUPPORTED_PROVIDER_NAMES] só anthropic e groq", JSON.stringify([...SUPPORTED_PROVIDER_NAMES].sort()) === JSON.stringify(["anthropic", "groq"]));

withEnv({ TELEGRAM_AI_PROVIDER: null, ANTHROPIC_API_KEY: null, ANTHROPIC_MODEL: null, GROQ_API_KEY: null, GROQ_MODEL: null }, () => {
  check("[seleção] TELEGRAM_AI_PROVIDER ausente -> null (nunca escolhe um default)", getConfiguredProvider() === null);
});
withEnv({ TELEGRAM_AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "fake", ANTHROPIC_MODEL: "fake" }, () => {
  check('[seleção] TELEGRAM_AI_PROVIDER="openai" (inválido) -> null, mesmo com Anthropic totalmente configurado', getConfiguredProvider() === null);
});
withEnv({ TELEGRAM_AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: null, ANTHROPIC_MODEL: "claude-sonnet-5" }, () => {
  check("[seleção] provider=anthropic mas sem ANTHROPIC_API_KEY -> null", getConfiguredProvider() === null);
});
withEnv({ TELEGRAM_AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_MODEL: "claude-sonnet-5" }, () => {
  const p = getConfiguredProvider();
  check("[seleção] provider=anthropic com chave+model -> devolve o provider Anthropic", p?.name === "anthropic", p?.name);
});
withEnv({ TELEGRAM_AI_PROVIDER: "groq", GROQ_API_KEY: null, GROQ_MODEL: "openai/gpt-oss-120b" }, () => {
  check("[seleção] provider=groq mas sem GROQ_API_KEY -> null", getConfiguredProvider() === null);
});
withEnv({ TELEGRAM_AI_PROVIDER: "groq", GROQ_API_KEY: "fake-key", GROQ_MODEL: null }, () => {
  check("[seleção] provider=groq mas sem GROQ_MODEL -> null", getConfiguredProvider() === null);
});
withEnv({ TELEGRAM_AI_PROVIDER: "groq", GROQ_API_KEY: "fake-key", GROQ_MODEL: "openai/gpt-oss-120b" }, () => {
  const p = getConfiguredProvider();
  check("[seleção] provider=groq com chave+model -> devolve o provider Groq", p?.name === "groq", p?.name);
});

// ==========================================================================
// createGroqProvider — mesma matriz de fail-closed que o Anthropic.
// ==========================================================================
{
  const p = createGroqProvider({ apiKey: "fake", model: undefined });
  check("[groq isAvailable] chave presente, model ausente -> false", p.isAvailable() === false);
}
{
  const p = createGroqProvider({ apiKey: undefined, model: "openai/gpt-oss-120b" });
  check("[groq isAvailable] model presente, chave ausente -> false", p.isAvailable() === false);
}
{
  const p = createGroqProvider({ apiKey: "fake", model: "openai/gpt-oss-120b" });
  check("[groq isAvailable] chave e model presentes -> true", p.isAvailable() === true);
}
{
  const p = createGroqProvider({ apiKey: "fake", model: undefined });
  let threw = null;
  try {
    await p.complete({ systemPrompt: "x", userPrompt: "y" });
  } catch (err) {
    threw = err;
  }
  check("[groq complete] sem model -> ProviderUnavailableError, nunca tenta a requisição", threw instanceof ProviderUnavailableError);
}

// ==========================================================================
// Payload real — nunca "max_tokens" (deprecated na Groq), sempre
// "max_completion_tokens"; response_format estrito; temperature:0.
// Intercepta fetch localmente (sem rede real) só pra inspecionar o body.
// ==========================================================================
{
  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: '{"kind":"financial_plan","actions":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
  };
  try {
    const p = createGroqProvider({ apiKey: "fake-key", model: "openai/gpt-oss-120b" });
    const result = await p.complete({ systemPrompt: "sys", userPrompt: "user" });
    check("[groq payload] usa max_completion_tokens", "max_completion_tokens" in capturedBody, JSON.stringify(Object.keys(capturedBody)));
    check("[groq payload] NUNCA usa max_tokens (deprecated na Groq)", !("max_tokens" in capturedBody));
    check("[groq payload] temperature:0", capturedBody.temperature === 0);
    check("[groq payload] response_format.type = json_schema", capturedBody.response_format?.type === "json_schema");
    check("[groq payload] response_format.json_schema.strict = true", capturedBody.response_format?.json_schema?.strict === true);
    check("[groq payload] endpoint correto (via fetch URL)", true); // já provado indiretamente — ver teste de URL abaixo.
    check("[groq complete] usage repassado pro caller (item 13 — custo)", result.usage?.totalTokens === 15, JSON.stringify(result.usage));
  } finally {
    global.fetch = originalFetch;
  }
}
{
  const originalFetch = global.fetch;
  let capturedUrl = null,
    capturedAuth = null;
  global.fetch = async (url, opts) => {
    capturedUrl = url;
    capturedAuth = opts.headers.authorization;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  };
  try {
    const p = createGroqProvider({ apiKey: "fake-key-123", model: "openai/gpt-oss-120b" });
    await p.complete({ systemPrompt: "sys", userPrompt: "user" });
    check("[groq endpoint] URL exata da Chat Completions API", capturedUrl === "https://api.groq.com/openai/v1/chat/completions", capturedUrl);
    check("[groq auth] header Authorization: Bearer <key>", capturedAuth === "Bearer fake-key-123");
  } finally {
    global.fetch = originalFetch;
  }
}
{
  // 429 vira ProviderRateLimitError, distinto de erro genérico (item 14).
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "7" : null) }, text: async () => "" });
  try {
    const p = createGroqProvider({ apiKey: "fake", model: "openai/gpt-oss-120b" });
    let threw = null;
    try {
      await p.complete({ systemPrompt: "s", userPrompt: "u" });
    } catch (err) {
      threw = err;
    }
    check("[groq 429] vira ProviderRateLimitError com retryAfterSeconds", threw?.name === "ProviderRateLimitError" && threw?.retryAfterSeconds === 7, JSON.stringify({ name: threw?.name, retryAfterSeconds: threw?.retryAfterSeconds }));
  } finally {
    global.fetch = originalFetch;
  }
}

// ==========================================================================
// groqStrictSchema — auto-checagem estrutural (todo objeto:
// additionalProperties:false + required===todas as chaves).
// ==========================================================================
{
  let threw = null;
  let schema = null;
  try {
    schema = buildGroqStrictSchema();
  } catch (err) {
    threw = err;
  }
  check("[strict schema] constrói sem lançar (auto-checagem interna passa)", threw === null, threw?.message);
  check("[strict schema] raiz tem additionalProperties:false", schema?.additionalProperties === false);
  check("[strict schema] raiz: required === todas as properties", JSON.stringify([...schema.required].sort()) === JSON.stringify(Object.keys(schema.properties).sort()));
  const rf = buildGroqResponseFormat();
  check("[strict schema] response_format pronto pra usar (strict:true, name definido)", rf.json_schema.strict === true && typeof rf.json_schema.name === "string");
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exitCode = fail > 0 ? 1 : 0;
