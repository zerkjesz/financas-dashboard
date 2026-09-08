// ============================================================================
// Fase 5.2C — OBLIGATIONS DATA APPLY / DEV ONLY.
//
// Escopo estrito: salário-base recorrente (RecurringRule) + 1 ConfirmedCommitment
// (compromisso de janela incerta, semântica dueBy) + 9 ExternalInstallmentPlan +
// 38 ExternalInstallment restantes (numeração ORIGINAL preservada, nunca
// renumerada) + 1 Contingency (se o schema já suportar honestamente, o que a
// Fase 5.2A já confirmou). NADA de Card/CardBill/Purchase/Installment de
// cartão/CardLimitUpdate/Account balances/Itaú snapshot/Income/Expense/
// Transfer/BalanceAdjustment/VA/VA RecurringRule é tocado.
//
// Mesma disciplina das fases anteriores (5.1B-CARD-v2/5.1C-VA/5.1D.3): validação
// de invariantes DENTRO da transação via `client: tx`, nunca commit->valida->
// compensa. Genérico de propósito: todo valor real vem do input local
// gitignored, nunca hardcoded aqui.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, multiplyMoney, divideMoney, sumMoney, compareMoney } from "../lib/money.js";
import { computeFreeMoney, getObligationsBreakdown, computeSafeToSpend, getNextIncomeCommitment } from "../lib/freeMoney.js";
import { getNextIncomeInfo } from "../lib/incomeHorizon.js";
import { getAppSettings } from "../lib/settings.js";
import { OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { listAccountsWithBalances } from "../lib/accounts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const INPUT_PATH = path.join(HERE, "snapshot-input.local.json");
const BACKUP_DIR = path.join(HERE, "snapshot-reports");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";
const REQUIRED_MIGRATION = "20260907204941_external_installment_due_timing";

const DRY_RUN = process.argv.includes("--dry-run");

const OTHER_MODELS = [
  "account", "income", "expense", "transfer", "balanceAdjustment", "card", "cardBill", "purchase", "installment", "cardLimitUpdate",
  "bill", "goal", "reserve", "reserveMovement", "receivable", "categoryBudget", "cardCreditMovement", "appSettings",
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
  if (!fs.existsSync(path.join(REPO_ROOT, "prisma", "migrations", REQUIRED_MIGRATION))) {
    problems.push(`Migration obrigatória ausente: ${REQUIRED_MIGRATION}`);
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

async function fingerprintItauLedger(accountId, client = prisma) {
  const [incomes, expenses, transfers, adjustments] = await Promise.all([
    client.income.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
    client.expense.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
    client.transfer.findMany({ where: { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] }, orderBy: { id: "asc" } }),
    client.balanceAdjustment.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
  ]);
  const shape = (rows) => rows.map((r) => ({ id: r.id, occurredAt: r.occurredAt.toISOString(), amount: r.amount?.toString?.() ?? r.newBalance?.toString?.() }));
  return { incomeCount: incomes.length, expenseCount: expenses.length, transferCount: transfers.length, adjustmentCount: adjustments.length, income: shape(incomes), expense: shape(expenses), transfer: shape(transfers), adjustment: shape(adjustments) };
}

async function main() {
  log("==============================================================================");
  log("Fase 5.2C — OBLIGATIONS DATA APPLY (escopo: salário + compromisso + 9 planos + contingência)");
  log(DRY_RUN ? "MODO: --dry-run (preflight/simulação apenas, ZERO write)" : "MODO: WRITE REAL");
  log("==============================================================================");

  assertExtraSafety();
  log("✅ Ambiente dev confirmado + prisma migrate status clean + migration obrigatória presente.");

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const mainIncome = input.mainIncome;
  const windowedCommitmentInput = input.confirmedCommitments.find((c) => c.dateCandidates?.length === 2);
  const windowedCommitmentDueBy = new Date(`${windowedCommitmentInput.dateCandidates[windowedCommitmentInput.dateCandidates.length - 1]}T00:00:00.000Z`);
  const plans = input.externalInstallmentPlans;
  const contingencyInput = input.contingencies[0];

  const itauAccount = await prisma.account.findFirst({ where: { type: "checking" } });

  // ==========================================================================
  // Item 27 — IDEMPOTÊNCIA: checar PRIMEIRO se já está tudo aplicado (natural
  // identity, nunca só description) — antes de qualquer preflight estrito.
  // ==========================================================================
  // input.externalInstallmentPlans não tem um campo "creditor" separado — o
  // schema exige um (pessoa/entidade credora), então reaproveitamos a própria
  // `description` como creditor (nenhuma informação nova inventada, só reusada
  // no campo que o schema pede) — consistente entre a checagem de idempotência
  // abaixo e o CREATE de verdade dentro da transação.
  const creditorOf = (p) => p.creditor ?? p.description;
  const existingSalaryRule = await prisma.recurringRule.findFirst({ where: { kind: "income", accountId: itauAccount.id, amount: money(mainIncome.standardRecurringAmount), dayOfMonth: mainIncome.dayOfMonth } });
  const existingCommitment = await prisma.confirmedCommitment.findFirst({ where: { description: windowedCommitmentInput.description, amount: money(windowedCommitmentInput.amount) } });
  const existingPlans = await prisma.externalInstallmentPlan.findMany({ include: { installments: true } });
  const planNaturalKey = (p) => `${p.description}|${p.creditor ?? ""}|${money(p.installmentValue).toString()}|${p.installmentCount}`;
  const existingPlansByKey = new Map(existingPlans.map((p) => [planNaturalKey(p), p]));
  const existingContingency = await prisma.contingency.findFirst({ where: { description: contingencyInput.description } });

  const plansMatch = plans.map((p) => existingPlansByKey.get(`${p.description}|${creditorOf(p)}|${money(p.installmentValue).toString()}|${p.installmentCount}`));
  const allNineExist = plansMatch.every(Boolean);

  const fullyApplied = existingSalaryRule != null && existingCommitment != null && allNineExist && existingContingency != null;
  if (fullyApplied) {
    log(`\n✅ NO_MUTATIONS_NEEDED — salário/compromisso/9 planos/contingência já existem (natural identity confirmada) — idempotência garantida, nenhum CREATE.`);
    log(`\n==============================================================================`);
    log(`RESULTADO: NO_MUTATIONS_NEEDED`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "NO_MUTATIONS_NEEDED" };
  }

  // ==========================================================================
  // Item 4 — preflight ESTRITO (só chega aqui se NÃO estiver fully applied acima)
  // ==========================================================================
  const preflightPlanCount = await prisma.externalInstallmentPlan.count();
  const preflightInstallmentCount = await prisma.externalInstallment.count();
  log(`\n--- Preflight ---`);
  log(`  ExternalInstallmentPlan atual: ${preflightPlanCount} (esperado 0)`);
  log(`  ExternalInstallment atual: ${preflightInstallmentCount} (esperado 0)`);
  if (preflightPlanCount !== 0 || preflightInstallmentCount !== 0) {
    console.error(`\n🛑 ABORTADO — estado inesperado (nem zerado, nem totalmente aplicado). Não tentar merge automático.`);
    process.exit(1);
  }
  log(`  Salário RecurringRule equivalente: ${existingSalaryRule ? "JÁ EXISTE (inesperado nesta preflight)" : "ausente ✅"}`);
  log(`  Compromisso equivalente: ${existingCommitment ? "JÁ EXISTE (inesperado)" : "ausente ✅"}`);
  log(`  Contingência equivalente: ${existingContingency ? "JÁ EXISTE (inesperado)" : "ausente ✅"}`);
  if (existingSalaryRule || existingCommitment) {
    console.error(`\n🛑 ABORTADO — estado parcial inesperado (planos zerados, mas salário/compromisso já existem). Não tentar merge automático.`);
    process.exit(1);
  }

  // ==========================================================================
  // Item 3 — baseline / backup completo (22 models + fingerprints dedicados)
  // ==========================================================================
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const preFingerprint = await fingerprintModels([...OTHER_MODELS, "recurringRule", "confirmedCommitment", "externalInstallmentPlan", "externalInstallment", "contingency"]);
  const preItauLedgerFp = await fingerprintItauLedger(itauAccount.id);
  const preEngineState = await computeFreeMoney({ nextIncomeDate: (await getNextIncomeInfo()).expectedDate, accounts: await listAccountsWithBalances() });
  const backupPath = path.join(BACKUP_DIR, `pre-fase52c-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ preFingerprint, preItauLedgerFp, preEngineState: { unrestrictedCash: preEngineState.unrestrictedCash.toString(), freeMoney: preEngineState.freeMoney.toString() } }, null, 2));
  log(`\n✅ Backup pré-write salvo em: ${backupPath}`);

  if (DRY_RUN) {
    log(`\n[--dry-run] CREATE candidates:`);
    log(`  RecurringRule salário: amount=${money(mainIncome.standardRecurringAmount).toString()} dayOfMonth=${mainIncome.dayOfMonth}`);
    log(`  ConfirmedCommitment: ${windowedCommitmentInput.description} amount=${money(windowedCommitmentInput.amount).toString()} dueDate(dueBy)=${windowedCommitmentDueBy.toISOString().slice(0, 10)}`);
    for (const p of plans) log(`  ExternalInstallmentPlan: ${p.description} installmentValue=${money(p.installmentValue).toString()} remaining=${p.installmentCount - p.paidInstallments} (numbers ${p.paidInstallments + 1}..${p.installmentCount})`);
    log(`  Contingency: ${contingencyInput.description} expected=${money(contingencyInput.expectedAmount).toString()} max=${money(contingencyInput.maxAmount).toString()}`);
    log(`\n==============================================================================`);
    log(`RESULTADO: DRY_RUN_COMPLETE`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "DRY_RUN_COMPLETE", backupPath };
  }

  // ==========================================================================
  // Item 17 — transação única
  // ==========================================================================
  let txResult = null;
  let txStatus = "ROLLED_BACK";
  try {
    await prisma.$transaction(async (tx) => {
      // preflight re-validado dentro da tx
      const freshPlanCount = await tx.externalInstallmentPlan.count();
      const freshInstallmentCount = await tx.externalInstallment.count();
      if (freshPlanCount !== 0 || freshInstallmentCount !== 0) throw new Error("Preflight falhou dentro da transação — estado mudou entre o preflight externo e a transação.");

      // --- salário-base recorrente ---
      const salaryRule = await tx.recurringRule.create({
        data: {
          name: "Salário",
          kind: "income",
          amount: money(mainIncome.standardRecurringAmount),
          dayOfMonth: mainIncome.dayOfMonth,
          accountId: itauAccount.id,
          category: "Renda",
          isActive: true,
        },
      });
      log(`\nCREATE RecurringRule (salário): id=${salaryRule.id}`);

      // --- compromisso confirmado (semântica dueBy) ---
      const commitment = await tx.confirmedCommitment.create({
        data: {
          description: windowedCommitmentInput.description,
          amount: money(windowedCommitmentInput.amount),
          dueDate: windowedCommitmentDueBy,
          status: "CONFIRMED",
          confidence: "CONFIRMED",
          notes: `Janela de pagamento conhecida: ${windowedCommitmentInput.dateCandidates.join(" a ")}. dueDate é o boundary DUE_BY (o mais tardio dos candidatos confirmados) — NÃO é uma afirmação de que o pagamento ocorre exatamente nesta data, só o limite mais conservador dentro da janela conhecida.`,
        },
      });
      log(`CREATE ConfirmedCommitment: id=${commitment.id}`);

      // --- 9 planos + parcelas restantes, numeração original preservada ---
      const createdPlans = [];
      for (const p of plans) {
        const plan = await tx.externalInstallmentPlan.create({
          data: {
            description: p.description,
            creditor: creditorOf(p),
            installmentValue: money(p.installmentValue),
            installmentCount: p.installmentCount,
            firstDueDate: null,
            dueTiming: "AFTER_NEXT_INCOME",
            confidence: p.confidence ?? "CONFIRMED_BY_MEMORY",
            notes: p.source ?? null,
          },
        });
        const remainingRows = [];
        for (let number = p.paidInstallments + 1; number <= p.installmentCount; number++) {
          remainingRows.push({ planId: plan.id, number, amount: money(p.installmentValue), dueDate: null, status: "PENDING" });
        }
        if (remainingRows.length > 0) await tx.externalInstallment.createMany({ data: remainingRows });
        createdPlans.push({ ...plan, remainingNumbers: remainingRows.map((r) => r.number) });
        log(`CREATE ExternalInstallmentPlan: id=${plan.id} "${p.description}" — installments criadas: [${remainingRows.map((r) => r.number).join(", ")}]`);
      }

      // --- contingência (schema já suporta expectedAmount+maxAmount separados — sem DEFER) ---
      const contingency = await tx.contingency.create({
        data: {
          description: contingencyInput.description,
          expectedAmount: money(contingencyInput.expectedAmount),
          maxAmount: money(contingencyInput.maxAmount),
          expectedDate: null,
          status: "AWAITING_INFORMATION",
          confidence: "ESTIMATED", // combina expectedAmount(ESTIMATED)+maxAmount(CONFIRMED_BY_MEMORY) — escolhido o mais conservador, já que o schema só tem 1 campo de confidence pra linha inteira
        },
      });
      log(`CREATE Contingency: id=${contingency.id}`);

      // --- Item 19: invariantes de freeMoney, tx-scoped ---
      const nextIncomeTx = await getNextIncomeInfo({ client: tx });
      const accounts = await listAccountsWithBalances(); // saldos não mudam nesta fase — leitura via prisma global é segura aqui
      const freeMoneyResultTx = await computeFreeMoney({ nextIncomeDate: nextIncomeTx.expectedDate, accounts, client: tx });
      const safeToSpendTx = computeSafeToSpend(freeMoneyResultTx.freeMoney, (await getAppSettings({ client: tx })).safetyMarginPercent);
      const nextIncomeCommitmentTx = await getNextIncomeCommitment({ nextIncome: nextIncomeTx, client: tx });
      const buckets = await getObligationsBreakdown({ nextIncomeDate: nextIncomeTx.expectedDate, client: tx });

      const problems = [];
      if (nextIncomeTx.status === "FALLBACK" || nextIncomeTx.amount == null) problems.push(`nextIncome ainda em FALLBACK/amount=null: ${JSON.stringify(nextIncomeTx)}`);
      if (compareMoney(money(nextIncomeTx.amount ?? 0), money(mainIncome.standardRecurringAmount)) !== 0) problems.push(`nextIncome.amount=${nextIncomeTx.amount} != base salary ${mainIncome.standardRecurringAmount}`);

      const expectedFreeMoney = subtractMoney(subtractMoney(freeMoneyResultTx.unrestrictedCash, freeMoneyResultTx.incurredLiabilities), money(windowedCommitmentInput.amount));
      if (compareMoney(freeMoneyResultTx.freeMoney, expectedFreeMoney) !== 0) problems.push(`freeMoney tx-scoped=${freeMoneyResultTx.freeMoney.toString()} != esperado ${expectedFreeMoney.toString()}`);

      const commitmentClass = buckets[OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION].items.find((i) => i.type === "ConfirmedCommitment" && i.id === commitment.id);
      if (!commitmentClass) problems.push("o compromisso criado não caiu em CURRENT_HORIZON_OBLIGATION dentro da transação");

      const nextWindowItems = buckets[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].items.filter((i) => createdPlans.some((p) => p.id === i.planId));
      if (nextWindowItems.length !== plans.length) problems.push(`esperado ${plans.length} itens em NEXT_INCOME_WINDOW_COMMITMENT (1 por plano), encontrado ${nextWindowItems.length}`);
      const nextWindowTotal = sumMoney(nextWindowItems.map((i) => i.amount));
      const expectedPackage = sumMoney(plans.map((p) => money(p.installmentValue)));
      if (compareMoney(nextWindowTotal, expectedPackage) !== 0) problems.push(`next-income package tx-scoped=${nextWindowTotal.toString()} != esperado ${expectedPackage.toString()}`);

      const futureItemsFromOurPlans = buckets[OBLIGATION_CLASS.FUTURE_OBLIGATION].items.filter((i) => createdPlans.some((p) => p.id === i.planId));
      const expectedFutureCount = createdPlans.reduce((acc, p) => acc + Math.max(0, p.remainingNumbers.length - 1), 0);
      if (futureItemsFromOurPlans.length !== expectedFutureCount) problems.push(`esperado ${expectedFutureCount} itens FUTURE_OBLIGATION dos planos novos, encontrado ${futureItemsFromOurPlans.length}`);

      const knownNextIncomeCommitted = addMoney(freeMoneyResultTx.incurredLiabilities, expectedPackage);
      if (compareMoney(nextIncomeCommitmentTx.committedAmount, knownNextIncomeCommitted) < 0) problems.push(`nextIncomeCommitment.committedAmount=${nextIncomeCommitmentTx.committedAmount.toString()} menor que o esperado ${knownNextIncomeCommitted.toString()}`);

      if (problems.length > 0) throw new Error(`Invariantes falharam dentro da transação:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

      log(`\n[tx] freeMoney=${freeMoneyResultTx.freeMoney.toString()} safeToSpend=${safeToSpendTx.safeToSpend.toString()} nextIncomeCommitment=${nextIncomeCommitmentTx.committedAmount.toString()} committedPercent=${nextIncomeCommitmentTx.committedPercent?.toFixed(2)}%`);

      txResult = { salaryRuleId: salaryRule.id, commitmentId: commitment.id, planIds: createdPlans.map((p) => p.id), contingencyId: contingency.id, freeMoneyTx: freeMoneyResultTx.freeMoney.toString(), safeToSpendTx: safeToSpendTx.safeToSpend.toString() };
      txStatus = "COMMITTED";
    });
  } catch (err) {
    txStatus = "ROLLED_BACK";
    console.error(`\n🛑 TRANSAÇÃO REVERTIDA: ${err.message}`);
    log(`\nOBLIGATIONS_DATA_APPLY_STATUS = FAILED_ROLLED_BACK`);
    await prisma.$disconnect();
    process.exit(1);
  }

  log(`\nTRANSACTION STATUS: ${txStatus}`);

  // ==========================================================================
  // Item 29/30 — post-commit validation via prisma normal
  // ==========================================================================
  const nextIncomePost = await getNextIncomeInfo();
  const accountsPost = await listAccountsWithBalances();
  const freeMoneyPost = await computeFreeMoney({ nextIncomeDate: nextIncomePost.expectedDate, accounts: accountsPost });
  const settingsPost = await getAppSettings();
  const safeToSpendPost = computeSafeToSpend(freeMoneyPost.freeMoney, settingsPost.safetyMarginPercent);
  const nextIncomeCommitmentPost = await getNextIncomeCommitment({ nextIncome: nextIncomePost });
  const bucketsPost = await getObligationsBreakdown({ nextIncomeDate: nextIncomePost.expectedDate });

  log(`\n--- Post-commit engine (prisma normal) ---`);
  log(`  unrestrictedCash=${freeMoneyPost.unrestrictedCash.toString()}`);
  log(`  incurredLiabilities=${freeMoneyPost.incurredLiabilities.toString()}`);
  log(`  freeMoney=${freeMoneyPost.freeMoney.toString()}`);
  log(`  safeToSpend=${safeToSpendPost.safeToSpend.toString()}`);
  log(`  nextIncome: date=${nextIncomePost.expectedDate.toISOString().slice(0, 10)} baseAmount=${nextIncomePost.amount?.toString()} status=${nextIncomePost.status}`);
  log(`  nextIncomeWindowCommitment=${bucketsPost[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].total.toString()} (${bucketsPost[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].items.length} itens)`);
  log(`  futureObligation=${bucketsPost[OBLIGATION_CLASS.FUTURE_OBLIGATION].total.toString()} (${bucketsPost[OBLIGATION_CLASS.FUTURE_OBLIGATION].items.length} itens)`);
  log(`  nextIncomeCommitment.committedAmount=${nextIncomeCommitmentPost.committedAmount.toString()} committedPercent=${nextIncomeCommitmentPost.committedPercent?.toFixed(2)}%`);

  // --- estimated phone scenario (nunca persistido) ---
  const phoneInput = input.householdBills.find((b) => b.name === "Phone");
  const estimatedPhoneScenario = subtractMoney(freeMoneyPost.freeMoney, money(phoneInput.amount));
  log(`  ESTIMATED_PHONE_SCENARIO (não persistido): ${freeMoneyPost.freeMoney.toString()} - ${money(phoneInput.amount).toString()} = ${estimatedPhoneScenario.toString()}`);

  // --- likely household scenario (não persistido) ---
  const likelyItems = [money(1000), money(450), money(114.9), money(59.27), money(phoneInput.amount), money(200), freeMoneyPost.incurredLiabilities, bucketsPost[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].total];
  const likelyTotal = sumMoney(likelyItems);
  const likelyPercent = multiplyMoney(divideMoney(likelyTotal, money(mainIncome.standardRecurringAmount)), 100);
  log(`  LIKELY_NEXT_INCOME_SCENARIO (PARTIALLY_ESTIMATED, não persistido): total=${likelyTotal.toString()} (${likelyPercent.toFixed(2)}% do salário-base)`);

  // ==========================================================================
  // Item 22/23 — Card fingerprint (proibido mudar)
  // ==========================================================================
  const postFingerprint = await fingerprintModels(OTHER_MODELS);
  const cardModelsIdentical = ["card", "cardBill", "purchase", "installment", "cardLimitUpdate"].every((m) => JSON.stringify(preFingerprint[m]) === JSON.stringify(postFingerprint[m]));
  const otherModelsIdentical = OTHER_MODELS.every((m) => JSON.stringify(preFingerprint[m]) === JSON.stringify(postFingerprint[m]));
  const postItauLedgerFp = await fingerprintItauLedger(itauAccount.id);
  const itauLedgerIdentical = JSON.stringify(preItauLedgerFp) === JSON.stringify(postItauLedgerFp);
  log(`\n--- Proteção Card/VA/Itaú ---`);
  log(`  Card subsistema (Card/CardBill/Purchase/Installment/CardLimitUpdate) idêntico: ${cardModelsIdentical ? "SIM ✅" : "NÃO ❌"}`);
  log(`  Todos os outros models protegidos (Income/Expense/Transfer/BalanceAdjustment/Account/Bill/Goal/Reserve/...) idênticos: ${otherModelsIdentical ? "SIM ✅" : "NÃO ❌"}`);
  log(`  Itaú ledger (Income/Expense/Transfer/BalanceAdjustment da conta) idêntico: ${itauLedgerIdentical ? "SIM ✅" : "NÃO ❌"}`);

  // ==========================================================================
  // Item 18 — model count deltas
  // ==========================================================================
  const postCounts = {
    recurringRule: await prisma.recurringRule.count(),
    confirmedCommitment: await prisma.confirmedCommitment.count(),
    externalInstallmentPlan: await prisma.externalInstallmentPlan.count(),
    externalInstallment: await prisma.externalInstallment.count(),
    contingency: await prisma.contingency.count(),
  };
  log(`\n--- Model count deltas ---`);
  log(`  RecurringRule: +1 (agora ${postCounts.recurringRule})`);
  log(`  ConfirmedCommitment: +1 (agora ${postCounts.confirmedCommitment})`);
  log(`  ExternalInstallmentPlan: +${plans.length} (agora ${postCounts.externalInstallmentPlan})`);
  log(`  ExternalInstallment: +${plans.reduce((a, p) => a + (p.installmentCount - p.paidInstallments), 0)} (agora ${postCounts.externalInstallment})`);
  log(`  Contingency: +1 (agora ${postCounts.contingency})`);

  const backupPostPath = path.join(BACKUP_DIR, `post-fase52c-apply-${Date.now()}.local.json`);
  fs.writeFileSync(backupPostPath, JSON.stringify({ txResult, postCounts, cardModelsIdentical, otherModelsIdentical, itauLedgerIdentical, freeMoneyPost: freeMoneyPost.freeMoney.toString(), safeToSpendPost: safeToSpendPost.safeToSpend.toString() }, null, 2));
  log(`\n✅ Backup pós-write salvo em: ${backupPostPath}`);

  const allInvariantsPassed = txStatus === "COMMITTED" && cardModelsIdentical && otherModelsIdentical && itauLedgerIdentical;
  log(`\nOBLIGATIONS_DATA_APPLY_STATUS = ${allInvariantsPassed ? "SUCCESS" : "FAILED_ROLLED_BACK"}`);

  await prisma.$disconnect();
  return { status: allInvariantsPassed ? "SUCCESS" : "FAILED", txResult };
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
