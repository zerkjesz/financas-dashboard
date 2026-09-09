// Fase 5.5 — testes de integração HTTP do rate limiter de /api/auth/login
// SERVIDOR-AUTORITATIVO (lib/auth/rateLimitDb.js), contra o dev server real
// (BASE_URL, default http://localhost:3001) — mesmo padrão de
// scripts/test-security-integration.mjs (Fase 5.3C).
//
// O que este script prova (e o que NÃO tenta provar):
//   - PROVA por HTTP real: limite não dispara abaixo do threshold, dispara
//     exatamente no threshold, nenhuma escrita concorrente é perdida (chave
//     dedicada por cenário evita colisão com outros scripts/usuários reais),
//     login bem-sucedido limpa o contador, resposta de bloqueio não vaza
//     detalhe interno, e — o teste de aceitação crítico da fase — bloqueio
//     persiste mesmo que o CLIENTE NUNCA carregue cookie nenhum entre
//     tentativas (prova de CLIENT_RESET_RESISTANT=YES: o estado nunca esteve
//     no cliente pra começo de conversa).
//   - NÃO tenta derrubar o Postgres real pra simular "backend indisponível"
//     (arriscado/desproporcional num banco de dev compartilhado) — o
//     comportamento FAIL_CLOSED nesse caso é verificado por AUDITORIA
//     ESTÁTICA do código-fonte (cenário [G] abaixo), mesmo precedente já
//     usado pelo próprio test-security-integration.mjs pro fail-closed de
//     produção do middleware (ver comentário "G/production fail-closed"
//     nesse arquivo).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { getSessionSecret } from "../lib/auth/envConfig.js";
import { deriveRateLimitKey } from "../lib/auth/rateLimitDb.js";

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

// IPs sintéticos dedicados por cenário (faixa TEST-NET-3 reservada por RFC
// 5737 — nunca um IP real de usuário) — cada cenário usa a sua pra nunca
// colidir com outro cenário deste script, com outros scripts rodando em
// paralelo, ou com o bucket "unknown" usado por chamadas sem nenhum header
// de IP (ex: test-security-integration.mjs, que não seta x-forwarded-for).
const RUN_ID = Date.now() % 1000;
const IP = {
  belowThreshold: `203.0.113.${RUN_ID}`,
  reachesThreshold: `203.0.113.${(RUN_ID + 1) % 256}`,
  cookieBypass: `203.0.113.${(RUN_ID + 2) % 256}`,
  concurrency: `203.0.113.${(RUN_ID + 3) % 256}`,
  clearOnSuccess: `203.0.113.${(RUN_ID + 4) % 256}`,
};

