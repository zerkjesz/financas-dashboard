// ============================================================================
// Fase 7.0.1, item 1 — flag explícita que resolve a contradição da Fase 7.0
// (timeout/erro do provider = zero write, mas "sem provider configurado" =
// parser legado voltava a operar). Com TELEGRAM_AI_ENABLED, a decisão de
// "existe pipeline novo pra esta conversa" deixa de depender implicitamente
// de "tem ANTHROPIC_API_KEY setada?" e vira uma escolha operacional
// explícita, testável, documentada.
//
// TELEGRAM_AI_ENABLED=false (ou ausente — default seguro): pipeline
// conversacional NUNCA é chamado; comportamento é 100% o parser legado,
// exatamente como se a Fase 7.0 não existisse.
//
// TELEGRAM_AI_ENABLED=true: pipeline conversacional é SEMPRE chamado (quando
// a conversa não pertence ao parser legado — wizard/pending antigo); QUALQUER
// falha dali pra frente (sem chave, timeout, erro HTTP, resposta malformada,
// schema inválido) devolve zero write + mensagem de segurança — NUNCA cai
// pro parser legado nesse caminho. Ver lib/telegramUpdateHandler.js pro
// ponto exato onde esta flag decide o roteamento.
// ============================================================================
export function isTelegramAiEnabled() {
  return process.env.TELEGRAM_AI_ENABLED === "true";
}
