// Fase 5.3C — testes unitários PUROS (sem servidor, sem banco) das primitivas
// de segurança. 100% valores fictícios — nenhum segredo real aparece aqui.
import { hashPassword, verifyPassword } from "../lib/auth/password.js";
import { createSessionToken, verifySessionToken, signJson, verifyJson } from "../lib/auth/session.js";
import { verifyTelegramSecret, isAuthorizedTelegramSender } from "../lib/auth/telegramSecurity.js";

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.error(`❌ ${label}`);
  }
}

const FAKE_SECRET_A = "a".repeat(64); // 64 hex chars = 32 bytes fictícios.
const FAKE_SECRET_B = "b".repeat(64);

async function main() {
  console.log("--- Fase 5.3C: testes unitários de segurança (fictício, sem servidor/banco) ---\n");

  // --- password.js ---
  const hash = hashPassword("senha-de-teste-fake-123");
  check(hash.startsWith("scrypt:16384:8:1:"), "[password] hashPassword produz o formato scrypt:N:r:p:salt:hash esperado");
  check(verifyPassword("senha-de-teste-fake-123", hash) === true, "[password] verifyPassword aceita a senha correta");
  check(verifyPassword("senha-errada", hash) === false, "[password] verifyPassword rejeita senha errada");
  check(verifyPassword("", hash) === false, "[password] verifyPassword rejeita senha vazia");
  check(verifyPassword("senha-de-teste-fake-123", null) === false, "[password] verifyPassword rejeita hash ausente (nunca trata 'sem config' como senha certa)");
  check(verifyPassword("senha-de-teste-fake-123", "formato-invalido") === false, "[password] verifyPassword rejeita hash malformado sem lançar");
  // 2 hashes da mesma senha nunca são iguais (salt aleatório por senha).
  check(hashPassword("mesma-senha") !== hashPassword("mesma-senha"), "[password] salt aleatório — 2 hashes da mesma senha são diferentes");

  // --- session.js: signJson/verifyJson genérico ---
  const now = new Date("2026-01-01T00:00:00Z");
  const genericToken = await signJson({ foo: "bar", exp: Math.floor(now.getTime() / 1000) + 60 }, FAKE_SECRET_A);
  check(typeof genericToken === "string" && genericToken.includes("."), "[session] signJson produz um token 'payload.assinatura'");
  const verifiedGeneric = await verifyJson(genericToken, FAKE_SECRET_A, { now });
  check(verifiedGeneric?.foo === "bar", "[session] verifyJson aceita token válido e devolve o payload");
  const verifiedWrongSecret = await verifyJson(genericToken, FAKE_SECRET_B, { now });
  check(verifiedWrongSecret === null, "[session] verifyJson rejeita token assinado com OUTRO secret");
  const tampered = genericToken.slice(0, -2) + "xx";
  check((await verifyJson(tampered, FAKE_SECRET_A, { now })) === null, "[session] verifyJson rejeita token adulterado (assinatura não bate)");
  const future = new Date(now.getTime() + 120 * 1000);
  check((await verifyJson(genericToken, FAKE_SECRET_A, { now: future })) === null, "[session] verifyJson rejeita token expirado, mesmo com assinatura válida");

  // --- session.js: createSessionToken/verifySessionToken ---
  const session = await createSessionToken(FAKE_SECRET_A, { now });
  check(session?.token != null, "[session] createSessionToken produz um token");
  const verifiedSession = await verifySessionToken(session.token, FAKE_SECRET_A, { now });
  check(verifiedSession?.iat != null && verifiedSession?.exp != null, "[session] verifySessionToken aceita sessão recém-criada");
  check((await createSessionToken("secret-curto-demais", { now })) === null, "[session] createSessionToken recusa secret com menos de 32 bytes (64 hex chars)");
  check((await verifySessionToken("token-invalido", FAKE_SECRET_A, { now })) === null, "[session] verifySessionToken rejeita token malformado sem lançar");

  // --- telegramSecurity.js ---
  check(verifyTelegramSecret("segredo-fake-123", "segredo-fake-123") === true, "[telegram] verifyTelegramSecret aceita header correto");
  check(verifyTelegramSecret("segredo-errado", "segredo-fake-123") === false, "[telegram] verifyTelegramSecret rejeita header errado");
  check(verifyTelegramSecret(null, "segredo-fake-123") === false, "[telegram] verifyTelegramSecret rejeita header ausente");
  check(verifyTelegramSecret("segredo-fake-123", null) === false, "[telegram] verifyTelegramSecret rejeita quando não há secret configurado (nunca aceita por omissão)");
  check(verifyTelegramSecret("curto", "segredo-fake-123-bem-mais-longo") === false, "[telegram] verifyTelegramSecret rejeita tamanhos diferentes sem lançar");

  check(isAuthorizedTelegramSender("111222333", "111222333") === true, "[telegram] isAuthorizedTelegramSender aceita o senderId (from.id) configurado");
  check(isAuthorizedTelegramSender(111222333, "111222333") === true, "[telegram] isAuthorizedTelegramSender compara number vs string igual (Telegram manda number)");
  check(isAuthorizedTelegramSender("999888777", "111222333") === false, "[telegram] isAuthorizedTelegramSender rejeita senderId diferente do allowedUserId");
  check(isAuthorizedTelegramSender(null, "111222333") === false, "[telegram] isAuthorizedTelegramSender rejeita senderId ausente");
  check(isAuthorizedTelegramSender("111222333", null) === false, "[telegram] isAuthorizedTelegramSender rejeita quando TELEGRAM_ALLOWED_USER_ID não está configurado (nunca autoriza por omissão)");

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
