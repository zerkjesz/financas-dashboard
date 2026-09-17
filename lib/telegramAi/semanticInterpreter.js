// ============================================================================
// Fase 7.0 — interpretador semântico. Ponto ÚNICO de contato com o LLM.
// Entra texto + contexto, sai um FinancialIntentPlan JÁ VALIDADO por schema
// — ou um resultado de erro tipado. NUNCA deixa um JSON inválido escapar
// pra fora desta função (item 15).
// ============================================================================
import { buildFinancialInterpreterPrompt } from "./promptBuilder.js";
import { parseAndValidatePlan } from "./financialIntentPlanSchema.js";
import { ProviderUnavailableError, ProviderTimeoutError, ProviderRequestError, ProviderRateLimitError } from "./llmProvider.js";

export const INTERPRETER_RESULT_KIND = Object.freeze({
  OK: "ok",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_ERROR: "provider_error",
  // Fase 7.0.3, item 14 — distinto de PROVIDER_ERROR: o pipeline financeiro
  // trata os dois IGUAL (zero write, mensagem de segurança — nunca um
  // fallback especial pra rate limit), mas quem faz acceptance/scoring
  // real (scripts/telegram-ai-real-acceptance.mjs) precisa saber que ISSO
  // não é uma falha do modelo/prompt, é throttling, pra decidir
  // retry/backoff sem contaminar o scoring.
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  MALFORMED_RESPONSE: "malformed_response",
  MESSAGE_TOO_LONG: "message_too_long",
});

// Fase 7.0.1, item 6 (auditoria do provider real — "request size") — nada
// limitava o tamanho da mensagem antes de mandar pro provider. 4000
// caracteres é generoso o bastante pro pior caso real (o exemplo de 7
// lançamentos numa mensagem só tem ~250 caracteres) mas bloqueia mensagens
// absurdamente grandes ANTES de gastar uma chamada de LLM com elas —
// nunca chega a fazer a requisição.
export const MAX_MESSAGE_LENGTH = 4000;

function extractJsonBlock(raw) {
  // Tolerância mínima: às vezes o modelo cerca a resposta com ```json apesar
  // da instrução explícita — nunca aceita nada além de UM objeto JSON.
  const trimmed = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  return trimmed;
}

export async function interpretFinancialMessage({ text, now, accounts, cards, categories, conversationContext, financialContext, provider }) {
  if (!provider) {
    return { kind: INTERPRETER_RESULT_KIND.PROVIDER_UNAVAILABLE };
  }
  if (typeof text === "string" && text.length > MAX_MESSAGE_LENGTH) {
    return { kind: INTERPRETER_RESULT_KIND.MESSAGE_TOO_LONG };
  }

  const { systemPrompt, userPrompt } = buildFinancialInterpreterPrompt({ text, now, accounts, cards, categories, conversationContext, financialContext });

  let raw, latencyMs, usage;
  try {
    const result = await provider.complete({ systemPrompt, userPrompt });
    raw = result.raw;
    latencyMs = result.latencyMs;
    usage = result.usage ?? null;
  } catch (err) {
    if (err instanceof ProviderUnavailableError) return { kind: INTERPRETER_RESULT_KIND.PROVIDER_UNAVAILABLE };
    if (err instanceof ProviderTimeoutError) return { kind: INTERPRETER_RESULT_KIND.PROVIDER_TIMEOUT };
    if (err instanceof ProviderRateLimitError) return { kind: INTERPRETER_RESULT_KIND.PROVIDER_RATE_LIMITED, retryAfterSeconds: err.retryAfterSeconds };
    if (err instanceof ProviderRequestError) return { kind: INTERPRETER_RESULT_KIND.PROVIDER_ERROR, detail: err.message };
    return { kind: INTERPRETER_RESULT_KIND.PROVIDER_ERROR, detail: err.message };
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(extractJsonBlock(raw));
  } catch {
    return { kind: INTERPRETER_RESULT_KIND.MALFORMED_RESPONSE, detail: "resposta não é JSON válido", latencyMs, usage };
  }

  const validation = parseAndValidatePlan(parsedJson);
  if (!validation.ok) {
    return { kind: INTERPRETER_RESULT_KIND.MALFORMED_RESPONSE, detail: validation.error, latencyMs, usage };
  }

  return { kind: INTERPRETER_RESULT_KIND.OK, plan: validation.plan, latencyMs, usage };
}
