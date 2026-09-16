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
  constructor(reason, status) {
    super(reason || "Provedor de LLM retornou um erro.");
    this.name = "ProviderRequestError";
    this.status = status;
  }
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
        if (!res.ok) {
          throw new ProviderRequestError(`Anthropic respondeu ${res.status}`, res.status);
        }
        const data = await res.json();
        const raw = (data.content || []).map((block) => (block.type === "text" ? block.text : "")).join("");
        return { raw, latencyMs };
      } catch (err) {
        if (err.name === "AbortError") throw new ProviderTimeoutError();
        if (err instanceof ProviderRequestError || err instanceof ProviderUnavailableError) throw err;
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

// Fábrica única usada pelo pipeline real (nunca escolhe "escrever com uma
// interpretação pior" quando não há provider — item 16: "Não colocar
// fallback que silenciosamente execute escrita financeira usando uma
// interpretação pior"). `null` = "sem interpretador semântico disponível
// agora", tratado explicitamente pelo pipeline (item 21).
export function getConfiguredProvider() {
  const provider = createAnthropicProvider();
  return provider.isAvailable() ? provider : null;
}
