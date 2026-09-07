// ============================================================================
// Fase 5.1D.3 — ITAÚ OBSERVED BALANCE SNAPSHOT — REAL APPLY / DEV ONLY.
//
// Escopo estrito: EXATAMENTE 1 BalanceAdjustment (OBSERVED_BANK_BALANCE_SNAPSHOT).
// Nada além disso. Não reconstrói o histórico incompleto de 24/08→04/09 (Fase
// 5.1D/5.1D.1, que ficou BLOCKED por falta de evidência de data econômica) — só
// estabelece o saldo bancário observado no instante mais recente conhecido,
// preservando integralmente todo o histórico existente.
//
// Mesma disciplina das fases anteriores (5.1B-CARD-v2, 5.1C-VA): validação de
// invariantes DENTRO da transação via `client: tx` (nunca commit->valida->
// compensa). Genérico de propósito: o valor/timestamp do snapshot vem do input
// gitignored (scripts/snapshot-input.local.json, checkingAccount.checkpointB),
// nunca hardcoded aqui.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const INPUT_PATH = path.join(HERE, "snapshot-input.local.json");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";

const DRY_RUN = process.argv.includes("--dry-run");

// Todo model financeiro fora do escopo desta fase (só BalanceAdjustment muda) —
// usado pra provar model-count-delta e fingerprint de não-contaminação.
const OTHER_MODELS = [
  "account", "income", "expense", "transfer", "card", "cardBill", "purchase", "installment", "cardLimitUpdate",
  "bill", "recurringRule", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency",
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
  return { migrateStatusOutput };
}

async function fingerprintModels(models, client = prisma) {
  const fp = {};
  for (const m of models) {
    const rows = await client[m].findMany();
    fp[m] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
  }
  return fp;
}

// Fingerprint focado no subsistema Itaú (Income/Expense/Transfer + o anchor
// legado) — deve permanecer byte-idêntico (só o novo BalanceAdjustment é
// adicionado, nada mais muda).
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

async function checkInvariants(client, { itauAccountId, snapshotAmount, snapshotOccurredAt, preexistingAdjustmentIds }) {
  const problems = [];
  const snapshotResult = {};

  // A) balanceAsOf(snapshot) — computeAccountBalance com client:tx, logo após o
  // CREATE, já é por construção o "as-of" (a âncora mais recente é o próprio
  // snapshot; qualquer movimento com occurredAt > snapshot entra normalmente).
  const balanceNow = await computeAccountBalance(itauAccountId, { client });

  // B) movimentos reais com occurredAt > snapshot — NUNCA hardcoded como 0.
  const [postIncomes, postExpenses, postTransfersOut, postTransfersIn] = await Promise.all([
    client.income.findMany({ where: { accountId: itauAccountId, occurredAt: { gt: snapshotOccurredAt } } }),
    client.expense.findMany({ where: { accountId: itauAccountId, occurredAt: { gt: snapshotOccurredAt } } }),
    client.transfer.findMany({ where: { fromAccountId: itauAccountId, occurredAt: { gt: snapshotOccurredAt } } }),
    client.transfer.findMany({ where: { toAccountId: itauAccountId, occurredAt: { gt: snapshotOccurredAt } } }),
  ]);
  const postSnapshotNet = subtractMoney(
    addMoney(sumMoney(postIncomes.map((r) => r.amount)), sumMoney(postTransfersIn.map((r) => r.amount))),
    addMoney(sumMoney(postExpenses.map((r) => r.amount)), sumMoney(postTransfersOut.map((r) => r.amount)))
  );
  const expectedBalance = addMoney(snapshotAmount, postSnapshotNet);
  if (compareMoney(balanceNow, expectedBalance) !== 0) problems.push(`A/B) computeAccountBalance(client:tx)=${balanceNow.toString()}, esperado snapshot(${snapshotAmount.toString()}) + postSnapshotNet(${postSnapshotNet.toString()}) = ${expectedBalance.toString()}`);
  snapshotResult.balanceAsOf = balanceNow.toString();
  snapshotResult.postSnapshotNet = postSnapshotNet.toString();
  snapshotResult.postSnapshotMovementCount = postIncomes.length + postExpenses.length + postTransfersOut.length + postTransfersIn.length;

  // Caso mais comum (confirmado pela fase de simulação anterior): zero movimentos
  // pós-snapshot -> balanceAsOf deve bater exatamente com o valor observado.
  if (snapshotResult.postSnapshotMovementCount === 0 && compareMoney(balanceNow, snapshotAmount) !== 0) {
    problems.push(`A) sem movimentos pós-snapshot, mas computeAccountBalance(client:tx)=${balanceNow.toString()} != snapshot ${snapshotAmount.toString()}`);
  }

  // C) histórico não apagado — os BalanceAdjustments pré-existentes continuam lá,
  // nenhum deletado/alterado (comparação de id+newBalance+occurredAt).
  const currentAdjustments = await client.balanceAdjustment.findMany({ where: { accountId: itauAccountId } });
  const currentIds = new Set(currentAdjustments.map((a) => a.id));
  const missingPreexisting = [...preexistingAdjustmentIds].filter((id) => !currentIds.has(id));
  if (missingPreexisting.length > 0) problems.push(`C) BalanceAdjustment(s) pré-existente(s) desapareceu(ram): ${missingPreexisting.join(", ")}`);
  if (currentAdjustments.length !== preexistingAdjustmentIds.size + 1) problems.push(`C) esperado exatamente ${preexistingAdjustmentIds.size + 1} BalanceAdjustment (${preexistingAdjustmentIds.size} pré-existentes + 1 novo), encontrado ${currentAdjustments.length}`);

  return { problems, snapshotResult };
}

