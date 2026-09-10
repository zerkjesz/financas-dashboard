// Fase 5.6.1 — testes do guard prod-safe do bootstrap.
// Roda `assertProductionReconciliation` (via subprocesso, pra capturar
// process.exit) sob cenários adversos. NÃO toca banco nenhum.
//
//   node scripts/test-bootstrap-guard.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "lib", "assertProductionReconciliation.js");
const AUTH_FILE = path.join(HERE, "lib", ".bootstrap-authorized.json");
const FAKE_PROD_URL = "postgresql://u:p@ep-fake-prod-endpoint.sa-east-1.aws.neon.tech/neondb?sslmode=require";

let pass = 0, fail = 0;
function check(cond, label, extra = "") {
  if (cond) { pass++; console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`); }
  else { fail++; console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`); }
}

// roda o guard num subprocesso com env/argv controlados; retorna {code, out}
function runGuard({ env = {}, argv = [] }) {
  const code = `import("${GUARD.replace(/\\/g, "/")}").then(m => { m.assertProductionReconciliation(); console.log("GUARD_PASSED"); });`;
  try {
    const out = execFileSync("node", ["-e", code, "--", ...argv], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

const OK_ENV = {
  DATABASE_ENV: "production",
  NORTE_PRODUCTION_RECONCILIATION: "561-approved",
  NORTE_PROD_ENDPOINT: "ep-fake-prod-endpoint",
  DATABASE_URL: FAKE_PROD_URL,
};

console.log("--- Fase 5.6.1: testes do guard prod-safe ---\n");

// 1) sem a flag de produção → ABORT
{
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_PRODUCTION_RECONCILIATION: "" } });
  check(code !== 0 && !out.includes("GUARD_PASSED"), "[1] sem NORTE_PRODUCTION_RECONCILIATION -> ABORT");
}
// 2) sem --apply → dry-run, passa sem exigir auth file (zero write path)
{
  const { code, out } = runGuard({ env: OK_ENV, argv: [] });
  check(code === 0 && out.includes("GUARD_PASSED") && /dry-run/.test(out), "[2] dry-run (sem --apply) -> passa sem exigir orquestrador");
}
// 3) DATABASE_ENV != production → ABORT
{
  const { code } = runGuard({ env: { ...OK_ENV, DATABASE_ENV: "development" } });
  check(code !== 0, "[3] DATABASE_ENV=development -> ABORT");
}
// 3b) DATABASE_ENV ausente → ABORT
{
  const { code } = runGuard({ env: { ...OK_ENV, DATABASE_ENV: "" } });
  check(code !== 0, "[3b] DATABASE_ENV ausente -> ABORT");
}
// 4) endpoint errado (não bate NORTE_PROD_ENDPOINT) → ABORT
{
  const { code } = runGuard({ env: { ...OK_ENV, NORTE_PROD_ENDPOINT: "ep-some-other-endpoint" } });
  check(code !== 0, "[4] DATABASE_URL não bate o endpoint esperado -> ABORT");
}
// 5) DATABASE_URL pooled → ABORT (reconciliação exige conexão direta)
{
  const { code, out } = runGuard({ env: { ...OK_ENV, DATABASE_URL: FAKE_PROD_URL.replace("ep-fake-prod-endpoint", "ep-fake-prod-endpoint-pooler") } });
  check(code !== 0 && /pooler/.test(out), "[5] DATABASE_URL com -pooler -> ABORT (exige unpooled)");
}
// 6) rodando "dentro da Vercel" → ABORT
{
  const { code } = runGuard({ env: { ...OK_ENV, VERCEL: "1" } });
  check(code !== 0, "[6] VERCEL=1 -> ABORT");
}
// helper: escreve um auth file da forma que o orquestrador escreve (per-fase, com nonce)
function writeAuthFile({ runId = "run-X", phase = "apply-fase52c-obligations.mjs", nonce = "nonce-1", ts = Date.now(), allGatesGreen = true } = {}) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId, phase, nonce, ts, allGatesGreen }, null, 2));
}
// env que o orquestrador passa pro subprocesso de --apply de uma fase
function applyEnv({ runId = "run-X", phase = "apply-fase52c-obligations.mjs", nonce = "nonce-1" } = {}) {
  return { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: runId, NORTE_BOOTSTRAP_PHASE: phase, NORTE_BOOTSTRAP_NONCE: nonce };
}

