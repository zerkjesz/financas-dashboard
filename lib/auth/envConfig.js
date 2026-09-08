// Fase 5.3C — leitura centralizada das env vars de segurança. Portável (sem
// node:crypto/Buffer) — importado por middleware.js (Edge Runtime) e pelas
// rotas de API. Nenhum valor real aparece aqui — só nomes e validação de
// formato/tamanho.

// Next.js sempre seta NODE_ENV=production tanto pra `next build`/`next start`
// quanto pra deployments de preview da Vercel — exatamente o universo que
// deve exigir os segredos reais (fail closed). `next dev` seta development.
export function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

// Bypass de auth SOMENTE em desenvolvimento, SOMENTE se explicitamente
// setado — nunca default, nunca em produção mesmo que a env var esteja
// presente por engano (trava explícita, não confia só em "ninguém vai
// configurar isso na Vercel por engano").
export function isDevBypassEnabled() {
  if (isProductionRuntime()) return false;
  return process.env.AUTH_DEV_BYPASS === "true";
}

// 64 caracteres hex = 32 bytes — o mínimo exigido pelo blueprint (item 11).
export function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 64 || !/^[0-9a-f]+$/i.test(secret)) return null;
  return secret;
}

export function getDashboardPasswordHash() {
  const hash = process.env.DASHBOARD_PASSWORD_HASH;
  if (!hash || !hash.startsWith("scrypt:")) return null;
  return hash;
}

export function getTelegramWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || null;
}

// Fase 5.3C.1, item 26 — renomeado de getOwnerChatId()/OWNER_CHAT_ID: o valor
// guardado é o from.id (identidade do usuário do Telegram), nunca um chat.id
// — ver lib/auth/telegramSecurity.js:isAuthorizedTelegramSender e
// lib/telegramUpdateHandler.js. Nome antigo chamava a coisa errada de "chat".
export function getTelegramAllowedUserId() {
  return process.env.TELEGRAM_ALLOWED_USER_ID || null;
}

// Usado pelo cookie de sessão (Secure só faz sentido sobre HTTPS real).
export function shouldUseSecureCookie() {
  return isProductionRuntime();
}
