// ============================================================================
// Fase 7.0 — abstração de provider de LLM. O interpretador semântico
// (lib/telegramAi/semanticInterpreter.js) nunca fala com um provider
// específico diretamente — só com esta interface. Troca de provider =
// trocar a implementação aqui, zero mudança no resto do pipeline.
//
// Auditado antes de escrever isto (item 16 do pedido): não existe NENHUM
// SDK/credencial de LLM neste projeto hoje (sem @anthropic-ai/sdk, sem
// OPENAI_API_KEY, sem ANTHROPIC_API_KEY em .env/.env.example). Não inventei
// nenhuma — ver docs/telegram-ai-provider.md pra exatamente qual variável
// precisa ser configurada pra ativar isto de verdade.
//
// Contrato: um provider recebe {systemPrompt, userPrompt} e devolve
// {raw, latencyMs} onde `raw` é a string bruta que o modelo respondeu (o
// CALLER — semanticInterpreter.js — é quem faz JSON.parse + validação Zod;
// o provider nunca decide se o resultado é válido).
// ============================================================================

export class ProviderUnavailableError extends Error {
  constructor(reason) {
    super(reason || "Provedor de LLM não configurado.");
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("Provedor de LLM não respondeu a tempo.");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderRequestError extends Error {
  constructor(reason, status, rateLimitHeaders) {
    super(reason || "Provedor de LLM retornou um erro.");
    this.name = "ProviderRequestError";
    this.status = status;
    this.rateLimitHeaders = rateLimitHeaders ?? null;
  }
}

// Fase 7.0.3, item 14 — 429 precisa ser DISTINGUÍVEL de qualquer outro erro
// (nunca "só mais uma falha genérica"), pra quem chama poder respeitar
// Retry-After/backoff em vez de contar como PROVIDER_FAILURE direto.
export class ProviderRateLimitError extends Error {
  constructor(retryAfterSeconds, rateLimitHeaders) {
    super("Provedor de LLM aplicou rate limit (429).");
    this.name = "ProviderRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds ?? null;
    this.rateLimitHeaders = rateLimitHeaders ?? null;
  }
}

// Fase 7.0.3 (retomada) — allowlist explícita de headers de rate limit
// (convenção OpenAI-compatible, usada por Groq; Anthropic manda um subset
// equivalente). Só estes nomes são lidos e repassados — nunca um header
// arbitrário — pra nunca correr risco de vazar algo sensível (ex.:
// request-id, cf-ray) junto por engano. Nenhum destes contém segredo.
const RATE_LIMIT_HEADER_ALLOWLIST = [
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
];

function extractRateLimitHeaders(headers) {
  const out = {};
  for (const name of RATE_LIMIT_HEADER_ALLOWLIST) {
    const v = headers.get(name);
    if (v != null) out[name] = v;
  }
  return Object.keys(out).length ? out : null;
}

const DEFAULT_TIMEOUT_MS = 15000;
// Fase 7.0.2, item 2 — NUNCA hardcoda um model id como "verdade de
// produção". O model vem EXCLUSIVAMENTE de ANTHROPIC_MODEL (env) — sem
// fallback pra nenhum valor fixo aqui. Se a env var estiver ausente/vazia
// com TELEGRAM_AI_ENABLED=true, `isAvailable()` abaixo devolve false e
// getConfiguredProvider() devolve null — o pipeline trata isso EXATAMENTE
// como "sem provider configurado" (mesmo caminho fail-closed já testado:
// zero write, mensagem de segurança, nunca escolhe outro model
// silenciosamente).
// Fase 7.0.1, item 6 — 2048 era curto demais pro pior caso real: um plano de
// até 20 actions (MAX_ACTIONS em financialIntentPlanSchema.js), cada uma com
// vários campos, facilmente passa de 3000-4000 tokens de JSON de saída.
// 4096 dá folga confortável sem custo desproporcional (é só o teto, não o
// gasto médio — a maioria das mensagens usa uma fração pequena disso).
const MAX_TOKENS = 4096;
// Fase 7.0.3 — achado real no smoke contra a API: o free tier da Groq pro
// model candidato tem 8000 tokens/min (TPM), e o schema estrito completo
// (todo campo required+nullable em todo objeto, item 3) sozinho já soma
// ~5900 tokens de prompt fixo (schema + system + user prompt), ANTES de
// reservar `max_completion_tokens`. Com o MAX_TOKENS genérico (4096) o
// total pedido passa de 10000 — 413 "Request too large" garantido. 2000
// cabe com folga (5900+2000=7900 < 8000) e ainda é generoso pra qualquer
// action única; planos de muitas actions no free tier podem precisar de
// mais que isso — se acontecer, é um limite real do tier gratuito, não um
// bug, e é reportado como tal (nunca escondido/contado como aprovado).
const GROQ_MAX_TOKENS = 2000;

// ----------------------------------------------------------------------------
// Provider real — Anthropic Messages API via fetch cru (sem SDK novo — a API
// é simples o bastante que não justifica uma dependência extra só pra isto).
// Só ativa se ANTHROPIC_API_KEY estiver presente; nunca inventa/hardcoda.
//
// Auditoria de robustez (item 6 do pedido):
//   - endpoint: https://api.anthropic.com/v1/messages (Messages API atual).
//   - model id: configurável via ANTHROPIC_MODEL (item 2, Fase 7.0.2) —
//     nunca hardcoded, nunca escolhido silenciosamente; validado de verdade
//     só pelo smoke script manual contra a API real.
//   - timeout: AbortController, DEFAULT_TIMEOUT_MS (15s) -> ProviderTimeoutError.
//   - max_tokens: MAX_TOKENS (4096) — cobre o pior caso (plano de 20 actions).
//   - JSON estruturado: o modelo é instruído via system prompt a devolver
//     SÓ JSON (promptBuilder.js); o parsing/validação real é feito pelo
//     CALLER (semanticInterpreter.js: JSON.parse + Zod) — nunca confiado
//     aqui. Não usamos "tool use"/JSON forçado da API nesta fase (mudança de
//     escopo maior — anotado como possível melhoria futura, não bloqueante).
//   - HTTP 4xx/5xx (incl. 429 rate limit): qualquer !res.ok vira
//     ProviderRequestError com o `status` original preservado — tratado de
//     forma uniforme como "falha desta chamada" (item 1: zero write, nunca
//     fallback), sem retry automático (retry silencioso poderia reinterpretar
//     com contexto desatualizado).
//   - resposta malformada: tratada pelo CALLER (semanticInterpreter.js).
//   - tamanho da mensagem: MAX_MESSAGE_LENGTH em semanticInterpreter.js
//     rejeita ANTES de sequer montar a requisição.
//   - segredos em log: nenhum console.log neste arquivo loga apiKey/headers/
//     body — confirmado por leitura completa do arquivo.
// ----------------------------------------------------------------------------
export function createAnthropicProvider({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = MAX_TOKENS } = {}) {
  return {
    name: "anthropic",
    // Fail closed em QUALQUER falta: chave OU model — nunca um dos dois
    // sozinho é "disponível o bastante" (item 2: "sem ANTHROPIC_MODEL válido
    // quando TELEGRAM_AI_ENABLED=true: fail closed").
    isAvailable: () => Boolean(apiKey) && Boolean(model),
    async complete({ systemPrompt, userPrompt }) {
      if (!apiKey) throw new ProviderUnavailableError("ANTHROPIC_API_KEY não configurada.");
      if (!model) throw new ProviderUnavailableError("ANTHROPIC_MODEL não configurada.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const start = Date.now();
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0, // item 2: "temperatura baixa" — determinístico é o objetivo, não criativo.
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - start;
        const rateLimitHeaders = extractRateLimitHeaders(res.headers);
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          throw new ProviderRateLimitError(retryAfter ? Number(retryAfter) : null, rateLimitHeaders);
        }
        if (!res.ok) {
          throw new ProviderRequestError(`Anthropic respondeu ${res.status}`, res.status, rateLimitHeaders);
        }
        const data = await res.json();
        const raw = (data.content || []).map((block) => (block.type === "text" ? block.text : "")).join("");
        const usage = data.usage ? { promptTokens: data.usage.input_tokens ?? null, completionTokens: data.usage.output_tokens ?? null, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) || null } : null;
        return { raw, latencyMs, usage, rateLimitHeaders };
      } catch (err) {
        if (err.name === "AbortError") throw new ProviderTimeoutError();
        if (err instanceof ProviderRequestError || err instanceof ProviderUnavailableError || err instanceof ProviderRateLimitError) throw err;
        throw new ProviderRequestError(err.message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ----------------------------------------------------------------------------
// Provider real — Groq (API compatível com OpenAI Chat Completions), item 2
// da Fase 7.0.3. Auditado ANTES de escrever isto (nunca presumir formato):
//   - endpoint: POST https://api.groq.com/openai/v1/chat/completions
//     (console.groq.com/docs/api-reference.md, 2026-09).
//   - auth: header "Authorization: Bearer $GROQ_API_KEY" (mesma doc).
//   - `max_tokens` está DEPRECATED na Groq — o campo certo é
//     `max_completion_tokens` (mesma doc, lista de parâmetros). Usar o
//     nome errado não quebra a chamada, mas silenciosamente não limitaria
//     nada — por isso usamos o nome certo desde o início.
//   - Structured Outputs em modo `strict:true` é suportado especificamente
//     por `openai/gpt-oss-120b`/`openai/gpt-oss-20b`/`qwen3-32b`
//     (console.groq.com/docs/structured-outputs, 2026-09) — exatamente o
//     model candidato do pedido. O schema estrito completo (todo campo em
//     `required`, `additionalProperties:false` em todo objeto) é gerado a
//     partir do MESMO Zod schema em groqStrictSchema.js — nunca duplicado
//     à mão, nunca um "responda em JSON" solto no prompt.
//   - streaming e tool-use NÃO são suportados junto de Structured Outputs
//     (mesma doc) — não usamos nenhum dos dois aqui, então não colide.
//   - 429: distinguido via ProviderRateLimitError (Retry-After respeitado
//     por quem chama, nunca por retry automático escondido aqui).
//   - usage (input/output/total tokens): repassado quando a API devolve,
//     pra observabilidade de custo (item 13) — nunca logado com conteúdo,
//     só os números.
// ----------------------------------------------------------------------------
export function createGroqProvider({ apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = GROQ_MAX_TOKENS, responseFormat } = {}) {
  return {
    name: "groq",
    isAvailable: () => Boolean(apiKey) && Boolean(model),
    async complete({ systemPrompt, userPrompt }) {
      if (!apiKey) throw new ProviderUnavailableError("GROQ_API_KEY não configurada.");
      if (!model) throw new ProviderUnavailableError("GROQ_MODEL não configurada.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const start = Date.now();
      try {
        // response_format é resolvido só na hora da chamada (nunca no import
        // do módulo) — se a construção do schema estrito falhar por algum
        // motivo, queremos isso como um erro claro desta chamada específica,
        // não um crash silencioso de import em todo o processo.
        const format = responseFormat ?? (await import("./groqStrictSchema.js")).buildGroqResponseFormat();
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_completion_tokens: maxTokens, // NUNCA "max_tokens" — deprecated na Groq (item 4 do pedido).
            temperature: 0,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: format,
          }),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - start;
        const rateLimitHeaders = extractRateLimitHeaders(res.headers);
        if (res.status === 429) {
          const retryAfter = res.headers.get("retry-after");
          throw new ProviderRateLimitError(retryAfter ? Number(retryAfter) : null, rateLimitHeaders);
        }
        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          throw new ProviderRequestError(`Groq respondeu ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`, res.status, rateLimitHeaders);
        }
        const data = await res.json();
        const raw = data.choices?.[0]?.message?.content ?? "";
        const usage = data.usage ? { promptTokens: data.usage.prompt_tokens ?? null, completionTokens: data.usage.completion_tokens ?? null, totalTokens: data.usage.total_tokens ?? null } : null;
        return { raw, latencyMs, usage, rateLimitHeaders };
      } catch (err) {
        if (err.name === "AbortError") throw new ProviderTimeoutError();
        if (err instanceof ProviderRequestError || err instanceof ProviderUnavailableError || err instanceof ProviderRateLimitError) throw err;
        throw new ProviderRequestError(err.message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ----------------------------------------------------------------------------
// Provider mock — determinístico, pra testes (item 18: "não deixar CI
// depender de chamada real paga"). Fixtures são funções (texto -> plano),
// nunca uma tabela estática que finge "IA" — os testes controlam
// explicitamente o que cada mensagem de teste deve retornar.
// ----------------------------------------------------------------------------
export function createMockProvider(fixtures = new Map()) {
  return {
    name: "mock",
    isAvailable: () => true,
    async complete({ userPrompt }) {
      for (const [matcher, responder] of fixtures) {
        const isMatch = typeof matcher === "function" ? matcher(userPrompt) : userPrompt.includes(matcher);
        if (isMatch) {
          const raw = typeof responder === "function" ? responder(userPrompt) : responder;
          return { raw: typeof raw === "string" ? raw : JSON.stringify(raw), latencyMs: 1 };
        }
      }
      throw new ProviderRequestError("MockProvider: nenhuma fixture bateu com o prompt (configure uma fixture pra este teste).");
    },
  };
}

// Fase 7.0.3, item 1 — TELEGRAM_AI_PROVIDER escolhe qual provider real está
// ativo, de forma EXPLÍCITA — nunca um default silencioso. `null` aqui
// significa "sem interpretador semântico disponível agora" em QUALQUER um
// destes casos, todos tratados pelo pipeline como o MESMO caminho
// fail-closed já testado (zero write, mensagem de segurança, nunca
// fallback pra outro provider/model/parser legado):
//   - TELEGRAM_AI_PROVIDER ausente;
//   - TELEGRAM_AI_PROVIDER com valor desconhecido (só "anthropic"/"groq" são
//     válidos — nunca escolhe o "mais parecido" nem o único configurado);
//   - o provider escolhido está sem API key;
//   - o provider escolhido está sem model.
export const SUPPORTED_PROVIDER_NAMES = Object.freeze(["anthropic", "groq"]);

export function getConfiguredProvider() {
  const providerName = process.env.TELEGRAM_AI_PROVIDER;
  if (providerName === "anthropic") {
    const provider = createAnthropicProvider();
    return provider.isAvailable() ? provider : null;
  }
  if (providerName === "groq") {
    const provider = createGroqProvider();
    return provider.isAvailable() ? provider : null;
  }
  return null;
}