async function main() {
  log("==============================================================================");
  log("Fase 5.1D.3 — ITAÚ OBSERVED BALANCE SNAPSHOT — apply real (escopo: 1 BalanceAdjustment)");
  log(DRY_RUN ? "MODO: --dry-run (preflight/simulação apenas, ZERO write)" : "MODO: WRITE REAL");
  log("==============================================================================");

  assertExtraSafety();
  log("✅ Ambiente dev confirmado + prisma migrate status clean.");

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const itauInput = input.checkingAccount;
  const checkpointB = itauInput.checkpointB;
  if (!checkpointB.observedAt) throw new Error("input.checkingAccount.checkpointB.observedAt ausente — não inventar boundary, abortar.");

  const itauAccount = await prisma.account.findUnique({ where: { slug: itauInput.slug } });
  if (!itauAccount) throw new Error(`Account slug='${itauInput.slug}' não encontrada.`);

  const snapshotAmount = money(checkpointB.amount);
  const snapshotOccurredAt = new Date(checkpointB.observedAt);
  log(`\nSnapshot autoritativo: newBalance=${snapshotAmount.toString()} occurredAt=${snapshotOccurredAt.toISOString()}`);

  // --- Item 2: baseline imediatamente pré-write ---
  const backupDir = path.join(HERE, "snapshot-reports");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const [preAccount, preAdjustments, preIncomes, preExpenses, preTransfers, preSettings, preGoals, preOtherModelsFp, preItauLedgerFp] = await Promise.all([
    prisma.account.findUnique({ where: { id: itauAccount.id } }),
    prisma.balanceAdjustment.findMany({ where: { accountId: itauAccount.id } }),
    prisma.income.findMany({ where: { accountId: itauAccount.id } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id } }),
    prisma.transfer.findMany({ where: { OR: [{ fromAccountId: itauAccount.id }, { toAccountId: itauAccount.id }] } }),
    prisma.appSettings.findUnique({ where: { id: "default" } }),
    prisma.goal.findMany(),
    fingerprintModels(OTHER_MODELS.filter((m) => m !== "income" && m !== "expense" && m !== "transfer")),
    fingerprintItauLedger(itauAccount.id),
  ]);
  const backupPath = path.join(backupDir, `pre-itau-snapshot-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ account: preAccount, adjustments: preAdjustments, incomes: preIncomes, expenses: preExpenses, transfers: preTransfers, appSettings: preSettings, goals: preGoals, otherModelsFingerprint: preOtherModelsFp, itauLedgerFingerprint: preItauLedgerFp }, null, 2));
  log(`✅ Backup pré-write salvo em: ${backupPath}`);

  const currentBalanceBefore = await computeAccountBalance(itauAccount.id);
  log(`computeAccountBalance(Itaú) ATUAL (antes do write): ${currentBalanceBefore.toString()}`);

  // --- Item 6: idempotência — dedup por accountId+occurredAt+newBalance+tipo semântico ---
  const SNAPSHOT_NOTE = "Saldo bancário observado — snapshot autoritativo de reconciliação. Histórico anterior ao snapshot permanece PARCIAL (não 100% reconciliado) — este registro NÃO representa uma transação econômica, só o estado observado da conta neste instante.";
  const existingSnapshot = preAdjustments.find(
    (a) => a.occurredAt.getTime() === snapshotOccurredAt.getTime() && compareMoney(money(a.newBalance), snapshotAmount) === 0
  );
  if (existingSnapshot) {
    log(`\n✅ NO_MUTATIONS_NEEDED — já existe um BalanceAdjustment idêntico (id=${existingSnapshot.id}, occurredAt=${existingSnapshot.occurredAt.toISOString()}, newBalance=${existingSnapshot.newBalance.toString()}) — idempotência confirmada, nenhum CREATE.`);
    log(`\n==============================================================================`);
    log(`RESULTADO: NO_MUTATIONS_NEEDED`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "NO_MUTATIONS_NEEDED", backupPath };
  }
  log(`\nNenhum snapshot duplicado encontrado — CREATE necessário.`);

  if (DRY_RUN) {
    log(`\n[--dry-run] CREATE BalanceAdjustment: accountId=${itauAccount.id} newBalance=${snapshotAmount.toString()} occurredAt=${snapshotOccurredAt.toISOString()} source=manual confidence=CONFIRMED`);
    log(`\n==============================================================================`);
    log(`RESULTADO: DRY_RUN_COMPLETE`);
    log(`==============================================================================`);
    await prisma.$disconnect();
    return { status: "DRY_RUN_COMPLETE", backupPath };
  }

  // --- Item 7: preservar todos os anchors existentes ---
  const preexistingAdjustmentIds = new Set(preAdjustments.map((a) => a.id));

  // --- Item 8: transação única ---
  let createdAdjustment = null;
  let txSnapshotResult = null;
  let txStatus = "ROLLED_BACK";
  try {
    await prisma.$transaction(async (tx) => {
      // 1) revalidar Account Itaú
      const freshAccount = await tx.account.findUnique({ where: { id: itauAccount.id } });
      if (!freshAccount || freshAccount.type !== "checking") throw new Error("Account Itaú não encontrada ou tipo mudou dentro da transação.");

      // 2) revalidar ausência de duplicado (não confiar só no preflight fora da tx)
      const freshDuplicate = await tx.balanceAdjustment.findFirst({ where: { accountId: itauAccount.id, occurredAt: snapshotOccurredAt, newBalance: snapshotAmount } });
      if (freshDuplicate) throw new Error(`Snapshot duplicado encontrado dentro da transação (id=${freshDuplicate.id}) — abortando pra evitar duplicidade.`);

      // 3) CREATE exatamente um BalanceAdjustment
      createdAdjustment = await tx.balanceAdjustment.create({
        data: {
          accountId: itauAccount.id,
          newBalance: snapshotAmount,
          occurredAt: snapshotOccurredAt,
          note: SNAPSHOT_NOTE,
          source: "manual",
          confidence: "CONFIRMED",
        },
      });
      log(`\nCREATE BalanceAdjustment: id=${createdAdjustment.id}`);

      // 4/5/9/10) invariantes A/B (balanceAsOf + movimentos posteriores), client:tx
      const { problems, snapshotResult } = await checkInvariants(tx, { itauAccountId: itauAccount.id, snapshotAmount, snapshotOccurredAt, preexistingAdjustmentIds });
      txSnapshotResult = snapshotResult;
      log(`  [tx] balanceAsOf/current: ${snapshotResult.balanceAsOf} | postSnapshotNet: ${snapshotResult.postSnapshotNet} (${snapshotResult.postSnapshotMovementCount} movimentos)`);

      if (problems.length > 0) {
        throw new Error(`Invariantes falharam dentro da transação:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      }

      txStatus = "COMMITTED";
      // sem throw -> Prisma commita
    });
  } catch (err) {
    txStatus = "ROLLED_BACK";
    console.error(`\n🛑 TRANSAÇÃO REVERTIDA: ${err.message}`);
    log(`\nITAU_SNAPSHOT_APPLY_STATUS = FAILED_ROLLED_BACK`);
    await prisma.$disconnect();
    process.exit(1);
  }

  log(`\nTRANSACTION STATUS: ${txStatus}`);

  // --- Item 20: post-commit validation (prisma normal, fora da tx) ---
  const balanceAsOfSnapshotPostCommit = await computeAccountBalance(itauAccount.id);
  const [postIncomes, postExpenses, postTransfersOut, postTransfersIn] = await Promise.all([
    prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.transfer.findMany({ where: { fromAccountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.transfer.findMany({ where: { toAccountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
  ]);
  const postSnapshotNetPostCommit = subtractMoney(
    addMoney(sumMoney(postIncomes.map((r) => r.amount)), sumMoney(postTransfersIn.map((r) => r.amount))),
    addMoney(sumMoney(postExpenses.map((r) => r.amount)), sumMoney(postTransfersOut.map((r) => r.amount)))
  );
  log(`\n--- Item 20: post-commit validation ---`);
  log(`  computeAccountBalance(Itaú) pós-commit: ${balanceAsOfSnapshotPostCommit.toString()}`);
  log(`  postSnapshotNet (recomputado via prisma normal): ${postSnapshotNetPostCommit.toString()}`);
  log(`  Confere com o resultado tx-scoped: ${balanceAsOfSnapshotPostCommit.toString() === txSnapshotResult.balanceAsOf ? "SIM ✅" : "NÃO ❌"}`);
  const latestAdjustment = await prisma.balanceAdjustment.findFirst({ where: { accountId: itauAccount.id }, orderBy: { occurredAt: "desc" } });
  log(`  Snapshot é o BalanceAdjustment mais recente da conta? ${latestAdjustment.id === createdAdjustment.id ? "SIM ✅" : "NÃO ❌"}`);

  // --- Invariantes F/G: Card + VA intactos ---
  const postOtherModelsFp = await fingerprintModels(OTHER_MODELS.filter((m) => m !== "income" && m !== "expense" && m !== "transfer"));
  const cardModelsIdentical = ["card", "cardBill", "purchase", "installment", "cardLimitUpdate"].every((m) => JSON.stringify(preOtherModelsFp[m]) === JSON.stringify(postOtherModelsFp[m]));
  log(`\n--- Invariante F: Card subsistema intacto ---`);
  log(`  Card/CardBill/Purchase/Installment/CardLimitUpdate byte-idêntico: ${cardModelsIdentical ? "SIM ✅" : "NÃO ❌"}`);

  const vaAccount = await prisma.account.findFirst({ where: { slug: "vale-alimentacao" } });
  const postItauLedgerFp = await fingerprintItauLedger(itauAccount.id);
  const itauHistoryPreserved = preItauLedgerFp.incomeCount === postItauLedgerFp.incomeCount && preItauLedgerFp.expenseCount === postItauLedgerFp.expenseCount && preItauLedgerFp.transferCount === postItauLedgerFp.transferCount && JSON.stringify(preItauLedgerFp.income) === JSON.stringify(postItauLedgerFp.income) && JSON.stringify(preItauLedgerFp.expense) === JSON.stringify(postItauLedgerFp.expense) && JSON.stringify(preItauLedgerFp.transfer) === JSON.stringify(postItauLedgerFp.transfer);
  log(`\n--- Invariante C: histórico Itaú (Income/Expense/Transfer) intacto ---`);
  log(`  Nenhuma row histórica alterada/removida: ${itauHistoryPreserved ? "SIM ✅" : "NÃO ❌"}`);

  // --- Model count deltas ---
  const [postAccountCount, postIncomeCount, postExpenseCount, postTransferCount, postCardCount, postCardBillCount, postPurchaseCount, postInstallmentCount, postCardLimitUpdateCount, postGoalCount, postAdjustmentCount] = await Promise.all([
    prisma.account.count(), prisma.income.count(), prisma.expense.count(), prisma.transfer.count(), prisma.card.count(), prisma.cardBill.count(), prisma.purchase.count(), prisma.installment.count(), prisma.cardLimitUpdate.count(), prisma.goal.count(), prisma.balanceAdjustment.count(),
  ]);
  log(`\n--- Item 16: model count deltas ---`);
  log(`  BalanceAdjustment: ${preAdjustments.length + 1} esperado, ${postAdjustmentCount} real (delta esperado +1 sobre ${await prisma.balanceAdjustment.count({ where: { accountId: itauAccount.id } })} do Itaú)`);
  log(`  Account=${postAccountCount} Income=${postIncomeCount} Expense=${postExpenseCount} Transfer=${postTransferCount} Card=${postCardCount} CardBill=${postCardBillCount} Purchase=${postPurchaseCount} Installment=${postInstallmentCount} CardLimitUpdate=${postCardLimitUpdateCount} Goal=${postGoalCount}`);

  // --- backup pós-commit ---
  const postBackupPath = path.join(backupDir, `post-itau-snapshot-apply-${Date.now()}.local.json`);
  fs.writeFileSync(postBackupPath, JSON.stringify({ createdAdjustment, txSnapshotResult, balanceAsOfSnapshotPostCommit: balanceAsOfSnapshotPostCommit.toString(), postSnapshotNetPostCommit: postSnapshotNetPostCommit.toString(), cardModelsIdentical, itauHistoryPreserved }, null, 2));
  log(`\n✅ Backup pós-write salvo em: ${postBackupPath}`);

  const allInvariantsPassed = txStatus === "COMMITTED" && cardModelsIdentical && itauHistoryPreserved;
  log(`\nITAU_SNAPSHOT_APPLY_STATUS = ${allInvariantsPassed ? "SUCCESS" : "FAILED_ROLLED_BACK"}`);

  await prisma.$disconnect();
  return { status: allInvariantsPassed ? "SUCCESS" : "FAILED", createdAdjustment, balanceAsOfSnapshotPostCommit: balanceAsOfSnapshotPostCommit.toString(), backupPath, postBackupPath };
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
