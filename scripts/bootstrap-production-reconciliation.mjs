// Fase 5.6.1 — ORQUESTRADOR do bootstrap de reconciliação em PRODUÇÃO.
//
// Roda os 6 scripts de apply ORIGINAIS (sem cópia) via
// `scripts/prod-bootstrap-loader.mjs`, que remapeia o guard de teste para o
// guard POSITIVO `assertProductionReconciliation`. Cada script é atômico (1
// `prisma.$transaction`), idempotente e grava backup local antes de mutar.
//
// BOOTSTRAP_TRANSACTION_MODEL = PHASED — transações atômicas com checkpoint
// entre elas. Se a fase N falha, 1..N-1 commitaram e N.. não rodaram; tudo
// idempotente → re-rodar retoma.
//
// Modos:
//   node scripts/bootstrap-production-reconciliation.mjs                 # DRY-RUN completo (zero write)
//   node scripts/bootstrap-production-reconciliation.mjs --phase0-only   # aplica SÓ o AppSettings (config)
//   node scripts/bootstrap-production-reconciliation.mjs --apply         # APPLY real (exige os 8 gates)
//
// A connection string de produção NUNCA é impressa. A identidade esperada
// do endpoint vem do `neonctl` em runtime (nada hardcoded).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const APPLY = process.argv.includes("--apply");
const PHASE0_ONLY = process.argv.includes("--phase0-only");
const NEON_PROJECT = "cool-firefly-30627522";
const EXPECTED_PROD_BRANCH = "production";
const PRE_BOOTSTRAP_BACKUP_BRANCH = "pre-bootstrap-2026-09-10";
const PRE_CUTOVER_BACKUP_BRANCH = "pre-cutover-2026-09-10";
const EXPECTED_MIGRATIONS = 12;
const PROD_URL = "https://financas-dashboard-omega.vercel.app";
const AUTH_FILE = path.join(HERE, "lib", ".bootstrap-authorized.json");
const RUN_ID = crypto.randomUUID();

const LOADER = path.join("scripts", "prod-bootstrap-loader-register.mjs");
const SCRIPTS = [
  { file: "seed-app-settings.mjs", dryRunSupported: false, phase: "3.2 AppSettings", phase0: true },
  { file: "apply-fase51b-card-v2.mjs", dryRunSupported: true, phase: "5.1B card" },
  { file: "apply-fase51c-va.mjs", dryRunSupported: true, phase: "5.1C VA reconciliation" },
  { file: "apply-fase51d3-itau-snapshot.mjs", dryRunSupported: true, phase: "5.1D.3 Itaú snapshot" },
  { file: "apply-fase52c-obligations.mjs", dryRunSupported: true, phase: "5.2C obligations" },
  { file: "apply-fase52d-va-rule.mjs", dryRunSupported: true, phase: "5.2D VA rule day" },
];

