// Fase 7.0.2, item 2 — ANTHROPIC_MODEL precisa ser configurável e o
// provider precisa falhar fechado quando ele (ou a chave) estiver ausente,
// mesmo que o outro esteja presente. Testes puros, sem banco, sem rede.
//
//   node scripts/test-telegram-ai-model-config.mjs
import { createAnthropicProvider, ProviderUnavailableError } from "../lib/telegramAi/llmProvider.js";

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

{
  const p = createAnthropicProvider({ apiKey: "fake-key", model: undefined });
  check("[isAvailable] chave presente, model AUSENTE -> isAvailable=false (fail closed)", p.isAvailable() === false);
}
{
  const p = createAnthropicProvider({ apiKey: "fake-key", model: "" });
  check("[isAvailable] chave presente, model string VAZIA -> isAvailable=false", p.isAvailable() === false);
}
{
  const p = createAnthropicProvider({ apiKey: undefined, model: "claude-sonnet-5" });
  check("[isAvailable] model presente, chave AUSENTE -> isAvailable=false", p.isAvailable() === false);
}
{
  const p = createAnthropicProvider({ apiKey: "fake-key", model: "claude-sonnet-5" });
  check("[isAvailable] chave E model presentes -> isAvailable=true", p.isAvailable() === true);
}
{
  const p = createAnthropicProvider({ apiKey: "fake-key", model: undefined });
  let threw = null;
  try {
    await p.complete({ systemPrompt: "x", userPrompt: "y" });
  } catch (err) {
    threw = err;
  }
  check("[complete] chamar complete() sem model -> lança ProviderUnavailableError, nunca tenta a requisição HTTP", threw instanceof ProviderUnavailableError, threw?.message);
}
{
  // Nunca escolhe outro model silenciosamente — sem model explícito, o
  // default do factory lê SÓ de ANTHROPIC_MODEL (nunca um valor hardcoded).
  const originalModel = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  const p = createAnthropicProvider({ apiKey: "fake-key" });
  check("[default] sem ANTHROPIC_MODEL no ambiente e sem model explícito -> isAvailable=false (nunca inventa um default)", p.isAvailable() === false);
  if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL;
  else process.env.ANTHROPIC_MODEL = originalModel;
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exitCode = fail > 0 ? 1 : 0;
