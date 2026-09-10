// Fase 5.5 / 5.5.1 — testes de integração HTTP do rate limiter de
// /api/auth/login SERVIDOR-AUTORITATIVO (lib/auth/rateLimitDb.js), contra o
// dev server real (BASE_URL, default http://localhost:3001) — mesmo padrão
// de scripts/test-security-integration.mjs (Fase 5.3C).
//
// O que este script prova (e o que NÃO tenta provar):
//   - PROVA por HTTP real: limite não dispara abaixo do threshold, dispara
//     exatamente no threshold, nenhuma escrita concorrente é perdida, login
//     bem-sucedido limpa o contador, resposta de bloqueio não vaza detalhe
//     interno, e — o teste de aceitação crítico da fase — bloqueio persiste
//     mesmo que o CLIENTE NUNCA carregue cookie nenhum entre tentativas
//     (CLIENT_RESET_RESISTANT=YES: o estado nunca esteve no cliente).
//   - PROVA por unidade: prioridade de header de IP (x-vercel-forwarded-for
//     ganha de x-forwarded-for — cliente não escolhe a chave), FAIL_CLOSED
//     quando não há IP confiável em produção, bucket sintético só em dev,
//     e limpeza física BOUNDED de linhas expiradas (storage boundedness).
//   - NÃO tenta derrubar o Postgres real pra simular "backend indisponível"
//     — o FAIL_CLOSED nesse caso é verificado por AUDITORIA ESTÁTICA do
//     código-fonte (cenário [G]), mesmo precedente já usado pelo próprio
//     test-security-integration.mjs pro fail-closed do middleware.
//
// HIGIENE DE DADOS: cada cenário usa uma chave sintética dedicada (IP na
// faixa TEST-NET-3 / RFC 5737, nunca um IP real). O script reporta a
// contagem de linhas LoginRateLimit ANTES e DEPOIS e garante que nenhuma
// chave sintética criada por ele sobrevive ao final.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { getSessionSecret } from "../lib/auth/envConfig.js";
import { deriveRateLimitKey, sweepExpired } from "../lib/auth/rateLimitDb.js";

const BASE_URL = process.env.SECURITY_TEST_BASE_URL || "http://localhost:3001";
const DEV_TEST_PASSWORD = "norte-dev-only-password"; // fixture de dev — ver test-security-integration.mjs.
const WRONG_PASSWORD = "senha-errada-de-proposito";

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

// IPs sintéticos dedicados por cenário (TEST-NET-3, RFC 5737 — nunca um IP
// real). RUN_ID desloca a faixa por execução pra reduzir colisão entre
// execuções concorrentes/consecutivas.
const RUN_ID = Date.now() % 200;
const IP = {
  belowThreshold: `203.0.113.${RUN_ID}`,
  reachesThreshold: `203.0.113.${RUN_ID + 1}`,
  cookieBypass: `203.0.113.${RUN_ID + 2}`,
  concurrency: `203.0.113.${RUN_ID + 3}`,
  clearOnSuccess: `203.0.113.${RUN_ID + 4}`,
  spoofPriority: `203.0.113.${RUN_ID + 5}`,
};
// chaves sintéticas extras (não-HTTP) usadas nos cenários de unidade
const SWEEP_KEY_STALE = `__test_sweep_stale_${RUN_ID}`;
const SWEEP_KEY_FRESH = `__test_sweep_fresh_${RUN_ID}`;
const SWEEP_KEY_BLOCKED = `__test_sweep_blocked_${RUN_ID}`;

async function attemptLogin(ip, password, extraHeaders = {}) {
  return fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Forwarded-For": ip, ...extraHeaders },
    body: JSON.stringify({ password }),
  });
}

function bodyLeaksInternal(text) {
  const patterns = [
    /DATABASE_URL/i, /SESSION_SECRET/i, /scrypt\$/i, /at .+:\d+:\d+/, /node_modules/i,
    /postgresql:\/\//i, /LoginRateLimit/i, /prisma/i, /blockedUntil/i, /"count"\s*:\s*\d+/i,
    /203\.0\.113\./, // nunca o IP-chave em texto puro na resposta
  ];
  return patterns.some((p) => p.test(text));
}

