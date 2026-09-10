// Fase 5.6.1 — ORQUESTRADOR do bootstrap de reconciliação em PRODUÇÃO.
//
// Roda, na ordem de fase, as cópias `*-PROD.mjs` dos 6 scripts de apply que
// produziram o estado reconciliado no branch DEV. Cada script é atômico
// (uma `prisma.$transaction`), idempotente (natural identity, re-run =
// NO_MUTATIONS_NEEDED) e grava backup local antes de mutar.
//
// BOOTSTRAP_TRANSACTION_MODEL = PHASED — 6 transações atômicas com
// checkpoint entre elas. Se a fase N falhar, 1..N-1 já commitaram e N.. não
// rodaram; como tudo é idempotente, basta re-rodar pra retomar.
//
// Uso:
//   node scripts/bootstrap-production-reconciliation.mjs            # DRY-RUN
//   node scripts/bootstrap-production-reconciliation.mjs --apply    # WRITE REAL
//
// Sem `--apply`: só dry-run de cada script + identity check + integridade
// da fonte. Zero write.
//
// A connection string de produção NUNCA é impressa. A identidade esperada do
// endpoint vem do `neonctl` em runtime (nada hardcoded).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const APPLY = process.argv.includes("--apply");
const NEON_PROJECT = "cool-firefly-30627522";
const EXPECTED_PROD_BRANCH = "production";

// Roda os scripts ORIGINAIS via o loader que remapeia o guard (nenhuma cópia).
const LOADER = path.join("scripts", "prod-bootstrap-loader-register.mjs");
const SCRIPTS = [
  { file: "seed-app-settings.mjs", dryRunSupported: false, phase: "3.2 AppSettings" },
  { file: "apply-fase51b-card-v2.mjs", dryRunSupported: true, phase: "5.1B card" },
  { file: "apply-fase51c-va.mjs", dryRunSupported: true, phase: "5.1C VA reconciliation" },
  { file: "apply-fase51d3-itau-snapshot.mjs", dryRunSupported: true, phase: "5.1D.3 Itaú snapshot" },
  { file: "apply-fase52c-obligations.mjs", dryRunSupported: true, phase: "5.2C obligations" },
  { file: "apply-fase52d-va-rule.mjs", dryRunSupported: true, phase: "5.2D VA rule day" },
];

function neon(args) {
  return execFileSync("npx", ["--yes", "neonctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function getProdConnString() {
  return neon(["connection-string", EXPECTED_PROD_BRANCH, "--project-id", NEON_PROJECT, "--pooled", "false"]).trim();
}

function getProdEndpointId() {
  const cs = getProdConnString();
  const host = new URL(cs).hostname;
  return host.split(".")[0].replace(/-pooler$/, "");
}

async function identityCheck(connString, expectedEndpoint) {
  // 1) endpoint no connString bate o esperado
  const host = new URL(connString).hostname;
  const endpoint = host.split(".")[0].replace(/-pooler$/, "");
  if (endpoint !== expectedEndpoint) throw new Error("endpoint do connString != endpoint esperado");

  // 2) neonctl confirma que esse endpoint pertence ao branch `production` E
  //    NÃO ao branch `dev` — comparando as connection strings emitidas pelo
  //    próprio neonctl pra cada branch.
  const branchesRaw = neon(["branches", "list", "--project-id", NEON_PROJECT, "--output", "json"]);
  const branches = JSON.parse(branchesRaw);
  const prodBranch = branches.find((b) => b.name === EXPECTED_PROD_BRANCH);
  if (!prodBranch) throw new Error("branch production não encontrado no neonctl");
  const epOf = (branch) => {
    const cs = neon(["connection-string", branch, "--project-id", NEON_PROJECT, "--pooled", "false"]).trim();
    return new URL(cs).hostname.split(".")[0].replace(/-pooler$/, "");
  };
  const prodEp = epOf(EXPECTED_PROD_BRANCH);
  let devEp = null;
  try { devEp = epOf("dev"); } catch { /* dev branch may not exist */ }
  const endpointBelongsToProd = prodEp === expectedEndpoint && expectedEndpoint !== devEp;

  // 3) live: conecta e confirma que o schema está migrado (12) + é o dado esperado
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: connString }) });
  const [mig] = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL`);
  const [acc] = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "Account"`);
  let neonBranch = null;
  try { const r = await prisma.$queryRawUnsafe(`SELECT current_setting('neon.branch_id', true) AS b`); neonBranch = r[0]?.b || null; } catch { /* setting may not exist */ }
  await prisma.$disconnect();

  const identity = {
    endpointMatchesExpected: endpoint === expectedEndpoint,
    endpointBelongsToProdBranch: endpointBelongsToProd,
    neonBranchIdFromSession: neonBranch ? (neonBranch === prodBranch.id ? "MATCHES production" : "MISMATCH") : "n/a",
    migrationsApplied: mig.n,
    accountCount: acc.n,
  };
  if (mig.n !== 12) throw new Error(`produção não está em 12 migrations (${mig.n}) — abortar`);
  if (endpointBelongsToProd === false) throw new Error("endpoint NÃO pertence ao branch production segundo o neonctl — abortar");
  return identity;
}

