// Fase 5.5 — rate limit AUTORITATIVO de /api/auth/login, em Postgres (mesmo
// banco de tudo — zero provider novo). Substitui o contador só-em-cookie de
// lib/auth/rateLimit.js (Fase 5.3C), cujo achado real da Fase 5.4F.1 foi:
// CLIENT_RESET_RESISTANT = NO — um cliente que não envia/limpa o cookie
// reinicia a contagem a zero. Este arquivo é Node-only (usa node:crypto e
// Prisma) de propósito — só é importado por app/api/auth/login/route.js, que
// já é Node runtime (precisa de node:crypto via lib/auth/password.js pro
// scrypt) — nunca por middleware.js (Edge Runtime), então não precisa da
// portabilidade Web-Crypto de lib/auth/session.js.
//
// Fase 5.5.1 — dois gaps fechados sobre a 5.5:
//   1. STORAGE BOUNDEDNESS: a 5.5 tinha expiração LÓGICA (janela de 1h) mas
//      nenhuma limpeza FÍSICA — cada IP distinto que erra o login uma vez
//      criava uma linha permanente (storage amplification sob ataque
//      distribuído). Agora `sweepExpired()` faz limpeza oportunista, atômica
//      e BOUNDED (LIMIT fixo) a cada `recordFailure` — nunca full-table
//      delete, nunca cron/provider novo.
//   2. MISSING TRUSTED IP: a 5.5 caía num bucket global "unknown" quando
//      não havia header de IP confiável. Agora, em produção, isso é
//      FAIL_CLOSED (a chave é null e o caller nega a tentativa) — só em
//      desenvolvimento existe um bucket sintético de conveniência.
import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { isProductionRuntime } from "./envConfig.js";

const MAX_FREE_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 2;
const MAX_BACKOFF_SECONDS = 300; // 5 min — mesmo teto do contador antigo.
const WINDOW_SECONDS = 3600; // 1h sem tentativa nova = janela reseta (mesma semântica do `exp` do cookie antigo).
const SWEEP_BATCH_LIMIT = 100; // teto de linhas removidas por limpeza oportunista — nunca full-table.

// Item 11/12/13 da fase — extração da identidade pra rate limit.
//
// `x-vercel-forwarded-for`: header MAIS confiável na Vercel. Documentação
// oficial consultada nesta fase (vercel.com/docs/headers/request-headers,
// last_updated 2025-12-13): "identical to the x-forwarded-for header.
// However, x-forwarded-for could be overwritten if you're using a proxy on
// top of Vercel" — ou seja, `x-vercel-forwarded-for` sobrevive até a um
// proxy na frente do Vercel.
//
// `x-forwarded-for`: também confiável NA Vercel — a doc diz explicitamente
// "we currently overwrite the X-Forwarded-For header and do not forward
// external IPs. This restriction is in place to prevent IP spoofing"
// (exceção: clientes Enterprise com "Trusted Proxy" — não é o caso). É o
// fallback pra dev local atrás de um proxy comum.
//
// Prioridade: x-vercel-forwarded-for > x-forwarded-for (primeiro token).
function extractTrustedIp(request) {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel && vercel.trim()) return vercel.split(",")[0].trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff && xff.trim()) return xff.split(",")[0].trim();
  return null;
}

function hmacKey(sessionSecret, material) {
  return crypto.createHmac("sha256", sessionSecret).update(material).digest("hex");
}

// deriveRateLimitKey -> string (chave HMAC) | null (FAIL_CLOSED).
//
// Item 9/10 da fase — a chave NUNCA é o IP em texto puro: é
// HMAC-SHA256(scope + IP, SESSION_SECRET) — mesmo segredo já exigido pelo
// resto do sistema de auth (SHARED_SECRET_REQUIRED, já verdadeiro antes
// desta fase), zero segredo novo.
//
// Item 13/14 — MISSING TRUSTED IP:
//   - produção (isProduction): retorna null. Sem identidade confiável não
//     dá pra rate-limitar honestamente — e um bucket global compartilhado
//     deixaria um atacante trancar um usuário legítimo. O caller trata null
//     como bloqueio (FAIL_CLOSED). Na prática isso quase nunca dispara: a
//     Vercel SEMPRE seta x-forwarded-for pra tráfego real que passa pela
//     borda dela; null aqui significaria requisição chegando por um caminho
//     anômalo (fora da borda), que é exatamente o que se quer barrar.
//   - desenvolvimento: bucket sintético único ("dev-local-no-ip"). Todas as
//     tentativas locais sem proxy competem por ele — aceitável só em dev,
//     nunca é o comportamento de produção.
export function deriveRateLimitKey(
  request,
  sessionSecret,
  { scope = "login", isProduction = isProductionRuntime() } = {},
) {
  const ip = extractTrustedIp(request);
  if (!ip) {
    if (isProduction) return null; // FAIL_CLOSED — ver comentário acima.
    return hmacKey(sessionSecret, `${scope}:dev-local-no-ip`);
  }
  return hmacKey(sessionSecret, `${scope}:${ip}`);
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

// sweepExpired(now, limit) -> número de linhas removidas.
//
// Item 6/7/8/9 da fase — limpeza FÍSICA (não só expiração lógica) das
// linhas que já não têm efeito nenhum: janela passou (>WINDOW_SECONDS sem
// tentativa nova) E não estão num bloqueio ativo. BOUNDED por `limit` (via
// `ctid IN (SELECT ... LIMIT n)`) — nunca varre-e-apaga a tabela inteira
// numa request de login. Atômico (um único DELETE). Sob volume de app
// pessoal (1 usuário) a tabela raramente passa de dezenas de linhas mesmo
// sob abuso moderado, então o seq scan do subselect é irrelevante; se algum
// dia crescer muito, um índice parcial em "windowStart" seria a otimização
// (não feito agora pra não pagar overhead de escrita num índice a cada
// upsert num cenário que não precisa).
export async function sweepExpired(now = new Date(), limit = SWEEP_BATCH_LIMIT) {
  const cutoff = new Date(now.getTime() - WINDOW_SECONDS * 1000);
  return prisma.$executeRaw`
    DELETE FROM "LoginRateLimit"
    WHERE ctid IN (
      SELECT ctid FROM "LoginRateLimit"
      WHERE "windowStart" < ${cutoff}
        AND ("blockedUntil" IS NULL OR "blockedUntil" < ${now})
      LIMIT ${limit}
    )
  `;
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
//
// Passo 3 (Fase 5.5.1): limpeza oportunista bounded — best-effort, um erro
// aqui NUNCA afeta a decisão de rate limit (só loga).
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
  let blockedUntil = null;
  if (backoffSeconds > 0) {
    const candidateBlockedUntil = new Date(now.getTime() + backoffSeconds * 1000);
    await prisma.$executeRaw`
      UPDATE "LoginRateLimit"
      SET "blockedUntil" = GREATEST(COALESCE("blockedUntil", ${candidateBlockedUntil}), ${candidateBlockedUntil})
      WHERE key = ${key};
    `;
    blockedUntil = candidateBlockedUntil;
  }

  try {
    await sweepExpired(now);
  } catch (err) {
    console.error("[rateLimitDb] sweepExpired falhou (best-effort, não afeta a decisão de rate limit).", err);
  }

  return { count, blockedUntil };
}

// clearAttempts(key) -> void — chamado em login bem-sucedido (mesmo
// comportamento do cookie antigo: reseta o contador do IP que acabou de
// provar a senha certa). Remoção física da linha — nada a expirar depois.
export async function clearAttempts(key) {
  await prisma.loginRateLimit.deleteMany({ where: { key } });
}
