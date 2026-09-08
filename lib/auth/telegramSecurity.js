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

// chatId do Telegram não é segredo (é só um identificador) — comparação
// direta é apropriada aqui (não é uma senha/token, timing-safe não se aplica
// da mesma forma). Sempre compara como string — o update pode trazer number
// ou string dependendo do campo.
export function isAuthorizedTelegramChat(chatId, ownerChatId) {
  if (chatId == null || !ownerChatId) return false;
  return String(chatId) === String(ownerChatId);
}
