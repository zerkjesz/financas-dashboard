// ============================================================================
// Fase 7.0, item 19 — observabilidade do pipeline conversacional. Loga o
// suficiente pra entender o que aconteceu (mensagem recebida, classe de
// intenção, nº de actions, confiança, clarificação-vs-execução, dedupe,
// resultado de execução, latência do provider, falha de parsing) SEM NUNCA
// logar segredo/token/auth nem o texto cru da mensagem ou o prompt inteiro —
// só metadados seguros (tamanho, hash curto, contagens, tipos, motivos).
//
// Não existe logger dedicado neste projeto (grep confirmou: zero uso de um
// módulo de log em lib/) — console.log(JSON) de uma linha é o mesmo nível de
// simplicidade que o resto do projeto usa, sem introduzir dependência nova
// só pra isto.
// ============================================================================
import { createHash } from "node:crypto";

// Nunca loga chatId nem texto em claro — só um hash curto, o suficiente pra
// correlacionar linhas do mesmo chat/mensagem entre si sem expor conteúdo.
export function shortHash(text) {
  if (!text) return null;
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 12);
}

export function logPipelineEvent(event, fields = {}) {
  try {
    console.log(JSON.stringify({ scope: "telegram_ai", event, ts: new Date().toISOString(), ...fields }));
  } catch {
    // Logging nunca pode derrubar o pipeline financeiro — falha silenciosa aqui é intencional.
  }
}
