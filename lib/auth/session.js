// Fase 5.3C — tokens assinados stateless (sem tabela nova no banco, ver
// blueprint item 11): payload sempre inclui `exp`, assinado por HMAC-SHA256.
// Usado tanto pro token de SESSÃO ({ iat, exp }, sem dado sensível) quanto
// pelo contador de rate-limit do login (lib/auth/rateLimit.js) — mesmo
// mecanismo genérico, dois usos.
//
// Este arquivo é PORTÁVEL de propósito — usa só Web Crypto API
// (`crypto.subtle`, `TextEncoder`, `atob`/`btoa`), nunca `node:crypto` nem
// `Buffer` — porque é importado por middleware.js, que roda no Edge Runtime
// por padrão (sem `node:crypto`/`Buffer` disponíveis). `lib/auth/password.js`
// (Node-only, scrypt) é um arquivo SEPARADO exatamente por isso.
export const SESSION_COOKIE_NAME = "norte_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias — app pessoal, não banking real-time.

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}

async function importHmacKey(secretHex) {
  const keyBytes = hexToBytes(secretHex);
  if (!keyBytes || keyBytes.length < 32) return null; // exige 32+ bytes (64+ chars hex) — nunca aceita um segredo curto/fraco silenciosamente.
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ============================================================================
// Genérico — qualquer payload JSON serializável, sempre com `exp` embutido.
// ============================================================================

export async function signJson(payload, secretHex) {
  const key = await importHmacKey(secretHex);
  if (!key) return null;

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = bytesToBase64Url(payloadBytes);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

// Verificação de assinatura via crypto.subtle.verify (constant-time por
// construção da Web Crypto API — nunca uma comparação manual de bytes aqui).
// Rejeita se `payload.exp` existir e já tiver passado.
export async function verifyJson(token, secretHex, { now = new Date() } = {}) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  const key = await importHmacKey(secretHex);
  if (!key) return null;

  let signatureBytes;
  try {
    signatureBytes = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(payloadB64));
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  } catch {
    return null;
  }

  if (typeof payload.exp === "number") {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (nowSeconds >= payload.exp) return null; // expirado — nunca aceito, mesmo com assinatura válida.
  }

  return payload;
}

// ============================================================================
// Sessão de login ({ iat, exp } — nunca senha/hash/dado sensível dentro).
// ============================================================================

export async function createSessionToken(secretHex, { now = new Date(), ttlSeconds = SESSION_TTL_SECONDS } = {}) {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const token = await signJson({ iat, exp }, secretHex);
  if (!token) return null;
  return { token, exp };
}

export async function verifySessionToken(token, secretHex, { now = new Date() } = {}) {
  const payload = await verifyJson(token, secretHex, { now });
  if (!payload || typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
  return payload;
}
