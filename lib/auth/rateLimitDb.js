// Fase 5.5 — rate limit AUTORITATIVO de /api/auth/login, em Postgres (mesmo
// banco de tudo — zero provider novo). Substitui o contador só-em-cookie de
// lib/auth/rateLimit.js (Fase 5.3C), cujo achado real da Fase 5.4F.1 foi:
// CLIENT_RESET_RESISTANT = NO — um cliente que não envia/limpa o cookie
// reinicia a contagem a zero. Este arquivo é Node-only (usa node:crypto e
// Prisma) de propósito — só é importado por app/api/auth/login/route.js, que
// já é Node runtime (precisa de node:crypto via lib/auth/password.js pro
// scrypt) — nunca por middleware.js (Edge Runtime), então não precisa da
// portabilidade Web-Crypto de lib/auth/session.js.
import crypto from "node:crypto";
import { prisma } from "../prisma.js";

const MAX_FREE_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 2;
const MAX_BACKOFF_SECONDS = 300; // 5 min — mesmo teto do contador antigo.
const WINDOW_SECONDS = 3600; // 1h sem tentativa nova = janela reseta (mesma semântica do `exp` do cookie antigo).

// Item 9/10 da fase — chave nunca é o IP em texto puro: HMAC-SHA256(scope +
// IP, SESSION_SECRET) — mesmo segredo já exigido pelo resto do sistema de
// auth (SHARED_SECRET_REQUIRED, já verdadeiro antes desta fase), zero
// segredo novo. `x-vercel-forwarded-for` é o header mais confiável possível
// na Vercel (documentação oficial, consultada nesta fase: nunca sobrescrito
// mesmo com proxy na frente do Vercel — diferente de x-forwarded-for, que
// pode ser sobrescrito nesse caso específico). x-forwarded-for continua
// como fallback (cobre dev local atrás de outro proxy e o caso comum) — a
// documentação da Vercel confirma que a própria Vercel sobrescreve esse
// header nas bordas e nunca repassa IP externo forjado, então também é
// confiável em produção. Sem nenhum dos dois (dev local direto): bucket
// "unknown" — todas as tentativas locais sem proxy competem pelo mesmo
// bucket, aceitável pra desenvolvimento.
export function deriveRateLimitKey(request, sessionSecret, scope = "login") {
  const ip =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  return crypto.createHmac("sha256", sessionSecret).update(`${scope}:${ip}`).digest("hex");
}

// isBlocked(key) -> { blocked, blockedUntil } — leitura simples, sem lock
// (não precisa: quem garante corretude sob concorrência é o INCREMENT
// atômico em recordFailure, não a leitura). Se a linha não existir, nunca
// esteve bloqueado.
export async function isBlocked(key, { now = new Date() } = {}) {
  const row = await prisma.loginRateLimit.findUnique({ where: { key } });
  if (!row || !row.blockedUntil) return { blocked: false, blockedUntil: null };
  return { blocked: row.blockedUntil > now, blockedUntil: row.blockedUntil };
}

function computeBackoffSeconds(count) {
  const overflow = Math.max(0, count - MAX_FREE_ATTEMPTS);
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** overflow);
}

// recordFailure(key) -> { count, blockedUntil } — chamado numa senha errada.
//
// Passo 1 (ATÔMICO, uma única instrução SQL): INSERT ... ON CONFLICT DO
// UPDATE com `count = count + 1` resolvido pelo próprio Postgres via lock de
// linha — nunca um SELECT seguido de UPDATE separado (isso teria race
// condition real sob concorrência: dois requests concorrentes leriam o
// mesmo `count` antes de qualquer um escrever, perdendo um incremento).
// Também reseta count/windowStart atomicamente se a janela anterior já
// expirou (>1h sem tentativa).
//
// Passo 2: com o `count` pós-incremento (correto e único por definição do
// lock do passo 1), calcula o novo blockedUntil em JS e grava via
// GREATEST — nunca um `SET blockedUntil = X` incondicional, que sob
// concorrência poderia deixar um request MAIS ANTIGO sobrescrever um bloqueio
// MAIS SEVERO já gravado por um request mais recente com count maior. Isso
// garante blockedUntil monotonicamente não-decrescente mesmo sob
// concorrência real — é o item 16 da fase ("vários requests simultâneos não
// contornam threshold por race condition").
export async function recordFailure(key, { now = new Date() } = {}) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "LoginRateLimit" (key, count, "windowStart", "blockedUntil", "updatedAt")
    VALUES (${key}, 1, ${now}, NULL, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN "LoginRateLimit"."windowStart" < ${now}::timestamp - interval '1 second' * ${WINDOW_SECONDS} THEN 1
        ELSE "LoginRateLimit".count + 1
      END,
      "windowStart" = CASE
        WHEN "LoginRateLimit"."windowStart" < ${now}::timestamp - interval '1 second' * ${WINDOW_SECONDS} THEN ${now}
        ELSE "LoginRateLimit"."windowStart"
      END,
      "updatedAt" = ${now}
    RETURNING count;
  `;
  const count = Number(rows[0].count);

  const backoffSeconds = count > MAX_FREE_ATTEMPTS ? computeBackoffSeconds(count) : 0;
  if (backoffSeconds > 0) {
    const candidateBlockedUntil = new Date(now.getTime() + backoffSeconds * 1000);
    await prisma.$executeRaw`
      UPDATE "LoginRateLimit"
      SET "blockedUntil" = GREATEST(COALESCE("blockedUntil", ${candidateBlockedUntil}), ${candidateBlockedUntil})
      WHERE key = ${key};
    `;
    return { count, blockedUntil: candidateBlockedUntil };
  }
  return { count, blockedUntil: null };
}

// clearAttempts(key) -> void — chamado em login bem-sucedido (mesmo
// comportamento do cookie antigo: reseta o contador do IP que acabou de
// provar a senha certa).
export async function clearAttempts(key) {
  await prisma.loginRateLimit.deleteMany({ where: { key } });
}
