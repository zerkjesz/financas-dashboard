// Fase 5.3C, item 11 do blueprint (docs/schema-v2-blueprint.md) — decisão já
// fechada anteriormente: crypto.scrypt NATIVO do Node, nunca uma dependência
// nova (bcryptjs/argon2) e nunca uma implementação própria de hashing. Este
// arquivo é NODE-ONLY (usa `node:crypto`) de propósito — nunca importado por
// lib/auth/session.js nem por middleware.js, que precisam rodar em runtimes
// (Edge) onde `node:crypto` não existe. Só é importado por rotas de API
// (Node.js runtime garantido pelo Next.js) e pelo script de geração de hash.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384; // 2^14 — mesmo parâmetro recomendado na doc oficial do Node.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// Formato auto-descritivo (guarda os parâmetros junto, pra poder mudar
// N/r/p no futuro sem invalidar hashes antigos): scrypt:N:r:p:saltHex:hashHex
//
// Desvio deliberado do formato originalmente desenhado em
// docs/schema-v2-blueprint.md (que usava "$" como separador, estilo
// bcrypt/PHC): o loader de env do Next.js (`@next/env`) faz interpolação de
// "$NOME"/"${NOME}" nos valores de .env — MESMO dentro de aspas simples —
// então um hash com "$16384$8$1$..." chegava truncado em process.env (cada
// "$8"/"$1" etc. era silenciosamente expandido pra vazio, por não existir
// env var com esse nome). Corrigido usando ":" como separador — nenhum
// caractere especial pro loader de env, comportamento idêntico em todo o
// resto (mesmos parâmetros, mesmo scrypt, mesmo timingSafeEqual).
export function hashPassword(password) {
  if (!password || typeof password !== "string") throw new Error("password é obrigatória");
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

// Compara SEMPRE via timingSafeEqual — nunca === / Buffer.equals() (evita
// vazar por timing quantos bytes iniciais bateram). Formato malformado ->
// false (nunca lança, nunca trata "sem hash configurado" como senha certa).
export function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt, expected;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = scryptSync(password, salt, expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