async function attemptLogin(ip, password) {
  return fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Forwarded-For": ip },
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

async function main() {
  console.log(`--- Fase 5.5: testes de integração do rate limiter de login (HTTP, ${BASE_URL}) ---\n`);

  if (!(await serverReachable())) {
    console.error(`Servidor não acessível em ${BASE_URL}. Suba o dev server (npm run dev) antes de rodar este teste.`);
    process.exit(1);
  }

  const sessionSecret = getSessionSecret();
  const fakeRequest = (ip) => ({ headers: { get: (name) => (name.toLowerCase() === "x-forwarded-for" ? ip : null) } });

  // --- [A] abaixo do threshold: 3 tentativas erradas continuam 401, nunca 429 ---
  for (let i = 1; i <= 3; i++) {
    const res = await attemptLogin(IP.belowThreshold, WRONG_PASSWORD);
    check(res.status === 401, `[A] tentativa errada ${i}/3 abaixo do threshold -> 401`, `status=${res.status}`);
  }

  // --- [B] atinge o threshold (MAX_FREE_ATTEMPTS=5): 6 tentativas erradas
  // ainda respondem 401 (o bloqueio golpeia a PRÓXIMA tentativa, não a que
  // acabou de estourar o contador — ver comentário de recordFailure em
  // lib/auth/rateLimitDb.js); a 7ª já é negada por limite -> 429.
  for (let i = 1; i <= 6; i++) {
    const res = await attemptLogin(IP.reachesThreshold, WRONG_PASSWORD);
    check(res.status === 401, `[B] tentativa errada ${i}/6 (ainda dentro do turno que estoura o contador) -> 401`, `status=${res.status}`);
  }
  const blockedRes = await attemptLogin(IP.reachesThreshold, WRONG_PASSWORD);
  check(blockedRes.status === 429, "[B] 7ª tentativa, após estourar o threshold -> 429", `status=${blockedRes.status}`);
  const blockedText = await blockedRes.text();
  check(!bodyLeaksInternal(blockedText), "[F] resposta 429 não vaza count/IP/chave/provider/stack interno");

  // --- [C] TESTE DE ACEITAÇÃO CRÍTICO DA FASE — cliente que nunca carrega
  // cookie nenhum entre tentativas continua bloqueado: nenhuma requisição
  // deste cenário envia OU recebe Cookie/Set-Cookie de rate-limit (o
  // servidor nunca emite nenhum — o estado nunca esteve no cliente). Prova
  // CLIENT_RESET_RESISTANT=YES por construção, não por inferência.
  for (let i = 1; i <= 6; i++) {
    const res = await attemptLogin(IP.cookieBypass, WRONG_PASSWORD);
    const setCookie = res.headers.get("set-cookie");
    check(!setCookie, `[C] tentativa ${i}/6 sem cookie enviado nem recebido — resposta não seta Set-Cookie de rate-limit`, setCookie ? `set-cookie=${setCookie}` : "sem set-cookie");
  }
  const cBlocked = await attemptLogin(IP.cookieBypass, WRONG_PASSWORD);
  check(cBlocked.status === 429, "[C] 7ª tentativa, ZERO cookies trocados em toda a sequência -> ainda assim 429 (server-authoritative, não client-resettable)", `status=${cBlocked.status}`);

  // --- [D] concorrência: N tentativas erradas SIMULTÂNEAS não perdem
  // incremento (prova o INSERT...ON CONFLICT atômico de recordFailure) ---
  const CONCURRENCY = 8;
  await Promise.all(Array.from({ length: CONCURRENCY }, () => attemptLogin(IP.concurrency, WRONG_PASSWORD)));
  const concurrencyKey = deriveRateLimitKey(fakeRequest(IP.concurrency), sessionSecret);
  const concurrencyRow = await prisma.loginRateLimit.findUnique({ where: { key: concurrencyKey } });
  check(concurrencyRow?.count === CONCURRENCY, "[D] contador reflete as 8 tentativas concorrentes sem incremento perdido", `count=${concurrencyRow?.count}`);
  check(concurrencyRow?.blockedUntil != null, "[D] 8 > MAX_FREE_ATTEMPTS(5) -> blockedUntil setado mesmo sob concorrência");

  // --- [E] login bem-sucedido limpa o contador (clearAttempts) ---
  await attemptLogin(IP.clearOnSuccess, WRONG_PASSWORD);
  await attemptLogin(IP.clearOnSuccess, WRONG_PASSWORD);
  const okRes = await attemptLogin(IP.clearOnSuccess, DEV_TEST_PASSWORD);
  check(okRes.status === 200, "[E] senha correta (fixture dev) após 2 erradas -> 200", `status=${okRes.status}`);
  const clearKey = deriveRateLimitKey(fakeRequest(IP.clearOnSuccess), sessionSecret);
  const clearedRow = await prisma.loginRateLimit.findUnique({ where: { key: clearKey } });
  check(clearedRow === null, "[E] linha LoginRateLimit removida do banco após login bem-sucedido (clearAttempts)");

  // --- [G] FAIL_CLOSED — auditoria estática do código-fonte, mesmo
  // precedente do "G/production fail-closed" em test-security-integration.mjs
  // (simular DB indisponível contra o Postgres real de dev é desproporcional
  // e arriscado; a garantia é verificada por forma do código, não por E2E) ---
  const routeSrc = readFileSync(new URL("../app/api/auth/login/route.js", import.meta.url), "utf8");
  const isBlockedCallIdx = routeSrc.indexOf("await isBlocked(rateLimitKey)");
  const tryBeforeIdx = routeSrc.lastIndexOf("try {", isBlockedCallIdx);
  const catchAfterIdx = routeSrc.indexOf("} catch", isBlockedCallIdx);
  // janela do bloco catch em si (até o próximo "return" logo em seguida, que
  // é onde o status da resposta de erro fica) — evita depender de contar
  // chaves aninhadas (o corpo do catch tem `{ status: 429 }`, que quebraria
  // um regex ingênuo baseado em `[^}]*`).
  const catchBlockWindow = routeSrc.slice(catchAfterIdx, catchAfterIdx + 300);
  const isBlockedTryCatch =
    tryBeforeIdx !== -1 &&
    tryBeforeIdx < isBlockedCallIdx &&
    catchAfterIdx !== -1 &&
    /status:\s*429/.test(catchBlockWindow);
  check(isBlockedTryCatch, "[G] isBlocked() está em try/catch cujo catch responde 429 (fail-closed: erro no check vira bloqueio, nunca acesso liberado)");
  // usa a CHAMADA (`await createSessionToken(`), não o import do topo do
  // arquivo, que naturalmente vem antes de tudo e daria falso-negativo.
  const noSuccessBeforeCheck = routeSrc.indexOf("await createSessionToken(") > isBlockedCallIdx;
  check(noSuccessBeforeCheck, "[G] criação de sessão (createSessionToken) só ocorre depois do check de rate limit no código-fonte — nenhum caminho de sucesso pula o check");

  // --- [H] sem fallback dev separado a guardar: rateLimitDb.js sempre usa o
  // mesmo Prisma/Postgres de todo o resto do app (DATABASE_URL padrão), sem
  // nenhum branch condicional por ambiente — logo não existe um "modo dev
  // client-resettable" residual que precise do guard DATABASE_ENV=development
  // do item 14. Verificado por ausência: nenhuma referência a
  // process.env.DATABASE_ENV/NODE_ENV dentro do próprio rateLimitDb.js.
  const dbSrc = readFileSync(new URL("../lib/auth/rateLimitDb.js", import.meta.url), "utf8");
  check(!/DATABASE_ENV|NODE_ENV/.test(dbSrc), "[H] rateLimitDb.js não tem branch por ambiente — mesmo enforcement em dev/prod, nada a guardar por DATABASE_ENV");

  // --- cleanup: apaga só as linhas sintéticas criadas por este script (por
  // IP dedicado — nunca toca em nenhuma linha real de outro IP) ---
  const testKeys = Object.values(IP).map((ip) => deriveRateLimitKey(fakeRequest(ip), sessionSecret));
  const deleted = await prisma.loginRateLimit.deleteMany({ where: { key: { in: testKeys } } });
  check(deleted.count >= 4, "[cleanup] linhas LoginRateLimit sintéticas deste script removidas", `deleted=${deleted.count}`);

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
