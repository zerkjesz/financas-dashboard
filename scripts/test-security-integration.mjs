// Fase 5.3C — testes de integração HTTP contra o dev server real (precisa
// estar rodando em BASE_URL, default http://localhost:3001). Exercita
// middleware.js + rotas de auth/webhook de ponta a ponta — algo que um teste
// puro (sem servidor) não consegue provar (cookies, headers, redirects).
//
// A senha usada aqui ("norte-dev-only-password") é um FIXTURE DE TESTE
// gerado só pra este ambiente DEV local (ver scripts/generate-password-hash.mjs
// e o .env gitignored desta máquina) — nunca a senha real de produção, nunca
// versionada em lugar nenhum que valha fora deste .env local.
//
// Correção de semântica (Fase 5.3C.1, item 24): este script cria e apaga 1
// Goal SINTÉTICO (teste [E]) — não é "zero writes" absoluto. Classificação
// precisa:
//   TEMPORARY_SYNTHETIC_TEST_WRITE = YES (1 Goal fictício, criado e apagado
//     dentro deste mesmo script)
//   ZERO_REAL_USER_FINANCIAL_WRITES = YES (nenhum dado financeiro REAL do
//     usuário é tocado)
//   FINAL_FINANCIAL_STATE_DIFF = ZERO (fingerprint antes/depois do script
//     inteiro é idêntico — o create+delete se cancela)
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";

const BASE_URL = process.env.SECURITY_TEST_BASE_URL || "http://localhost:3001";
const DEV_TEST_PASSWORD = "norte-dev-only-password"; // ver nota acima — fixture, não segredo real.
const MARK = "TESTE_SECURITY_53C";

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

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment",
  "cardLimitUpdate", "purchase", "installment", "cardBill", "recurringRule",
  "bill", "goal", "reserve", "reserveMovement", "externalInstallmentPlan",
  "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "cardCreditMovement", "appSettings",
];
async function fingerprint() {
  const counts = {};
  for (const model of FINANCIAL_MODELS) counts[model] = await prisma[model].count();
  return counts;
}
function fingerprintsEqual(a, b) {
  return FINANCIAL_MODELS.every((m) => a[m] === b[m]);
}