function neon(args) {
  return execFileSync("npx", ["--yes", "neonctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function vercelToken() {
  const p = path.join(process.env.HOME, "Library/Application Support/com.vercel.cli/auth.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).token;
}
function connStringFor(branch) {
  return neon(["connection-string", branch, "--project-id", NEON_PROJECT, "--pooled", "false"]).trim();
}
function endpointOf(connString) {
  return new URL(connString).hostname.split(".")[0].replace(/-pooler$/, "");
}

// ---- os 8 gates de rede (só necessários pra --apply / --phase0-only) ----
async function networkGates(connString, endpoint) {
  const gates = {};

  // 4) DB identity = projeto Neon esperado + 5) branch = production
  const branches = JSON.parse(neon(["branches", "list", "--project-id", NEON_PROJECT, "--output", "json"]));
  const prodBranch = branches.find((b) => b.name === EXPECTED_PROD_BRANCH);
  const devEp = (() => { try { return endpointOf(connStringFor("dev")); } catch { return null; } })();
  gates.g4_neonProjectExpected = !!prodBranch && prodBranch.project_id === NEON_PROJECT;
  gates.g5a_endpointIsProdNotDev = endpoint === endpointOf(connString) && endpoint !== devEp;

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: connString }) });
  let neonBranchSession = null;
  try { neonBranchSession = (await prisma.$queryRawUnsafe(`SELECT current_setting('neon.branch_id', true) b`))[0]?.b || null; } catch { /* setting pode não existir */ }
  gates.g5b_neonBranchSessionMatchesProd = neonBranchSession ? neonBranchSession === prodBranch.id : "n/a";
  const [mig] = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL`);
  gates.g6_migrations = mig.n;
  gates.g6_migrationsOk = mig.n === EXPECTED_MIGRATIONS;
  await prisma.$disconnect();

  // 7) Deployment Protection = all
  try {
    const vt = vercelToken();
    const proj = JSON.parse(fs.readFileSync(path.join(REPO, ".vercel", "project.json"), "utf8"));
    const r = execFileSync("curl", ["-s", `https://api.vercel.com/v9/projects/${proj.projectId}?teamId=${proj.orgId}`, "-H", `Authorization: Bearer ${vt}`], { encoding: "utf8" });
    const sso = JSON.parse(r).ssoProtection;
    gates.g7_deploymentProtection = sso?.deploymentType ?? "none";
    gates.g7_deploymentProtectionIsAll = sso?.deploymentType === "all";
  } catch (e) {
    gates.g7_deploymentProtection = "CHECK_FAILED:" + String(e.message).slice(0, 40);
    gates.g7_deploymentProtectionIsAll = false;
  }
  // 7b) prova anônima
  try {
    const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "12", `${PROD_URL}/api/dashboard`], { encoding: "utf8" }).trim();
    gates.g7b_anonDashboardHttp = code;
    gates.g7b_anonContained = code === "302" || code === "401";
  } catch { gates.g7b_anonContained = false; }

  // 8) backups existem
  gates.g8_preBootstrapBackup = branches.some((b) => b.name === PRE_BOOTSTRAP_BACKUP_BRANCH);
  gates.g8_preCutoverBackup = branches.some((b) => b.name === PRE_CUTOVER_BACKUP_BRANCH);

  const allGreen =
    gates.g4_neonProjectExpected &&
    gates.g5a_endpointIsProdNotDev &&
    (gates.g5b_neonBranchSessionMatchesProd === true || gates.g5b_neonBranchSessionMatchesProd === "n/a") &&
    gates.g6_migrationsOk &&
    gates.g7_deploymentProtectionIsAll &&
    gates.g7b_anonContained &&
    gates.g8_preBootstrapBackup &&
    gates.g8_preCutoverBackup;

  return { gates, allGreen };
}

function snapshotIntegrity() {
  const p = path.join(REPO, "scripts", "snapshot-input.local.json");
  if (!fs.existsSync(p)) throw new Error("scripts/snapshot-input.local.json ausente");
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  let gitignored = false;
  try { execFileSync("git", ["check-ignore", "scripts/snapshot-input.local.json"], { cwd: REPO, stdio: "ignore" }); gitignored = true; } catch { /* no */ }
  return {
    present: true, sizeBytes: raw.length,
    sha256_first12: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12),
    gitignored,
    externalInstallmentPlans: j.externalInstallmentPlans?.length ?? null,
    canonicalExpenses: j.restrictedAccount?.canonicalExpenses?.length ?? null,
    confirmedCommitments: j.confirmedCommitments?.length ?? null,
    contingencies: j.contingencies?.length ?? null,
  };
}

async function anchor(connString, label) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: connString }) });
  const j = (v) => (typeof v === "bigint" ? Number(v) : v);
  const tables = ["Account","Card","Income","Expense","Transfer","Bill","Purchase","Installment","CardBill","BalanceAdjustment","CardLimitUpdate","RecurringRule","Goal","Reserve","ReserveMovement","ExternalInstallmentPlan","ExternalInstallment","ConfirmedCommitment","Contingency","Receivable","CategoryBudget","CardCreditMovement","AppSettings"];
  const counts = {};
  for (const t of tables) counts[t] = j((await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t}"`))[0].n);
  const sums = {};
  for (const [t, c] of [["Income","amount"],["Expense","amount"],["BalanceAdjustment","newBalance"],["ExternalInstallment","amount"],["ConfirmedCommitment","amount"],["Contingency","maxAmount"],["RecurringRule","amount"],["CardBill","totalAmount"]]) {
    sums[`${t}.${c}`] = (await prisma.$queryRawUnsafe(`SELECT coalesce(sum("${c}"),0)::text s FROM "${t}"`))[0].s;
  }
  await prisma.$disconnect();
  return { label, counts, sums };
}

function runScript(scriptFile, connString, endpoint, { dryRun }) {
  const args = ["--import", "./" + LOADER, path.join("scripts", scriptFile)];
  // `--dry-run` é lido pelos scripts de apply. `--apply` os scripts IGNORAM
  // (argv desconhecido), mas o guard `assertProductionReconciliation` o
  // exige pra liberar escrita real — só passa em modo write, e só quando o
  // orquestrador já gravou o arquivo de autorização (8 gates verdes).
  if (dryRun) args.push("--dry-run");
  else args.push("--apply");
  const env = {
    ...process.env,
    DATABASE_URL: connString, DIRECT_URL: connString,
    DATABASE_ENV: "production",
    NORTE_PRODUCTION_RECONCILIATION: "561-approved",
    NORTE_PROD_ENDPOINT: endpoint,
    NORTE_BOOTSTRAP_RUN_ID: RUN_ID,
  };
  let out = "", code = 0;
  try {
    out = execFileSync("node", args, { cwd: REPO, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 30 * 1024 * 1024 });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || "") + "\n[STDERR]\n" + (e.stderr || "");
  }
  const redacted = out.split(connString).join("<REDACTED_CONN>").split(endpoint).join("<PROD_ENDPOINT>");
  return { code, out: redacted };
}

