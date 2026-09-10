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
// 7) --apply SEM arquivo de autorização do orquestrador → ABORT
{
  try { fs.unlinkSync(AUTH_FILE); } catch { /* já ausente */ }
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "abc" }, argv: ["--apply"] });
  check(code !== 0 && /autorização do orquestrador/.test(out), "[7] --apply sem arquivo de autorização -> ABORT (bloqueia execução direta do script)");
}
// 8) --apply com auth file de runId DIFERENTE → ABORT
{
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId: "run-A", ts: Date.now(), allGatesGreen: true }));
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "run-B" }, argv: ["--apply"] });
  check(code !== 0 && /runId/.test(out), "[8] --apply com runId != autorização -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 9) --apply com auth file EXPIRADO → ABORT
{
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId: "run-C", ts: Date.now() - 20 * 60 * 1000, allGatesGreen: true }));
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "run-C" }, argv: ["--apply"] });
  check(code !== 0 && /expirada/.test(out), "[9] --apply com autorização expirada (>15min) -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 10) --apply com auth file válido MAS allGatesGreen=false → ABORT
{
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId: "run-D", ts: Date.now(), allGatesGreen: false }));
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "run-D" }, argv: ["--apply"] });
  check(code !== 0 && /8 gates/.test(out), "[10] --apply com gates não-verdes -> ABORT");
  fs.unlinkSync(AUTH_FILE);
}
// 11) --apply com auth file VÁLIDO e recente e gates verdes → passa
{
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId: "run-E", ts: Date.now(), allGatesGreen: true }));
  const { code, out } = runGuard({ env: { ...OK_ENV, NORTE_BOOTSTRAP_RUN_ID: "run-E" }, argv: ["--apply"] });
  check(code === 0 && out.includes("GUARD_PASSED"), "[11] --apply com autorização válida do orquestrador -> passa");
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