function bodyLeaksSecret(text) {
  const patterns = [/DATABASE_URL/i, /SESSION_SECRET/i, /TELEGRAM_WEBHOOK_SECRET/i, /scrypt\$/i, /at .+:\d+:\d+/, /node_modules/i, /postgresql:\/\//i];
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
  console.log(`--- Fase 5.3C: testes de integração de segurança (HTTP, ${BASE_URL}) ---\n`);

  if (!(await serverReachable())) {
    console.error(`Servidor não acessível em ${BASE_URL}. Suba o dev server (npm run dev) antes de rodar este teste.`);
    process.exit(1);
  }

  const before = await fingerprint();

  // --- A: protected GET rejects unauthenticated ---
  const dashNoAuth = await fetch(`${BASE_URL}/api/dashboard`);
  check(dashNoAuth.status === 401, "[A] GET /api/dashboard sem sessão -> 401", `status=${dashNoAuth.status}`);
  const dashNoAuthText = await dashNoAuth.text();
  check(!bodyLeaksSecret(dashNoAuthText), "[O] resposta 401 não vaza secret/stack/DATABASE_URL");

  // --- login: senha errada ---
  const loginWrong = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ password: "senha-errada-de-proposito" }),
  });
  check(loginWrong.status === 401, "[login] senha errada -> 401", `status=${loginWrong.status}`);

  // --- login: senha correta (fixture de dev) ---
  const loginOk = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ password: DEV_TEST_PASSWORD }),
  });
  check(loginOk.status === 200, "[login] senha correta (fixture dev) -> 200", `status=${loginOk.status}`);
  const setCookie = loginOk.headers.get("set-cookie") || "";
  check(setCookie.includes("norte_session="), "[login] Set-Cookie inclui norte_session");
  check(/HttpOnly/i.test(setCookie), "[F] cookie de sessão é HttpOnly (JS do navegador não lê)");
  check(/SameSite=Lax/i.test(setCookie), "[F] cookie de sessão usa SameSite=Lax");
  const sessionCookie = setCookie.split(";")[0];

  // --- B: protected GET accepts authenticated ---
  const dashAuth = await fetch(`${BASE_URL}/api/dashboard`, { headers: { Cookie: sessionCookie } });
  check(dashAuth.status === 200, "[B] GET /api/dashboard com sessão válida -> 200", `status=${dashAuth.status}`);
  const dashPayload = await dashAuth.json();
  check(dashPayload?.financial?.liquidity != null, "[P] payload autenticado continua trazendo financial.liquidity (read-model intacto)");

  // --- C: mutation rejects unauthenticated ---
  const mutNoAuth = await fetch(`${BASE_URL}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ name: `${MARK} sem auth`, targetAmount: 1 }),
  });
  check(mutNoAuth.status === 401, "[C] POST /api/goals sem sessão -> 401", `status=${mutNoAuth.status}`);

  // --- D: cookie-auth mutation rejects invalid origin ---
  const mutBadOrigin = await fetch(`${BASE_URL}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: "https://attacker.example" },
    body: JSON.stringify({ name: `${MARK} origem invalida`, targetAmount: 1 }),
  });
  check(mutBadOrigin.status === 403, "[D] POST /api/goals com sessão válida mas Origin cross-site -> 403", `status=${mutBadOrigin.status}`);

  // --- E: valid same-origin authenticated mutation passes the guard ---
  // (cria 1 Goal fictício e apaga no mesmo teste — fingerprint geral do
  // script continua ZERO DIFF, mesmo padrão já usado nos outros test-*.mjs
  // do projeto: create+cleanup dentro do próprio teste.)
  const mutOk = await fetch(`${BASE_URL}/api/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: BASE_URL },
    body: JSON.stringify({ name: `${MARK} goal`, targetAmount: 1 }),
  });
  check(mutOk.status >= 200 && mutOk.status < 300, "[E] POST /api/goals com sessão + Origin same-site -> passa o guard (chega no handler)", `status=${mutOk.status}`);
  const createdGoal = mutOk.ok ? await mutOk.json() : null;
  if (createdGoal?.id) {
    // DELETE /api/goals/[id] é soft-delete (isActive=false) — não restaura a
    // CONTAGEM da fingerprint. Cleanup real via prisma direto (mesmo padrão
    // já usado nos outros test-*.mjs do projeto) pra garantir zero diff
    // líquido no fingerprint do script inteiro.
    const deleted = await prisma.goal.deleteMany({ where: { id: createdGoal.id } });
    check(deleted.count === 1, "[E] cleanup: Goal fictício de teste removido (delete real, não soft-delete)");
  }

  // --- G/production fail-closed: verificado por leitura de código nesta
  // fase (middleware.js/envConfig.js) — simular NODE_ENV=production contra
  // um servidor dev ao vivo exigiria derrubar/subir com env diferente, fora
  // do escopo deste script; ver scripts/test-security-auth-unit.mjs pros
  // testes puros de getSessionSecret/isDevBypassEnabled cobrindo a lógica.

  // --- Telegram webhook: transport secret validation (independente de
  // sender/idempotência — ver scripts/test-telegram-trust-idempotency.mjs
  // pros testes de sender auth (A-F) e idempotência durável (G-M) da Fase
  // 5.3C.1). Shape de update realista (com update_id/from/chat.type) mesmo
  // aqui, ainda que estes 2 casos rejeitem antes de olhar pra isso.
  const tgNoSecret = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: 900000001, message: { chat: { id: 111222333, type: "private" }, from: { id: 111222333 }, text: "/start" } }),
  });
  check(tgNoSecret.status === 401, "[I] webhook sem header de secret -> 401", `status=${tgNoSecret.status}`);

  const tgWrongSecret = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret-errado-de-proposito" },
    body: JSON.stringify({ update_id: 900000002, message: { chat: { id: 111222333, type: "private" }, from: { id: 111222333 }, text: "/start" } }),
  });
  check(tgWrongSecret.status === 401, "[H] webhook com secret errado -> 401", `status=${tgWrongSecret.status}`);
  const tgWrongSecretText = await tgWrongSecret.text();
  check(!bodyLeaksSecret(tgWrongSecretText), "[O] resposta 401 do webhook não vaza o secret configurado");

  // --- logout ---
  const logout = await fetch(`${BASE_URL}/api/auth/logout`, { method: "POST", headers: { Cookie: sessionCookie } });
  check(logout.ok, "[logout] POST /api/auth/logout responde ok");
  const dashAfterLogout = await fetch(`${BASE_URL}/api/dashboard`, { headers: { Cookie: sessionCookie } });
  // Nota: o cookie enviado pelo cliente de teste não é automaticamente limpo
  // por um Set-Cookie de deleção (fetch não é um browser) — este check só
  // confirma que a ROTA de logout responde; a invalidação real de cookie no
  // browser é responsabilidade do próprio navegador ao processar o
  // Set-Cookie de expiração, fora do alcance de um teste fetch() puro.
  void dashAfterLogout;

  // --- FINAL_FINANCIAL_STATE_DIFF (fase inteira) — ver nota de classificação
  // no topo do arquivo: houve 1 create+delete sintético (Goal, teste [E]),
  // então isto prova DIFF FINAL zero, não "nenhuma escrita ocorreu".
  const after = await fingerprint();
  check(fingerprintsEqual(before, after), "[FINAL_FINANCIAL_STATE_DIFF] fingerprint de todos os models financeiros idêntico antes/depois do script inteiro (ZERO diff líquido, apesar do create+delete sintético do teste [E])");

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