function snapshotIntegrity() {
  const p = path.join(REPO, "scripts", "snapshot-input.local.json");
  if (!fs.existsSync(p)) throw new Error("scripts/snapshot-input.local.json ausente");
  const raw = fs.readFileSync(p, "utf8");
  const j = JSON.parse(raw);
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  // gitignored?
  let gitignored = false;
  try { execFileSync("git", ["check-ignore", "scripts/snapshot-input.local.json"], { cwd: REPO, stdio: "ignore" }); gitignored = true; } catch { gitignored = false; }
  return {
    present: true,
    sizeBytes: raw.length,
    sha256_first12: sha.slice(0, 12),
    gitignored,
    topKeys: Object.keys(j),
    externalInstallmentPlans: Array.isArray(j.externalInstallmentPlans) ? j.externalInstallmentPlans.length : null,
    canonicalExpenses: Array.isArray(j.restrictedAccount?.canonicalExpenses) ? j.restrictedAccount.canonicalExpenses.length : null,
    confirmedCommitments: Array.isArray(j.confirmedCommitments) ? j.confirmedCommitments.length : null,
    contingencies: Array.isArray(j.contingencies) ? j.contingencies.length : null,
    mainIncome_standardRecurringAmount_present: typeof j.mainIncome?.standardRecurringAmount === "number",
  };
}

async function anchor(connString, label) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: connString }) });
  const j = (v) => (typeof v === "bigint" ? Number(v) : v);
  const tables = ["Account","Card","Income","Expense","Transfer","Bill","Purchase","Installment","CardBill","BalanceAdjustment","CardLimitUpdate","RecurringRule","Goal","Reserve","ExternalInstallmentPlan","ExternalInstallment","ConfirmedCommitment","Contingency","Receivable","CategoryBudget","CardCreditMovement","AppSettings"];
  const counts = {};
  for (const t of tables) counts[t] = j((await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t}"`))[0].n);
  const sums = {};
  for (const [t, c] of [["Income","amount"],["Expense","amount"],["BalanceAdjustment","newBalance"],["ExternalInstallment","amount"],["ExternalInstallmentPlan","installmentValue"],["ConfirmedCommitment","amount"],["Contingency","maxAmount"],["RecurringRule","amount"]]) {
    sums[`${t}.${c}`] = (await prisma.$queryRawUnsafe(`SELECT coalesce(sum("${c}"),0)::text s FROM "${t}"`))[0].s;
  }
  await prisma.$disconnect();
  return { label, counts, sums };
}

