// ============================================================================
// Fase 5.2D — VA RECURRING RULE CORRECTION / DEV ONLY.
//
// Escopo estrito: UPDATE de EXATAMENTE 1 campo (dayOfMonth) em EXATAMENTE 1
// RecurringRule (a da recarga VA/Caju, identificada semanticamente — nunca só
// por dayOfMonth=24, que agora TAMBÉM é o dia da RecurringRule de salário).
// Nada mais é tocado: Account/Income/Expense/BalanceAdjustment/Card/CardBill/
// Purchase/Installment/CardLimitUpdate/ConfirmedCommitment/
// ExternalInstallmentPlan/ExternalInstallment/Contingency/salário
// RecurringRule/Itaú/qualquer ledger permanecem intocados.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { computeFreeMoney, computeSafeToSpend } from "../lib/freeMoney.js";
import { getNextIncomeInfo } from "../lib/incomeHorizon.js";
import { getAppSettings } from "../lib/settings.js";
import { computeFinancialStatus } from "../lib/financialStatus.js";
import { buildBaseProjection, buildExpectedProjection, buildStressProjection } from "../lib/financialProjection.js";
import { computeCurrentObligationHorizonEnd } from "../lib/financialEngine.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import { nextOccurrence } from "../lib/recurringCycles.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const INPUT_PATH = path.join(HERE, "snapshot-input.local.json");
const BACKUP_DIR = path.join(HERE, "snapshot-reports");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";

const DRY_RUN = process.argv.includes("--dry-run");

const OTHER_MODELS = [
  "account", "income", "expense", "transfer", "balanceAdjustment", "card", "cardBill", "purchase", "installment", "cardLimitUpdate",
  "bill", "goal", "reserve", "reserveMovement", "confirmedCommitment", "externalInstallmentPlan", "externalInstallment", "contingency",
  "receivable", "categoryBudget", "cardCreditMovement", "appSettings",
];

function log(...args) {
  console.log(...args);
}

function assertExtraSafety() {
  const problems = [];
  const directUrl = process.env.DIRECT_URL || "";
  if (!directUrl) problems.push("DIRECT_URL não está setada");
  else if (directUrl.includes(PRODUCTION_DB_HOST_SUBSTRING)) problems.push("DIRECT_URL aponta pro host de produção");
  if (process.env.VERCEL_ENV === "production") problems.push('VERCEL_ENV === "production"');

  let migrateStatusOutput = "";
  try {
    migrateStatusOutput = execSync("npx prisma migrate status", { cwd: REPO_ROOT, encoding: "utf8" });
    if (!migrateStatusOutput.includes("up to date")) problems.push(`prisma migrate status não está clean:\n${migrateStatusOutput}`);
  } catch (err) {
    problems.push(`Falha ao rodar 'npx prisma migrate status': ${err.message}`);
  }

  if (problems.length > 0) {
    console.error("\n🛑 ABORTADO (assertExtraSafety) — antes de qualquer write:");
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
  }
}

async function fingerprintModels(models, client = prisma) {
  const fp = {};
  for (const m of models) {
    const rows = await client[m].findMany();
    fp[m] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
  }
  return fp;
}