function writeAuth(allGatesGreen) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ runId: RUN_ID, ts: Date.now(), allGatesGreen }, null, 2));
}
function clearAuth() {
  try { fs.unlinkSync(AUTH_FILE); } catch { /* ok */ }
}

async function main() {
  const mode = APPLY ? "APPLY (WRITE REAL)" : PHASE0_ONLY ? "PHASE0 (só AppSettings)" : "DRY-RUN";
  console.log("=".repeat(78));
  console.log(`Fase 5.6.1 — bootstrap de reconciliação em PRODUÇÃO — MODO: ${mode}  RUN_ID=${RUN_ID}`);
  console.log("=".repeat(78));

  const connString = connStringFor(EXPECTED_PROD_BRANCH);
  const endpoint = endpointOf(connString);

  console.log("\n--- SNAPSHOT_INPUT_INTEGRITY ---");
  const integ = snapshotIntegrity();
  console.log(JSON.stringify(integ, null, 1));
  if (!integ.gitignored) throw new Error("snapshot-input.local.json NÃO está gitignored");

  const willWrite = APPLY || PHASE0_ONLY;
  if (willWrite) {
    console.log("\n--- 8 NETWORK GATES (necessários pra escrita) ---");
    const { gates, allGreen } = await networkGates(connString, endpoint);
    console.log(JSON.stringify(gates, null, 1));
    console.log(`allGatesGreen = ${allGreen}`);
    if (!allGreen) throw new Error("8 gates de rede não estão todos verdes — ABORT, nenhum write");
    writeAuth(allGreen);
  }

  console.log("\n--- PRE ANCHOR ---");
  const pre = await anchor(connString, "PRE");
  console.log(JSON.stringify(pre, null, 1));

  const results = [];
  try {
    for (const s of SCRIPTS) {
      if (PHASE0_ONLY && !s.phase0) continue;
      console.log(`\n${"─".repeat(70)}\n▶ ${s.phase}  (${s.file})`);

      if (s.dryRunSupported) {
        const dr = runScript(s.file, connString, endpoint, { dryRun: true });
        console.log(`  [dry-run] exit=${dr.code}`);
        console.log(dr.out.split("\n").map((l) => "    " + l).join("\n"));
        if (dr.code !== 0) throw new Error(`dry-run de ${s.file} falhou (exit ${dr.code})`);
      }
      if (APPLY || (PHASE0_ONLY && s.phase0)) {
        const rr = runScript(s.file, connString, endpoint, { dryRun: false });
        console.log(`  [APPLY] exit=${rr.code}`);
        console.log(rr.out.split("\n").map((l) => "    " + l).join("\n"));
        results.push({ ...s, apply: rr.code });
        if (rr.code !== 0) throw new Error(`APPLY de ${s.file} falhou (exit ${rr.code}) — CHECKPOINT: fases anteriores commitaram, esta e as próximas NÃO. Re-rodar é seguro (idempotente).`);
      } else {
        results.push({ ...s, dryRun: "OK" });
      }
    }
  } finally {
    clearAuth();
  }

  console.log("\n--- POST ANCHOR ---");
  const post = await anchor(connString, "POST");
  console.log(JSON.stringify(post, null, 1));

  console.log("\n--- ANCHOR DELTA ---");
  for (const t of Object.keys(pre.counts)) if (pre.counts[t] !== post.counts[t]) console.log(`  count ${t}: ${pre.counts[t]} -> ${post.counts[t]}`);
  for (const k of Object.keys(pre.sums)) if (pre.sums[k] !== post.sums[k]) console.log(`  sum ${k}: ${pre.sums[k]} -> ${post.sums[k]}`);

  console.log(`\n${"=".repeat(78)}\nRESULT: ${APPLY ? "APPLY_COMPLETE" : PHASE0_ONLY ? "PHASE0_COMPLETE" : "DRY_RUN_COMPLETE"}\n${"=".repeat(78)}`);
}

main().catch((e) => { clearAuth(); console.error("\n🛑 BOOTSTRAP ABORTED:", e.message); process.exit(1); });