function runScript(scriptFile, connString, endpoint, { dryRun }) {
  const args = ["--import", "./" + LOADER, path.join("scripts", scriptFile)];
  if (dryRun) args.push("--dry-run");
  const env = {
    ...process.env,
    DATABASE_URL: connString,
    DIRECT_URL: connString,
    DATABASE_ENV: "production",
    NORTE_PRODUCTION_RECONCILIATION: "561-approved",
    NORTE_PROD_ENDPOINT: endpoint,
  };
  let out = "", code = 0;
  try {
    out = execFileSync("node", args, { cwd: REPO, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || "") + "\n[STDERR]\n" + (e.stderr || "");
  }
  // redação defensiva: nunca deixar a connString vazar no log agregado
  const redacted = out.split(connString).join("<REDACTED_PROD_CONN>").replace(new RegExp(endpoint, "g"), "<PROD_ENDPOINT>");
  return { code, out: redacted };
}

async function main() {
  console.log("=".repeat(78));
  console.log(`Fase 5.6.1 — bootstrap de reconciliação em PRODUÇÃO — MODO: ${APPLY ? "APPLY (WRITE REAL)" : "DRY-RUN"}`);
  console.log("=".repeat(78));

  const connString = getProdConnString();
  const endpoint = getProdEndpointId();

  console.log("\n--- 1. IDENTITY CHECK ---");
  const identity = await identityCheck(connString, endpoint);
  console.log(JSON.stringify(identity, null, 1));

  console.log("\n--- 2. SNAPSHOT_INPUT_INTEGRITY ---");
  const integ = snapshotIntegrity();
  console.log(JSON.stringify(integ, null, 1));
  if (!integ.gitignored) throw new Error("snapshot-input.local.json NÃO está gitignored — abortar");

  console.log("\n--- 3. PRE ANCHOR ---");
  const pre = await anchor(connString, "PRE");
  console.log(JSON.stringify(pre, null, 1));

  console.log(`\n--- 4. SCRIPTS (${APPLY ? "APPLY" : "DRY-RUN"}) ---`);
  const results = [];
  for (const s of SCRIPTS) {
    console.log(`\n${"─".repeat(70)}\n▶ ${s.phase}  (${s.file})`);
    // dry-run pass sempre primeiro (quando suportado)
    if (s.dryRunSupported) {
      const dr = runScript(s.file, connString, endpoint, { dryRun: true });
      console.log(`  [dry-run] exit=${dr.code}`);
      console.log(dr.out.split("\n").map((l) => "    " + l).join("\n"));
      if (dr.code !== 0) { results.push({ ...s, dryRun: dr.code, apply: "SKIPPED_DRYRUN_FAILED" }); throw new Error(`dry-run de ${s.file} falhou (exit ${dr.code}) — abortar bootstrap`); }
    }
    if (APPLY) {
      const rr = runScript(s.file, connString, endpoint, { dryRun: false });
      console.log(`  [APPLY] exit=${rr.code}`);
      console.log(rr.out.split("\n").map((l) => "    " + l).join("\n"));
      results.push({ ...s, apply: rr.code });
      if (rr.code !== 0) throw new Error(`APPLY de ${s.file} falhou (exit ${rr.code}) — checkpoint: scripts anteriores commitaram, este e os próximos NÃO. Re-rodar é seguro (idempotente).`);
    } else {
      results.push({ ...s, dryRun: "OK" });
    }
  }

  console.log("\n--- 5. POST ANCHOR ---");
  const post = await anchor(connString, "POST");
  console.log(JSON.stringify(post, null, 1));

  console.log("\n--- 6. ANCHOR DELTA ---");
  for (const t of Object.keys(pre.counts)) {
    if (pre.counts[t] !== post.counts[t]) console.log(`  count ${t}: ${pre.counts[t]} -> ${post.counts[t]}`);
  }
  for (const k of Object.keys(pre.sums)) {
    if (pre.sums[k] !== post.sums[k]) console.log(`  sum ${k}: ${pre.sums[k]} -> ${post.sums[k]}`);
  }

  console.log(`\n${"=".repeat(78)}\nRESULT: ${APPLY ? "APPLY_COMPLETE" : "DRY_RUN_COMPLETE"}\n${"=".repeat(78)}`);
}

main().catch((e) => { console.error("\n🛑 BOOTSTRAP ABORTED:", e.message); process.exit(1); });