async function main() {
  log("==============================================================================");
  log("Fase 5.2D — VA RECURRING RULE CORRECTION (escopo: 1 UPDATE, 1 campo)");
  log(DRY_RUN ? "MODO: --dry-run (preflight/simulação apenas, ZERO write)" : "MODO: WRITE REAL");
  log("==============================================================================");

  assertExtraSafety();
  log("✅ Ambiente dev confirmado + prisma migrate status clean.");

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const canonicalRechargeDay = new Date(input.restrictedAccount.recharge.date).getUTCDate();
  const canonicalRechargeAmount = money(input.restrictedAccount.recharge.amount);

  // ==========================================================================
  // Item 2 — identificar a rule correta SEMANTICAMENTE (nunca só dayOfMonth=24,
  // que agora também é o dia da rule de salário criada na Fase 5.2C).
  // ==========================================================================
  const vaAccount = await prisma.account.findFirst({ where: { slug: "vale-alimentacao" } });
  if (!vaAccount) throw new Error("Account VA não encontrada.");

  const vaRuleCandidates = await prisma.recurringRule.findMany({ where: { kind: "income", accountId: vaAccount.id, amount: canonicalRechargeAmount } });
  log(`\n--- Item 2/3: identificação semântica + preflight ---`);
  log(`  Candidatos de RecurringRule VA (kind=income, accountId=VA, amount=${canonicalRechargeAmount.toString()}): ${vaRuleCandidates.length}`);
  if (vaRuleCandidates.length !== 1) {
    console.error(`\n🛑 ABORTADO — esperava exatamente 1 candidato, encontrado ${vaRuleCandidates.length}. Não escolher arbitrariamente.`);
    process.exit(1);
  }
  const vaRule = vaRuleCandidates[0];
  log(`  RecurringRule VA identificada: id=${vaRule.id} name="${vaRule.name}" dayOfMonth=${vaRule.dayOfMonth}`);

  // Confirma que NÃO é a mesma row da RecurringRule de salário (sanity check
  // adicional — mesmo já filtrando por accountId+amount, que sozinhos já
  // distinguem, mas o pedido é explícito em nunca tocar a de salário).
  const salaryRule = await prisma.recurringRule.findFirst({ where: { kind: "income", amount: money(input.mainIncome.standardRecurringAmount) } });
  if (!salaryRule) throw new Error("RecurringRule de salário não encontrada — esperada da Fase 5.2C.");
  if (salaryRule.id === vaRule.id) {
    console.error(`\n🛑 ABORTADO — a rule identificada como VA é a MESMA row da rule de salário. Erro de identificação, não prosseguir.`);
    process.exit(1);
  }
  log(`  RecurringRule de salário confirmada DISTINTA: id=${salaryRule.id} (nunca tocada)`);

  // --- idempotência: já corrigida? ---
  if (vaRule.dayOfMonth === canonicalRechargeDay) {
    log(`\n✅ NO_MUTATIONS_NEEDED — VA RecurringRule.dayOfMonth já é ${canonicalRechargeDay} — idempotência confirmada, nenhum UPDATE.`);
    log(`\n==============================================================================`);
    log(`RESULTADO: NO_MUTATIONS_NEEDED`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "NO_MUTATIONS_NEEDED" };
  }
  if (vaRule.dayOfMonth !== 24) {
    console.error(`\n🛑 ABORTADO — dayOfMonth atual (${vaRule.dayOfMonth}) não é nem 24 (esperado antes da correção) nem ${canonicalRechargeDay} (esperado depois) — estado inesperado, não prosseguir.`);
    process.exit(1);
  }

  // ==========================================================================
  // Item 14 — backup pré-write
  // ==========================================================================
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const preFingerprint = await fingerprintModels([...OTHER_MODELS, "recurringRule"]);
  const preVaSnapshot = await buildVaSnapshot();
  const preAccountsForStatus = await listAccountsWithBalances();
  const preNextIncome = await getNextIncomeInfo();
  const preEngine = await computeFreeMoney({ nextIncomeDate: preNextIncome.expectedDate, accounts: preAccountsForStatus });
  const preHorizonEnd = computeCurrentObligationHorizonEnd(preNextIncome);
  const [preBase, preExpected, preStress] = await Promise.all([
    buildBaseProjection({ now: new Date(), accounts: preAccountsForStatus }),
    buildExpectedProjection({ now: new Date(), accounts: preAccountsForStatus }),
    buildStressProjection({ now: new Date(), accounts: preAccountsForStatus }),
  ]);
  const preStatus = computeFinancialStatus({ freeMoney: preEngine.freeMoney, nextIncomeDate: preNextIncome.expectedDate, currentObligationHorizonEnd: preHorizonEnd, nextIncomeStatus: preNextIncome.status, baseProjection: preBase, expectedProjection: preExpected, stressProjection: preStress, unfundedConfirmedCommitments: { count: 0, amount: money(0), items: [] } });
  const backupPath = path.join(BACKUP_DIR, `pre-fase52d-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ vaRule, salaryRule, preFingerprint: { recurringRule: preFingerprint.recurringRule }, preVaSnapshot: { balance: preVaSnapshot.balance.toString(), nextRecharge: preVaSnapshot.nextRecharge }, preEngineFreeMoney: preEngine.freeMoney.toString(), preStatus: preStatus.status }, null, 2));
  log(`\n✅ Backup pré-write salvo em: ${backupPath}`);
  log(`  VA snapshot ANTES: balance=${preVaSnapshot.balance.toString()} nextRecharge=${preVaSnapshot.nextRecharge?.toISOString().slice(0, 10)}`);
  log(`  Status ANTES: ${preStatus.status} | freeMoney=${preEngine.freeMoney.toString()}`);

  if (DRY_RUN) {
    log(`\n[--dry-run] UPDATE RecurringRule id=${vaRule.id}: dayOfMonth ${vaRule.dayOfMonth} -> ${canonicalRechargeDay}`);
    log(`\n==============================================================================`);
    log(`RESULTADO: DRY_RUN_COMPLETE`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "DRY_RUN_COMPLETE", backupPath };
  }

  // ==========================================================================
  // Item 6 — transação única
  // ==========================================================================
  let txStatus = "ROLLED_BACK";
  let txSummary = null;
  try {
    await prisma.$transaction(async (tx) => {
      const freshRule = await tx.recurringRule.findUnique({ where: { id: vaRule.id } });
      if (!freshRule || freshRule.dayOfMonth !== 24) throw new Error("Estado da rule mudou entre o preflight e a transação — abortando.");

      const updated = await tx.recurringRule.update({ where: { id: vaRule.id }, data: { dayOfMonth: canonicalRechargeDay } });
      log(`\nUPDATE RecurringRule id=${updated.id}: dayOfMonth ${freshRule.dayOfMonth} -> ${updated.dayOfMonth}`);

      const problems = [];

      // A) VA rule dayOfMonth corrigida
      if (updated.dayOfMonth !== canonicalRechargeDay) problems.push(`A) dayOfMonth=${updated.dayOfMonth}, esperado ${canonicalRechargeDay}`);
      // B) VA rule amount inalterado
      if (compareMoney(money(updated.amount), canonicalRechargeAmount) !== 0) problems.push(`B) amount=${updated.amount}, esperado ${canonicalRechargeAmount.toString()} (não deveria ter mudado)`);
      // C) salary rule inalterada
      const freshSalary = await tx.recurringRule.findUnique({ where: { id: salaryRule.id } });
      if (compareMoney(money(freshSalary.amount), money(input.mainIncome.standardRecurringAmount)) !== 0 || freshSalary.dayOfMonth !== input.mainIncome.dayOfMonth) {
        problems.push(`C) salary rule mudou: amount=${freshSalary.amount} dayOfMonth=${freshSalary.dayOfMonth}`);
      }
      // D) VA balance inalterado
      const vaBalanceTx = await computeAccountBalance(vaAccount.id, { client: tx });
      if (compareMoney(vaBalanceTx, money(input.restrictedAccount.observedClosing.amount)) !== 0) problems.push(`D) VA balance=${vaBalanceTx.toString()}, esperado ${input.restrictedAccount.observedClosing.amount}`);
      // E/F/G/H) engine — nextIncome deve continuar vindo da rule de SALÁRIO (VA nunca é elegível — accountIsUnrestricted exclui food_voucher), então freeMoney/status não deveriam mudar nada.
      const nextIncomeTx = await getNextIncomeInfo({ client: tx });
      const accounts = await listAccountsWithBalances(); // Account/Income/Expense/BalanceAdjustment não mudam nesta fase — leitura via prisma global é segura
      const freeMoneyResultTx = await computeFreeMoney({ nextIncomeDate: nextIncomeTx.expectedDate, accounts, client: tx });
      const settingsTx = await getAppSettings({ client: tx });
      const safeToSpendTx = computeSafeToSpend(freeMoneyResultTx.freeMoney, settingsTx.safetyMarginPercent);
      if (nextIncomeTx.recurringRuleId !== salaryRule.id) problems.push(`E) nextIncome não está vindo da rule de salário (recurringRuleId=${nextIncomeTx.recurringRuleId}) — a correção da VA rule não deveria afetar isso`);
      // F/G) freeMoney/safeToSpend precisam continuar EXATAMENTE o que já eram
      // antes desta fase (capturados em preEngine, fora da tx) — a correção da
      // VA rule não deveria mover nenhum dos dois nem um centavo.
      if (compareMoney(freeMoneyResultTx.freeMoney, preEngine.freeMoney) !== 0) problems.push(`F) freeMoney tx-scoped=${freeMoneyResultTx.freeMoney.toString()} != freeMoney pré-existente ${preEngine.freeMoney.toString()}`);
      const preSafeToSpend = computeSafeToSpend(preEngine.freeMoney, settingsTx.safetyMarginPercent);
      if (compareMoney(safeToSpendTx.safeToSpend, preSafeToSpend.safeToSpend) !== 0) problems.push(`G) safeToSpend tx-scoped=${safeToSpendTx.safeToSpend.toString()} != safeToSpend pré-existente ${preSafeToSpend.safeToSpend.toString()}`);
      // H) status financeiro permanece o mesmo (é função determinística de
      // freeMoney+projeções, nenhuma das quais depende do dayOfMonth da VA rule).
      if (preStatus.status !== "APERTADO") throw new Error(`Pré-condição inesperada: status pré-existente não é APERTADO (é ${preStatus.status}) — abortando antes de prosseguir.`);
      txSummary = { vaBalanceTx: vaBalanceTx.toString(), freeMoneyTx: freeMoneyResultTx.freeMoney.toString(), safeToSpendTx: safeToSpendTx.safeToSpend.toString(), nextIncomeRecurringRuleId: nextIncomeTx.recurringRuleId };

      if (problems.length > 0) throw new Error(`Invariantes falharam dentro da transação:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

      log(`  [tx] VA balance=${vaBalanceTx.toString()} | freeMoney=${freeMoneyResultTx.freeMoney.toString()} | safeToSpend=${safeToSpendTx.safeToSpend.toString()} | nextIncome de rule=${nextIncomeTx.recurringRuleId === salaryRule.id ? "SALÁRIO ✅" : "OUTRA ❌"}`);

      txStatus = "COMMITTED";
    });
  } catch (err) {
    txStatus = "ROLLED_BACK";
    console.error(`\n🛑 TRANSAÇÃO REVERTIDA: ${err.message}`);
    log(`\nVA_RULE_APPLY_STATUS = FAILED_ROLLED_BACK`);
    await prisma.$disconnect();
    process.exit(1);
  }

  log(`\nTRANSACTION STATUS: ${txStatus}`);

  // ==========================================================================
  // Post-commit validation (prisma normal)
  // ==========================================================================
  const postVaSnapshot = await buildVaSnapshot();
  const nextIncomePost = await getNextIncomeInfo();
  const accountsPost = await listAccountsWithBalances();
  const freeMoneyPost = await computeFreeMoney({ nextIncomeDate: nextIncomePost.expectedDate, accounts: accountsPost });
  const settingsPost = await getAppSettings();
  const safeToSpendPost = computeSafeToSpend(freeMoneyPost.freeMoney, settingsPost.safetyMarginPercent);
  const currentObligationHorizonEndPost = computeCurrentObligationHorizonEnd(nextIncomePost);
  const [basePost, expectedPost, stressPost] = await Promise.all([
    buildBaseProjection({ now: new Date(), accounts: accountsPost }),
    buildExpectedProjection({ now: new Date(), accounts: accountsPost }),
    buildStressProjection({ now: new Date(), accounts: accountsPost }),
  ]);
  const statusPost = computeFinancialStatus({ freeMoney: freeMoneyPost.freeMoney, nextIncomeDate: nextIncomePost.expectedDate, currentObligationHorizonEnd: currentObligationHorizonEndPost, nextIncomeStatus: nextIncomePost.status, baseProjection: basePost, expectedProjection: expectedPost, stressProjection: stressPost, unfundedConfirmedCommitments: { count: 0, amount: money(0), items: [] } });

  log(`\n--- Post-commit validation ---`);
  log(`  VA snapshot: balance=${postVaSnapshot.balance.toString()} recebido=${postVaSnapshot.recebido.toString()} gasto=${postVaSnapshot.gasto.toString()}`);
  log(`  nextRecharge: ANTES=${preVaSnapshot.nextRecharge?.toISOString().slice(0, 10)} DEPOIS=${postVaSnapshot.nextRecharge?.toISOString().slice(0, 10)}`);
  log(`  unrestrictedCash=${freeMoneyPost.unrestrictedCash.toString()} freeMoney=${freeMoneyPost.freeMoney.toString()} safeToSpend=${safeToSpendPost.safeToSpend.toString()} status=${statusPost.status}`);

  // --- Fingerprint proteção ---
  const postFingerprint = await fingerprintModels(OTHER_MODELS);
  const otherModelsIdentical = OTHER_MODELS.every((m) => JSON.stringify(preFingerprint[m]) === JSON.stringify(postFingerprint[m]));
  const cardModelsIdentical = ["card", "cardBill", "purchase", "installment", "cardLimitUpdate"].every((m) => JSON.stringify(preFingerprint[m]) === JSON.stringify(postFingerprint[m]));
  log(`\n--- Proteção ---`);
  log(`  Card subsistema idêntico: ${cardModelsIdentical ? "SIM ✅" : "NÃO ❌"}`);
  log(`  Todos os outros models (Income/Expense/Transfer/BalanceAdjustment/Account/ConfirmedCommitment/ExternalInstallmentPlan/ExternalInstallment/Contingency/...) idênticos: ${otherModelsIdentical ? "SIM ✅" : "NÃO ❌"}`);

  const postRules = await prisma.recurringRule.findMany();
  log(`\n--- Model count deltas ---`);
  log(`  RecurringRule count: ${postRules.length} (esperado igual ao anterior — só UPDATE, nenhum CREATE/DELETE)`);
  const salaryRuleAfter = postRules.find((r) => r.id === salaryRule.id);
  log(`  Salary rule inalterada: amount=${salaryRuleAfter.amount.toString()} dayOfMonth=${salaryRuleAfter.dayOfMonth}`);

  const backupPostPath = path.join(BACKUP_DIR, `post-fase52d-apply-${Date.now()}.local.json`);
  fs.writeFileSync(backupPostPath, JSON.stringify({ txSummary, postVaSnapshot: { balance: postVaSnapshot.balance.toString(), recebido: postVaSnapshot.recebido.toString(), gasto: postVaSnapshot.gasto.toString(), nextRecharge: postVaSnapshot.nextRecharge }, otherModelsIdentical, cardModelsIdentical }, null, 2));
  log(`\n✅ Backup pós-write salvo em: ${backupPostPath}`);

  const allInvariantsPassed = txStatus === "COMMITTED" && cardModelsIdentical && otherModelsIdentical;
  log(`\nVA_RULE_APPLY_STATUS = ${allInvariantsPassed ? "SUCCESS" : "FAILED_ROLLED_BACK"}`);

  await prisma.$disconnect();
  return { status: allInvariantsPassed ? "SUCCESS" : "FAILED" };
}

main()
  .then((result) => {
    if (result?.status === "FAILED") process.exitCode = 1;
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