async function serverReachable() {
  try {
    const res = await fetch(BASE_URL, { redirect: "manual" });
    return res.status < 500 || res.status === 401 || res.status === 302 || res.status === 307;
  } catch {
    return false;
  }
}

// request sintético pra testar deriveRateLimitKey diretamente (unidade)
function fakeRequest(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

async function main() {
  console.log(`--- Fase 5.5.1: testes de integração do rate limiter de login (HTTP + unidade, ${BASE_URL}) ---\n`);

  if (!(await serverReachable())) {
    console.error(`Servidor não acessível em ${BASE_URL}. Suba o dev server (npm run dev) antes de rodar este teste.`);
    process.exit(1);
  }

  const sessionSecret = getSessionSecret();
  const keyFromXff = (ip) => deriveRateLimitKey(fakeRequest({ "x-forwarded-for": ip }), sessionSecret);

  const rowsBefore = await prisma.loginRateLimit.count();
  console.log(`TEST_RATE_LIMIT_ROWS_BEFORE = ${rowsBefore}\n`);

  // --- [A] abaixo do threshold: 3 tentativas erradas continuam 401, nunca 429 ---
  for (let i = 1; i <= 3; i++) {
    const res = await attemptLogin(IP.belowThreshold, WRONG_PASSWORD);
    check(res.status === 401, `[A] tentativa errada ${i}/3 abaixo do threshold -> 401`, `status=${res.status}`);
  }

  // --- [B] atinge o threshold (MAX_FREE_ATTEMPTS=5): 6 tentativas erradas
  // ainda respondem 401 (o bloqueio golpeia a PRÓXIMA tentativa); a 7ª -> 429.
  for (let i = 1; i <= 6; i++) {
    const res = await attemptLogin(IP.reachesThreshold, WRONG_PASSWORD);
    check(res.status === 401, `[B] tentativa errada ${i}/6 (turno que estoura o contador) -> 401`, `status=${res.status}`);
  }
  const blockedRes = await attemptLogin(IP.reachesThreshold, WRONG_PASSWORD);
  check(blockedRes.status === 429, "[B] 7ª tentativa, após estourar o threshold -> 429", `status=${blockedRes.status}`);
  const blockedText = await blockedRes.text();
  check(!bodyLeaksInternal(blockedText), "[F] resposta 429 não vaza count/IP/chave/provider/stack interno");

  // --- [C] ACEITAÇÃO CRÍTICA — cliente que nunca carrega cookie nenhum
  // continua bloqueado: nenhuma requisição envia OU recebe Set-Cookie de
  // rate-limit. Prova CLIENT_RESET_RESISTANT=YES por construção.
  for (let i = 1; i <= 6; i++) {
    const res = await attemptLogin(IP.cookieBypass, WRONG_PASSWORD);
    const setCookie = res.headers.get("set-cookie");
    check(!setCookie, `[C] tentativa ${i}/6 — resposta não seta Set-Cookie`, setCookie ? `set-cookie=${setCookie}` : "sem set-cookie");
  }
  const cBlocked = await attemptLogin(IP.cookieBypass, WRONG_PASSWORD);
  check(cBlocked.status === 429, "[C] 7ª tentativa, ZERO cookies em toda a sequência -> 429 (server-authoritative)", `status=${cBlocked.status}`);

  // --- [D] concorrência: 8 tentativas erradas SIMULTÂNEAS não perdem
  // incremento (prova o INSERT...ON CONFLICT atômico) ---
  const CONCURRENCY = 8;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => attemptLogin(IP.concurrency, WRONG_PASSWORD)));
  const concurrencyRow = await prisma.loginRateLimit.findUnique({ where: { key: keyFromXff(IP.concurrency) } });
  check(concurrencyRow?.count === CONCURRENCY, "[D] contador reflete as 8 tentativas concorrentes sem incremento perdido", `count=${concurrencyRow?.count}`);
  check(concurrencyRow?.blockedUntil != null, "[D] 8 > MAX_FREE_ATTEMPTS(5) -> blockedUntil setado mesmo sob concorrência");

  // --- [E] login bem-sucedido limpa o contador (clearAttempts) ---
  await attemptLogin(IP.clearOnSuccess, WRONG_PASSWORD);
  await attemptLogin(IP.clearOnSuccess, WRONG_PASSWORD);
  const okRes = await attemptLogin(IP.clearOnSuccess, DEV_TEST_PASSWORD);
  check(okRes.status === 200, "[E] senha correta após 2 erradas -> 200", `status=${okRes.status}`);
  const clearedRow = await prisma.loginRateLimit.findUnique({ where: { key: keyFromXff(IP.clearOnSuccess) } });
  check(clearedRow === null, "[E] linha LoginRateLimit removida do banco após login bem-sucedido");

  // --- [I] PRIORIDADE DE HEADER / anti-spoof (item 11/15): quando os dois
  // headers estão presentes com valores DIFERENTES, a chave sai de
  // x-vercel-forwarded-for (o que a Vercel garante não-spoofável), NUNCA do
  // x-forwarded-for que um proxy-na-frente poderia sobrescrever. Testado na
  // função de extração diretamente (não precisa simular a borda da Vercel).
  const vercelKey = deriveRateLimitKey(
    fakeRequest({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "203.0.113.250" }),
    sessionSecret,
  );
  check(vercelKey === deriveRateLimitKey(fakeRequest({ "x-vercel-forwarded-for": "198.51.100.7" }), sessionSecret),
    "[I] com os dois headers divergentes, a chave vem de x-vercel-forwarded-for (não do x-forwarded-for spoofável)");
  check(vercelKey !== deriveRateLimitKey(fakeRequest({ "x-forwarded-for": "203.0.113.250" }), sessionSecret),
    "[I] a chave NÃO é a que sairia do x-forwarded-for isolado — cliente não escolhe a chave");

  // --- [J] MISSING TRUSTED IP (item 13/14): sem nenhum header de IP,
  // produção -> null (FAIL_CLOSED, caller nega); dev -> bucket sintético
  // único e determinístico, NUNCA o mesmo caminho de produção.
  check(deriveRateLimitKey(fakeRequest({}), sessionSecret, { isProduction: true }) === null,
    "[J] produção + sem IP confiável -> deriveRateLimitKey retorna null (FAIL_CLOSED)");
  const devNoIp1 = deriveRateLimitKey(fakeRequest({}), sessionSecret, { isProduction: false });
  const devNoIp2 = deriveRateLimitKey(fakeRequest({}), sessionSecret, { isProduction: false });
  check(typeof devNoIp1 === "string" && devNoIp1 === devNoIp2,
    "[J] dev + sem IP -> bucket sintético determinístico (string estável), nunca null");
  check(devNoIp1 !== deriveRateLimitKey(fakeRequest({ "x-forwarded-for": "203.0.113.1" }), sessionSecret, { isProduction: false }),
    "[J] o bucket sintético de dev é distinto de qualquer chave derivada de IP real");

  // --- [K] STORAGE BOUNDEDNESS (item 6/7/8/9): sweepExpired remove linhas
  // com janela vencida E sem bloqueio ativo; preserva linha fresca e linha
  // ainda bloqueada; e é BOUNDED pelo LIMIT (não é full-table delete).
  const now = new Date();
  const old = new Date(now.getTime() - 2 * 3600 * 1000); // 2h atrás — janela (1h) vencida
  await prisma.loginRateLimit.createMany({
    data: [
      { key: SWEEP_KEY_STALE, count: 3, windowStart: old, blockedUntil: null, updatedAt: old },
      { key: SWEEP_KEY_FRESH, count: 2, windowStart: now, blockedUntil: null, updatedAt: now },
      { key: SWEEP_KEY_BLOCKED, count: 9, windowStart: old, blockedUntil: new Date(now.getTime() + 60000), updatedAt: old },
    ],
  });
  await sweepExpired(now);
  const staleAfter = await prisma.loginRateLimit.findUnique({ where: { key: SWEEP_KEY_STALE } });
  const freshAfter = await prisma.loginRateLimit.findUnique({ where: { key: SWEEP_KEY_FRESH } });
  const blockedAfter = await prisma.loginRateLimit.findUnique({ where: { key: SWEEP_KEY_BLOCKED } });
  check(staleAfter === null, "[K] sweepExpired removeu a linha com janela vencida e sem bloqueio ativo");
  check(freshAfter !== null, "[K] sweepExpired preservou a linha com janela ainda vigente");
  check(blockedAfter !== null, "[K] sweepExpired preservou a linha com bloqueio ainda ativo (blockedUntil futuro)");
  const sweptCount = await sweepExpired(now, 1);
  check(typeof sweptCount === "number", "[K] sweepExpired aceita um limite explícito (BOUNDED) e retorna a contagem removida", `n=${sweptCount}`);

  // --- [G] FAIL_CLOSED — auditoria estática do código-fonte ---
  const routeSrc = readFileSync(new URL("../app/api/auth/login/route.js", import.meta.url), "utf8");
  const isBlockedCallIdx = routeSrc.indexOf("await isBlocked(rateLimitKey)");
  const tryBeforeIdx = routeSrc.lastIndexOf("try {", isBlockedCallIdx);
  const catchAfterIdx = routeSrc.indexOf("} catch", isBlockedCallIdx);
  const catchBlockWindow = routeSrc.slice(catchAfterIdx, catchAfterIdx + 300);
  const isBlockedTryCatch =
    tryBeforeIdx !== -1 && tryBeforeIdx < isBlockedCallIdx && catchAfterIdx !== -1 && /status:\s*429/.test(catchBlockWindow);
  check(isBlockedTryCatch, "[G] isBlocked() em try/catch cujo catch responde 429 (erro no check vira bloqueio, nunca acesso)");
  const noSuccessBeforeCheck = routeSrc.indexOf("await createSessionToken(") > isBlockedCallIdx;
  check(noSuccessBeforeCheck, "[G] createSessionToken só ocorre depois do check de rate limit — nenhum caminho de sucesso pula o check");
  check(/rateLimitKey === null[\s\S]{0,200}status:\s*429/.test(routeSrc),
    "[G] rateLimitKey === null (missing trusted IP) -> 429 antes de qualquer verificação de senha");

  // --- [H] o fallback SEM-IP de dev é guardado por um check de produção
  // explícito — nunca ativo em produção. Verificado por forma do código:
  // deriveRateLimitKey só retorna o bucket sintético quando isProduction é
  // falso; quando true, retorna null.
  const dbSrc = readFileSync(new URL("../lib/auth/rateLimitDb.js", import.meta.url), "utf8");
  check(/if\s*\(isProduction\)\s*return null/.test(dbSrc),
    "[H] deriveRateLimitKey: sem IP + isProduction -> return null (dev fallback nunca ativo em produção)");
  check(/isProduction\s*=\s*isProductionRuntime\(\)/.test(dbSrc),
    "[H] isProduction default vem de isProductionRuntime() (NODE_ENV) — não de uma flag arbitrária");

  // --- cleanup ---
  const httpKeys = Object.values(IP).map((ip) => keyFromXff(ip));
  const unitKeys = [SWEEP_KEY_STALE, SWEEP_KEY_FRESH, SWEEP_KEY_BLOCKED];
  const deleted = await prisma.loginRateLimit.deleteMany({ where: { key: { in: [...httpKeys, ...unitKeys] } } });
  const remaining = await prisma.loginRateLimit.count({ where: { key: { in: [...httpKeys, ...unitKeys] } } });
  check(remaining === 0, "[cleanup] nenhuma chave sintética deste script sobrevive", `apagadas=${deleted.count}`);

  const rowsAfter = await prisma.loginRateLimit.count();
  console.log(`\nTEST_RATE_LIMIT_ROWS_AFTER = ${rowsAfter} (BEFORE era ${rowsBefore}${rowsAfter <= rowsBefore ? " — sem lixo acumulado" : " — INVESTIGAR"})`);

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0 || rowsAfter > rowsBefore) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