// 7) --apply SEM arquivo de autorização do orquestrador → ABORT
{
  try { fs.unlinkSync(AUTH_FILE); } catch { /* já ausente */ }
  const { code, out } = runGuard({ env: applyEnv(), argv: ["--apply"] });
  check(code !== 0 && /autorização do orquestrador/.test(out), "[7] --apply sem arquivo de autorização -> ABORT (bloqueia execução direta do script)");
}
// 8) --apply com auth file de runId DIFERENTE → ABORT
{
  writeAuthFile({ runId: "run-A" });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-B" }), argv: ["--apply"] });
  check(code !== 0 && /runId/.test(out), "[8] --apply com runId != autorização -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 9) --apply com auth file EXPIRADO (>60 s) → ABORT
{
  writeAuthFile({ runId: "run-C", nonce: "n-c", ts: Date.now() - 61 * 1000 });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-C", nonce: "n-c" }), argv: ["--apply"] });
  check(code !== 0 && /expirada/.test(out), "[9] --apply com autorização expirada (>60 s) -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 9b) --apply com auth de 30 s atrás (dentro da janela de 60 s) → passa (recovery)
{
  writeAuthFile({ runId: "run-C2", nonce: "n-c2", ts: Date.now() - 30 * 1000 });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-C2", nonce: "n-c2" }), argv: ["--apply"] });
  check(code === 0 && out.includes("GUARD_PASSED"), "[9b] --apply com autorização de 30 s (janela de recovery) -> passa");
  fs.unlinkSync(AUTH_FILE);
}
// 10) --apply com auth file válido MAS allGatesGreen=false → ABORT
{
  writeAuthFile({ runId: "run-D", nonce: "n-d", allGatesGreen: false });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-D", nonce: "n-d" }), argv: ["--apply"] });
  check(code !== 0 && /8 gates/.test(out), "[10] --apply com gates não-verdes -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 11) --apply com auth file VÁLIDO (runId+phase+nonce+ts+gates) → passa
{
  writeAuthFile({ runId: "run-E", phase: "apply-fase52c-obligations.mjs", nonce: "n-e" });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-E", phase: "apply-fase52c-obligations.mjs", nonce: "n-e" }), argv: ["--apply"] });
  check(code === 0 && out.includes("GUARD_PASSED"), "[11] --apply com autorização válida do orquestrador -> passa");
  fs.unlinkSync(AUTH_FILE);
}
// 11b) SINGLE-USE: a autorização vale UMA vez. O orquestrador deleta o arquivo
//      logo após a fase; se um 2º subprocesso tentar reusar, o arquivo não existe.
{
  writeAuthFile({ runId: "run-F", phase: "apply-fase52c-obligations.mjs", nonce: "n-f" });
  const first = runGuard({ env: applyEnv({ runId: "run-F", phase: "apply-fase52c-obligations.mjs", nonce: "n-f" }), argv: ["--apply"] });
  fs.unlinkSync(AUTH_FILE); // <- o orquestrador faz isso no finally de cada fase
  const second = runGuard({ env: applyEnv({ runId: "run-F", phase: "apply-fase52c-obligations.mjs", nonce: "n-f" }), argv: ["--apply"] });
  check(first.code === 0 && first.out.includes("GUARD_PASSED"), "[11b] autorização single-use: 1ª execução -> passa");
  check(second.code !== 0 && /autorização do orquestrador/.test(second.out), "[11b] autorização single-use: 2ª execução (arquivo consumido) -> ABORT");
}
// 11c) --apply com auth de OUTRA fase (phase não bate) → ABORT
{
  writeAuthFile({ runId: "run-G", phase: "apply-fase51b-card-v2.mjs", nonce: "n-g" });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-G", phase: "apply-fase52d-va-rule.mjs", nonce: "n-g" }), argv: ["--apply"] });
  check(code !== 0 && /fase/.test(out), "[11c] --apply com autorização de outra fase -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 11d) --apply com nonce que não bate (autorização de outra rodada da mesma fase) → ABORT
{
  writeAuthFile({ runId: "run-H", phase: "apply-fase52c-obligations.mjs", nonce: "nonce-real" });
  const { code, out } = runGuard({ env: applyEnv({ runId: "run-H", phase: "apply-fase52c-obligations.mjs", nonce: "nonce-outro" }), argv: ["--apply"] });
  check(code !== 0 && /nonce/.test(out), "[11d] --apply com nonce != autorização -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 11e) --apply válido no arquivo mas SEM NORTE_BOOTSTRAP_NONCE no env → ABORT
{
  writeAuthFile({ runId: "run-I", phase: "apply-fase52c-obligations.mjs", nonce: "n-i" });
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "run-I", NORTE_BOOTSTRAP_PHASE: "apply-fase52c-obligations.mjs" }, argv: ["--apply"] });
  check(code !== 0 && /nonce/.test(out), "[11e] --apply sem NORTE_BOOTSTRAP_NONCE no env -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 12) NO_DIRECT_SCRIPT_ACCIDENT: script real SEM o loader -> guard ORIGINAL barra
{
  const script = path.join(HERE, "apply-fase52d-va-rule.mjs");
  try {
    execFileSync("node", [script, "--dry-run"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_ENV: "production", DATABASE_URL: FAKE_PROD_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    check(false, "[12] script direto sem loader + DATABASE_ENV=production -> deveria ABORTAR pelo guard ORIGINAL");
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    check(/este script escreve dados de teste|development.*ou.*test/.test(out), "[12] script direto sem loader (DATABASE_ENV=production) -> guard ORIGINAL aborta", `exit ${e.status}`);
  }
}

try { fs.unlinkSync(AUTH_FILE); } catch { /* ok */ }
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail > 0 ? 1 : 0);
