import { signJson, verifyJson } from "./session.js";

// Fase 5.3C, blueprint item 11 — rate limit do login SEM storage novo
// (Vercel KV/Redis seria a solução robusta, mas é dependência nova pra um
// app pessoal de URL obscura — deferido como upgrade futuro, documentado,
// não implementado agora). Proposta mínima: contador de tentativas falhas
// num cookie ASSINADO (mesmo HMAC de session.js) — à prova de adulteração
// client-side (o cliente não consegue forjar um contador zerado sem o
// SESSION_SECRET), mas não persiste entre processos server diferentes
// (limitação honesta de function serverless efêmera, documentada aqui e no
// blueprint).
export const RATE_LIMIT_COOKIE_NAME = "norte_login_attempts";
const MAX_FREE_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 2;
const MAX_BACKOFF_SECONDS = 300; // 5 min

// readAttemptState(cookieValue, secretHex) -> { count, blockedUntil } (nunca lança)
export async function readAttemptState(cookieValue, secretHex, { now = new Date() } = {}) {
  if (!cookieValue) return { count: 0, blockedUntil: 0 };
  const payload = await verifyJson(cookieValue, secretHex, { now });
  if (!payload || typeof payload.count !== "number") return { count: 0, blockedUntil: 0 };
  return { count: payload.count, blockedUntil: payload.blockedUntil || 0 };
}

export function isBlocked(state, { now = new Date() } = {}) {
  return state.blockedUntil > Math.floor(now.getTime() / 1000);
}

// Backoff exponencial: 2^(tentativas acima do limite livre) segundos, com teto.
function computeBackoffSeconds(count) {
  const overflow = Math.max(0, count - MAX_FREE_ATTEMPTS);
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** overflow);
}

// recordFailure(state, secretHex) -> novo cookie value assinado, pra falha de senha.
export async function recordFailure(state, secretHex, { now = new Date() } = {}) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const count = state.count + 1;
  const backoff = count > MAX_FREE_ATTEMPTS ? computeBackoffSeconds(count) : 0;
  const payload = { count, blockedUntil: backoff > 0 ? nowSeconds + backoff : 0, exp: nowSeconds + 3600 };
  return signJson(payload, secretHex);
}

// clearAttempts() -> null (sinaliza pro caller apagar o cookie) — chamado em login bem-sucedido.
export function clearAttempts() {
  return null;
}
