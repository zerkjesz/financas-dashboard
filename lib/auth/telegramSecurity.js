import { timingSafeEqual } from "node:crypto";

// Fase 5.3C, itens 12/13 — Node-only (node:crypto), usado só pelo webhook
// route.js (Node.js runtime garantido) e pelo bot local (bot/telegram-bot.js,
// processo Node puro) — nunca por middleware.js/lib/auth/session.js.

// Compara o header X-Telegram-Bot-Api-Secret-Token contra o segredo
// configurado. Nunca ===/comparação direta de string (timing-safe sempre) —
// tamanhos diferentes já retornam false sem chamar timingSafeEqual (que
// lançaria com buffers de tamanho diferente).
export function verifyTelegramSecret(headerValue, expectedSecret) {
  if (!headerValue || !expectedSecret) return false;
  const a = Buffer.from(headerValue, "utf8");
  const b = Buffer.from(expectedSecret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Fase 5.3C.1, item 1 — RENOMEADO de isAuthorizedTelegramChat (Fase 5.3C).
// chat.id != from.id (ver lib/telegramUpdateHandler.js:extractIdentity) — a
// autorização financeira precisa ser da IDENTIDADE DE QUEM ENVIOU (sender,
// from.id), nunca do chat em si (que numa conversa privada 1:1 coincide
// numericamente com o id do usuário por particularidade do Telegram, mas
// isso é um detalhe de implementação do Telegram, não uma garantia de
// identidade — em grupo/canal chat.id e from.id são coisas completamente
// diferentes). O nome desta função agora reflete exatamente o que ela
// checa: o SENDER, não o chat.
//
// senderId/allowedUserId não são segredo (são só identificadores) —
// comparação direta é apropriada (timing-safe não se aplica da mesma forma
// que a um token). Sempre compara como string — o update pode trazer number
// ou string dependendo do campo.
export function isAuthorizedTelegramSender(senderId, allowedUserId) {
  if (senderId == null || !allowedUserId) return false;
  return String(senderId) === String(allowedUserId);
}
