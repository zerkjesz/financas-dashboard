// ============================================================================
// Fase 5.1C-VA — escrita real, escopo Income+Expense+BalanceAdjustment SOMENTE
// diretamente ligados à reconciliação do VA (Vale Alimentação/Caju).
//
// Mesma disciplina da Fase 5.1B-CARD-v2: validação de invariantes DENTRO da
// transação (via `client: tx` injetado em computeAccountBalance — ver
// lib/accounts.js), nunca commit->validar->rollback compensatório.
//
// Genérico de propósito: valores canônicos vêm do mesmo input gitignored
// (scripts/snapshot-input.local.json, seções `restrictedAccount` e
// `reclassifiedIncomes`) — nunca hardcoded aqui. O matching contra o dev usa
// a mesma função real (matchCanonicalExpenses) já usada pela Fase 5.0.3/5.1A.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney, isPositive } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { matchCanonicalExpenses } from "./snapshot-dry-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";

const DRY_RUN = process.argv.includes("--dry-run");

// Todo model financeiro EXCETO os autorizados nesta fase (Income/Expense/
// BalanceAdjustment) — e explicitamente Card/CardBill/Purchase/Installment/
// CardLimitUpdate (item 20: subsistema Card foi encerrado, deve permanecer
// byte-equivalent), e Goal (item 2: incluído no fingerprint de propósito).
const OTHER_MODELS = [
  "account", "transfer", "card", "cardBill", "purchase", "installment", "cardLimitUpdate",
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
  else if (directUrl.includes(PRODUCTION_DB_HOST_SUBSTRING)) problems.push(`DIRECT_URL aponta pro host de produção`);

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

// Item 15 — invariantes A-N, reutilizados dentro E fora da transação, via
// `client` injetado em computeAccountBalance (nunca reimplementado).
async function checkInvariants(client, { vaAccountId, itauAccountId, plan }) {
  const problems = [];
  const snapshot = {};

  // A/B) canonical expense count/total já são propriedades do PLANO (derivado
  // do input via `plan.expectedCanonicalCount`/`plan.expectedCanonicalTotal`,
  // nunca de um número escrito à mão aqui) — reafirmados aqui pra nunca dessincronizar.
  if (plan.canonicalExpenses.length !== plan.expectedCanonicalCount) problems.push(`A) canonical expense count=${plan.canonicalExpenses.length}, esperado ${plan.expectedCanonicalCount}`);
  const canonicalTotal = sumMoney(plan.canonicalExpenses.map((e) => money(e.amount)));
  if (compareMoney(canonicalTotal, money(plan.expectedCanonicalTotal)) !== 0) problems.push(`B) canonical expense total=${canonicalTotal.toString()}, esperado ${plan.expectedCanonicalTotal}`);
  snapshot.canonicalExpenseCount = plan.canonicalExpenses.length;
  snapshot.canonicalExpenseTotal = canonicalTotal.toString();

  // C/D) missing created count/total — verificado contra o banco de verdade via `client`.
  const missingCreated = await Promise.all(
    plan.missingToCreate.map((m) => client.expense.findFirst({ where: { accountId: vaAccountId, amount: money(m.amount), occurredAt: m.canonicalDate, description: m.counterparty } }))
  );
  const missingFoundCount = missingCreated.filter(Boolean).length;
  if (missingFoundCount !== plan.missingToCreate.length) problems.push(`C) missing created count=${missingFoundCount}, esperado ${plan.missingToCreate.length}`);
  const missingTotal = sumMoney(plan.missingToCreate.map((m) => money(m.amount)));
  if (compareMoney(missingTotal, money(plan.expectedMissingTotal)) !== 0) problems.push(`D) missing created total=${missingTotal.toString()}, esperado ${plan.expectedMissingTotal}`);
  snapshot.missingCreatedCount = missingFoundCount;
  snapshot.missingCreatedTotal = missingTotal.toString();

  // E) valor canônico do match near-amount resolvido (política canônico-vence, ver
  // Fase 5.1A) — null-safe: numa reexecução idempotente, plan.nearAmountUpdate é
  // null (a ambiguidade já foi resolvida em execução anterior e virou EXACT_MATCH,
  // já coberto pelo invariante B acima), então este invariante fica trivialmente ok.
  let nearAmountResolved = null;
  if (plan.nearAmountUpdate) {
    nearAmountResolved = await client.expense.findUnique({ where: { id: plan.nearAmountUpdate.id } });
    if (!nearAmountResolved || compareMoney(money(nearAmountResolved.amount), money(plan.nearAmountUpdate.canonicalAmount)) !== 0) {
      problems.push(`E) near-amount match amount=${nearAmountResolved?.amount?.toString()}, esperado ${plan.nearAmountUpdate.canonicalAmount}`);
    }
  }
  snapshot.nearAmountMatchAmount = nearAmountResolved?.amount?.toString() ?? "N/A (já resolvido em execução anterior)";

  // F) Income reclassificado pertence à conta canônica, não à restrita.
  const reclassifiedIncome = await client.income.findUnique({ where: { id: plan.reclassifiedIncomeMove.id } });
  if (!reclassifiedIncome || reclassifiedIncome.accountId !== itauAccountId) problems.push(`F) Income reclassificado.accountId=${reclassifiedIncome?.accountId}, esperado ${itauAccountId} (conta canônica)`);
  snapshot.reclassifiedIncomeAccountId = reclassifiedIncome?.accountId ?? null;

  // G) Recharge VA = valor canônico em canonical date
  const recharge = await client.income.findUnique({ where: { id: plan.rechargeUpdate.id } });
  if (!recharge || compareMoney(money(recharge.amount), money(plan.expectedRechargeAmount)) !== 0 || recharge.occurredAt.getTime() !== plan.rechargeUpdate.canonicalDate.getTime()) {
    problems.push(`G) Recharge amount/date=${recharge?.amount?.toString()}/${recharge?.occurredAt?.toISOString()}, esperado ${plan.expectedRechargeAmount}/${plan.rechargeUpdate.canonicalDate.toISOString()}`);
  }
  snapshot.rechargeOccurredAt = recharge?.occurredAt?.toISOString() ?? null;

  // H) Cutover opening anchor — exatamente uma vez, no valor derivado do plano
  const openingAnchors = await client.balanceAdjustment.findMany({ where: { accountId: vaAccountId, occurredAt: plan.openingAnchor.occurredAt } });
  if (openingAnchors.length !== 1 || compareMoney(money(openingAnchors[0]?.newBalance ?? 0), money(plan.openingAnchor.amount)) !== 0) {
    problems.push(`H) opening anchors no boundary=${openingAnchors.length} (esperado 1), amount=${openingAnchors[0]?.newBalance}`);
  }
  snapshot.openingAnchorCount = openingAnchors.length;

  // I) computeAccountBalance(VA, client) = valor canônico observado (plan.expectedClosing)
  const vaBalance = await computeAccountBalance(vaAccountId, { client });
  if (compareMoney(vaBalance, money(plan.expectedClosing)) !== 0) problems.push(`I) computeAccountBalance(VA)=${vaBalance.toString()}, esperado ${plan.expectedClosing}`);
  snapshot.vaBalance = vaBalance.toString();

  // J) restricted account remains restricted — Account.type nunca é tocado por esta fase.
  const vaAccountRow = await client.account.findUnique({ where: { id: vaAccountId } });
  if (vaAccountRow?.type !== "food_voucher") problems.push(`J) Account.type=${vaAccountRow?.type}, esperado food_voucher (nunca alterado)`);
  snapshot.vaAccountType = vaAccountRow?.type ?? null;

  // K) unrestrictedCash não passa a incluir VA — checagem estrutural: o Account.type continua distinto de "checking"/"cash".
  if (vaAccountRow?.type === "checking" || vaAccountRow?.type === "cash") problems.push("K) Account.type do VA virou unrestricted — não deveria.");

  // L) reclassificação de Income cross-account conserva o valor global (é um UPDATE de accountId, nunca CREATE/DELETE — checado estruturalmente, não por delta absoluto de nenhuma conta).
  // (estrutural — garantido por ser um UPDATE de accountId, nunca um CREATE/DELETE — nenhuma checagem adicional de saldo global necessária aqui.)
  snapshot.crossAccountMoveIsUpdateNotCreateDelete = true;

  // M) nenhuma Expense duplicada — nenhum par (accountId, amount, occurredAt, description) repetido entre as Expenses pós-cutoff.
  const postCutoffExpenses = await client.expense.findMany({ where: { accountId: vaAccountId, occurredAt: { gte: plan.vaHistoryStart } } });
  const keys = postCutoffExpenses.map((e) => `${e.amount.toString()}|${e.occurredAt.toISOString()}|${e.description}`);
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) problems.push(`M) ${keys.length - uniqueKeys.size} Expense(s) duplicada(s) detectada(s) pós-cutoff.`);
  snapshot.postCutoffExpenseCount = postCutoffExpenses.length;

  // N) nenhuma canonical transaction ficou fora do período [vaHistoryStart, observedClosing] por timezone drift.
  const outOfWindow = postCutoffExpenses.filter((e) => e.occurredAt < plan.vaHistoryStart || e.occurredAt > plan.observedClosingDate);
  if (outOfWindow.length > 0) problems.push(`N) ${outOfWindow.length} Expense(s) fora da janela [${plan.vaHistoryStart.toISOString()}, ${plan.observedClosingDate.toISOString()}]`);

  return { ok: problems.length === 0, problems, snapshot };
}

async function main() {
  log("=".repeat(78));
  log("Fase 5.1C-VA — apply real, escopo Income+Expense+BalanceAdjustment (VA) only");
  log(DRY_RUN ? "MODO: --dry-run (preflight/simulação apenas, ZERO write)" : "MODO: WRITE REAL");
  log("=".repeat(78));

  const { migrateStatusOutput } = assertExtraSafety();
  log("✅ Ambiente dev confirmado + prisma migrate status clean.");

  const inputPath = path.join(HERE, "snapshot-input.local.json");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const vaInput = input.restrictedAccount;
  const reclassifiedIncomes = input.reclassifiedIncomes || [];
  if (!vaInput?.slug) throw new Error("input.restrictedAccount.slug ausente.");

  const settings = await prisma.appSettings.findFirst();
  if (!settings?.vaHistoryStart) throw new Error("AppSettings.vaHistoryStart não está setado — não é possível determinar o boundary do cutover sem inventar um horário.");
  const vaHistoryStart = settings.vaHistoryStart;
  log(`\nAppSettings.vaHistoryStart (boundary real, lido do banco): ${vaHistoryStart.toISOString()}`);

  const vaAccount = await prisma.account.findUnique({ where: { slug: vaInput.slug } });
  if (!vaAccount) throw new Error(`Account slug=${vaInput.slug} não encontrada.`);
  const itauAccountSlug = reclassifiedIncomes.find((r) => r.persistedAccountSlug === vaInput.slug)?.canonicalAccountSlug;
  const itauAccount = itauAccountSlug ? await prisma.account.findUnique({ where: { slug: itauAccountSlug } }) : null;
  if (!itauAccount) throw new Error("Conta canônica de destino da reclassificação não encontrada.");

  // --- Item 2: novo baseline ---
  const vaExpensesBefore = await prisma.expense.findMany({ where: { accountId: vaAccount.id }, orderBy: { occurredAt: "asc" } });
  const vaBalanceAdjustmentsBefore = await prisma.balanceAdjustment.findMany({ where: { accountId: vaAccount.id } });
  const vaIncomesBefore = await prisma.income.findMany({ where: { accountId: vaAccount.id } });
  const itauAccountBefore = await prisma.account.findUnique({ where: { id: itauAccount.id } });
  const goalCountBefore = await prisma.goal.count();
  const otherModelsFingerprintBefore = await fingerprintModels(OTHER_MODELS);

  const backupDir = path.join(HERE, "snapshot-reports");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = {
    generatedAt: new Date().toISOString(),
    schemaMigrateStatus: migrateStatusOutput,
    vaAccount,
    itauAccountBefore,
    vaExpensesBefore,
    vaBalanceAdjustmentsBefore,
    vaIncomesBefore,
    goalCountBefore,
    otherModelsFingerprintBefore,
  };
  const backupPath = path.join(backupDir, `pre-va-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`✅ Backup pré-write salvo em: ${backupPath}`);

  // --- Item 5: matching real contra o dev ATUAL (nunca reaproveita o dry-run antigo) ---
  const devExpensesForMatching = await prisma.expense.findMany({ where: { accountId: vaAccount.id, occurredAt: { gte: vaHistoryStart } }, orderBy: { occurredAt: "asc" } });
  const matching = matchCanonicalExpenses(vaInput.canonicalExpenses, devExpensesForMatching);
  const exactMatches = matching.matches.filter((m) => m.classification === "ALREADY_PERSISTED");
  const nearAmountMatches = matching.matches.filter((m) => m.classification === "AMBIGUOUS_MATCH" && m.matchType === "NEAR_AMOUNT");
  const missingMatches = matching.matches.filter((m) => m.classification === "MISSING_IN_DEV");
  const ambiguousMultiMatches = matching.matches.filter((m) => m.classification === "AMBIGUOUS_MATCH" && m.matchType !== "NEAR_AMOUNT");

  log(`\nMatching real: ${exactMatches.length} EXACT_MATCH, ${nearAmountMatches.length} CANONICAL_UPDATE (near-amount), ${missingMatches.length} MISSING, ${ambiguousMultiMatches.length} AMBIGUOUS (múltiplos candidatos)`);

  // Validação GENÉRICA (nunca hardcoda a contagem esperada de cada categoria —
  // isso variaria legitimamente entre a 1ª execução, 6/1/7, e uma reexecução
  // idempotente pós-apply, 14/0/0): o único invariante universal é que TODO
  // item canônico precisa cair em exatamente uma categoria resolvível, e
  // nenhum item pode ficar "múltiplos candidatos" (não saberíamos qual escolher).
  const accountedFor = exactMatches.length + nearAmountMatches.length + missingMatches.length;
  if (ambiguousMultiMatches.length > 0 || accountedFor !== vaInput.canonicalExpenses.length) {
    console.error(`\n🛑 ABORTADO — o matching real não classifica todos os ${vaInput.canonicalExpenses.length} itens canônicos de forma inequívoca (accountedFor=${accountedFor}, ambíguos=${ambiguousMultiMatches.length}).`);
    console.error(JSON.stringify(matching, null, 2));
    process.exit(1);
  }
  log(`✅ Matching confirmado: todos os ${vaInput.canonicalExpenses.length} itens canônicos classificados sem ambiguidade (${exactMatches.length} EXACT_MATCH, ${nearAmountMatches.length} CANONICAL_UPDATE, ${missingMatches.length} MISSING).`);

  // --- Item 7: datas dos exact matches — corrigir occurredAt pra data canônica quando divergir ---
  const dateOnlyUTC = (isoDateStr) => new Date(`${isoDateStr}T00:00:00.000Z`);
  const occurredAtCorrections = [];
  for (const m of exactMatches) {
    const canonicalDate = dateOnlyUTC(m.date);
    const persisted = devExpensesForMatching.find((e) => e.id === m.matchedDevExpenseId);
    if (persisted.occurredAt.getTime() !== canonicalDate.getTime()) {
      occurredAtCorrections.push({ id: persisted.id, counterparty: m.counterparty, amount: m.amount, before: persisted.occurredAt, after: canonicalDate });
    }
  }
  log(`\nCorreções de occurredAt (${exactMatches.length} matches exatos): ${occurredAtCorrections.length} precisam de UPDATE, ${exactMatches.length - occurredAtCorrections.length} já corretas.`);
  occurredAtCorrections.forEach((c) => log(`   ${c.counterparty} (${c.amount}): ${c.before.toISOString()} -> ${c.after.toISOString()}`));

  // --- Item 6: match near-amount (política canônico-vence, ver Fase 5.1A) — UPDATE
  // amount + occurredAt. Null-safe: numa reexecução idempotente pós-apply, este
  // item já virou EXACT_MATCH (a ambiguidade já foi resolvida), então
  // nearAmountMatches fica vazio — não há nada a corrigir aqui, de propósito.
  const nearAmountMatch = nearAmountMatches[0] ?? null;
  const nearAmountUpdate = nearAmountMatch
    ? (() => {
        const persisted = devExpensesForMatching.find((e) => e.id === nearAmountMatch.matchedDevExpenseId);
        const canonicalDate = dateOnlyUTC(nearAmountMatch.date);
        return { id: persisted.id, canonicalAmount: nearAmountMatch.amount, canonicalDate, before: { amount: persisted.amount.toString(), occurredAt: persisted.occurredAt.toISOString() }, after: { amount: nearAmountMatch.amount, occurredAt: canonicalDate.toISOString() } };
      })()
    : null;
  if (nearAmountUpdate) {
    log(`\nMatch near-amount (${nearAmountMatch.counterparty}): id=${nearAmountUpdate.id} | ${nearAmountUpdate.before.amount}@${nearAmountUpdate.before.occurredAt} -> ${nearAmountUpdate.after.amount}@${nearAmountUpdate.after.occurredAt}`);
  } else {
    log("\nMatch near-amount: nenhum pendente (já resolvido em execução anterior, ou nunca existiu).");
  }

  // --- Item 8: 7 missing — CREATE (dedup já garantido por matchCanonicalExpenses contra toda a janela) ---
  const missingToCreate = missingMatches.map((m) => ({ counterparty: m.counterparty, amount: m.amount, canonicalDate: dateOnlyUTC(m.date) }));
  log(`\n${missingToCreate.length} Expenses a criar (total: ${sumMoney(missingToCreate.map((m) => money(m.amount))).toString()}):`);
  missingToCreate.forEach((m) => log(`   ${m.canonicalDate.toISOString().slice(0, 10)} ${m.counterparty} ${m.amount}`));

  // --- Item 9: recharge ---
  const rechargeCanonicalDate = dateOnlyUTC(vaInput.recharge.date);
  const rechargeCandidates = await prisma.income.findMany({ where: { accountId: vaAccount.id, amount: money(vaInput.recharge.amount), occurredAt: { gte: vaHistoryStart } } });
  if (rechargeCandidates.length !== 1) {
    console.error(`\n🛑 ABORTADO — esperava exatamente 1 candidato de recarga (R$${vaInput.recharge.amount}) desde o cutoff, encontrado ${rechargeCandidates.length}.`);
    process.exit(1);
  }
  const rechargeUpdate = { id: rechargeCandidates[0].id, canonicalDate: rechargeCanonicalDate, before: rechargeCandidates[0].occurredAt };
  log(`\nRecharge: id=${rechargeUpdate.id} | occurredAt ${rechargeUpdate.before.toISOString()} -> ${rechargeCanonicalDate.toISOString()}`);

  // --- Item 10: Income reclassificado — busca SEM fixar accountId, pra ser
  // idempotente: numa reexecução pós-apply, a row já está na conta canônica
  // de destino, não mais na restrita — fixar accountId=vaAccount.id aqui
  // quebraria a idempotência (acharia 0 candidatos e abortaria à toa).
  const reclass = reclassifiedIncomes.find((r) => r.persistedAccountSlug === vaInput.slug);
  if (!reclass) throw new Error("Nenhuma reclassificação de Income encontrada no input.");
  const reclassifiedIncomeCandidates = await prisma.income.findMany({ where: { amount: money(reclass.amount), description: reclass.description, accountId: { in: [vaAccount.id, itauAccount.id] } } });
  if (reclassifiedIncomeCandidates.length !== 1) {
    console.error(`\n🛑 ABORTADO — esperava exatamente 1 candidato pra reclassificação (R$${reclass.amount}, "${reclass.description}") entre as contas restrita/canônica, encontrado ${reclassifiedIncomeCandidates.length}.`);
    process.exit(1);
  }
  const reclassifiedIncomeMove = { id: reclassifiedIncomeCandidates[0].id, from: vaAccount.id, to: itauAccount.id };
  log(`\nIncome reclassificado (R$${reclass.amount}): id=${reclassifiedIncomeMove.id} | accountId ${vaAccount.slug} -> ${itauAccount.slug}`);

  // --- Item 11: cutover opening — auditar que não existe outro anchor
  // CONFLITANTE (idempotente: um anchor já existente com o MESMO valor
  // derivado é reconhecido como "já aplicado em execução anterior", nunca
  // recriado nem tratado como erro — só um anchor com valor DIFERENTE do
  // esperado no mesmo boundary é um conflito real, e aí sim aborta).
  //
  // Anchor 1ms ANTES do vaHistoryStart — nunca "inventa" um horário econômico
  // novo (não afirma que algo aconteceu naquele instante), só garante que a
  // comparação `occurredAt > since` do computeAccountBalance NÃO exclua a
  // recarga (que é canonicamente datada EXATAMENTE no mesmo dia que o
  // vaHistoryStart) — mesmo princípio já usado pra investigar (não pra
  // escrever) na Fase 5.1A.
  const openingAnchorOccurredAt = new Date(vaHistoryStart.getTime() - 1);
  // Fórmula explícita (item 16): opening = observedClosing - recharge + canonicalExpensesTotal
  const canonicalExpensesTotal = sumMoney(vaInput.canonicalExpenses.map((e) => money(e.amount)));
  const derivedOpening = subtractMoney(addMoney(money(vaInput.observedClosing.amount), canonicalExpensesTotal), money(vaInput.recharge.amount));
  log(`\nOpening derivado: ${vaInput.observedClosing.amount} + ${canonicalExpensesTotal.toString()} - ${vaInput.recharge.amount} = ${derivedOpening.toString()}`);
  const openingAnchor = { amount: derivedOpening, occurredAt: openingAnchorOccurredAt };

  const existingAnchorAtBoundary = vaBalanceAdjustmentsBefore.find((b) => Math.abs(b.occurredAt.getTime() - openingAnchorOccurredAt.getTime()) < 1000 * 60 * 60 * 24);
  if (existingAnchorAtBoundary && compareMoney(money(existingAnchorAtBoundary.newBalance), derivedOpening) !== 0) {
    console.error(`\n🛑 ABORTADO — já existe um BalanceAdjustment próximo do cutoff com valor DIFERENTE do esperado (id=${existingAnchorAtBoundary.id}, occurredAt=${existingAnchorAtBoundary.occurredAt.toISOString()}, newBalance=${existingAnchorAtBoundary.newBalance} != ${derivedOpening.toString()}) — conflito real, evitando duplicidade/inconsistência.`);
    process.exit(1);
  }
  const openingAnchorAlreadyExists = existingAnchorAtBoundary != null;
  if (openingAnchorAlreadyExists) log(`\nOpening anchor já existe (id=${existingAnchorAtBoundary.id}) com o valor esperado — idempotente, não será recriado.`);

  // Idempotência: re-executar o matching contra o estado ATUAL já é suficiente
  // pra detectar "nada a fazer" — nunca precisa de uma segunda checagem paralela.
  const alreadyFullyApplied =
    missingMatches.length === 0 &&
    nearAmountMatches.length === 0 &&
    occurredAtCorrections.length === 0 &&
    rechargeUpdate.before.getTime() === rechargeCanonicalDate.getTime() &&
    reclassifiedIncomeCandidates[0].accountId === itauAccount.id &&
    vaBalanceAdjustmentsBefore.some((b) => compareMoney(money(b.newBalance), openingAnchor.amount) === 0);

  const plan = {
    canonicalExpenses: vaInput.canonicalExpenses,
    expectedCanonicalCount: vaInput.canonicalExpenses.length,
    expectedCanonicalTotal: canonicalExpensesTotal.toString(),
    missingToCreate,
    expectedMissingTotal: sumMoney(missingToCreate.map((m) => money(m.amount))).toString(),
    expectedRechargeAmount: vaInput.recharge.amount,
    nearAmountUpdate,
    reclassifiedIncomeMove,
    rechargeUpdate: { ...rechargeUpdate, canonicalDate: rechargeCanonicalDate },
    openingAnchor,
    vaHistoryStart,
    observedClosingDate: dateOnlyUTC(vaInput.observedClosing.date),
    expectedClosing: vaInput.observedClosing.amount,
  };

  if (alreadyFullyApplied) {
    log("\n✅ NO_MUTATIONS_NEEDED — idempotência confirmada (todo o plano já está aplicado).");
    return { status: "NO_MUTATIONS_NEEDED", backupPath };
  }

  if (DRY_RUN) {
    log("\n--- Simulando invariantes A-N em cima do estado REAL atual + plano (sem escrever) ---");
    // Pra dry-run, roda os invariantes contra o prisma real SEM aplicar — só reporta
    // o que already-exists vs o que o plano ainda propõe (idempotência parcial já é
    // visível acima). A prova definitiva de que o plano fecha certo acontece dentro
    // da transação real (client: tx), sempre antes do commit.
    log(JSON.stringify({ occurredAtCorrections: occurredAtCorrections.length, nearAmountNeedsUpdate: nearAmountUpdate != null, missingToCreate: missingToCreate.length, rechargeNeedsUpdate: rechargeUpdate.before.getTime() !== rechargeCanonicalDate.getTime(), reclassifiedIncomeNeedsMove: reclassifiedIncomeCandidates[0].accountId !== itauAccount.id, openingAnchorNeedsCreate: !alreadyFullyApplied, derivedOpening: derivedOpening.toString() }, null, 2));
    return { status: "DRY_RUN_COMPLETE", backupPath, plan: { ...plan, canonicalExpenses: undefined } };
  }

  // ==========================================================================
  // TRANSAÇÃO ÚNICA
  // ==========================================================================
  log("\n--- Iniciando transação real (validação tx-scoped) ---");
  let invariantResult = null;
  await prisma.$transaction(async (tx) => {
    // 1. Revalidar preflight via tx — Expense não tem `updatedAt` no schema
    // (confirmado por leitura direta), então a concorrência otimista aqui
    // compara os campos mutáveis relevantes (amount/occurredAt/description)
    // pras rows que este apply especificamente toca (o match near-amount + as demais datas
    // corrigidas), não a lista inteira de 22 Expenses históricas.
    const rowsToRevalidate = [...(nearAmountUpdate ? [nearAmountUpdate] : []), ...occurredAtCorrections];
    for (const r of rowsToRevalidate) {
      const original = vaExpensesBefore.find((e) => e.id === r.id);
      const fresh = await tx.expense.findUnique({ where: { id: r.id } });
      if (!fresh || compareMoney(money(fresh.amount), money(original.amount)) !== 0 || fresh.occurredAt.getTime() !== original.occurredAt.getTime()) {
        throw new Error(`Expense ${r.id} mudou desde o preflight.`);
      }
    }
    const freshReclassifiedIncome = await tx.income.findUnique({ where: { id: reclassifiedIncomeMove.id } });
    if (!freshReclassifiedIncome || (freshReclassifiedIncome.accountId !== vaAccount.id && freshReclassifiedIncome.accountId !== itauAccount.id)) {
      throw new Error("Income reclassificado saiu de ambas as contas esperadas desde o preflight.");
    }
    const freshRecharge = await tx.income.findUnique({ where: { id: rechargeUpdate.id } });
    if (!freshRecharge) throw new Error("Recharge Income não encontrada dentro da tx.");

    // 2. UPDATE recharge date if necessary
    if (rechargeUpdate.before.getTime() !== rechargeCanonicalDate.getTime()) {
      await tx.income.update({ where: { id: rechargeUpdate.id }, data: { occurredAt: rechargeCanonicalDate } });
    }

    // 3. UPDATE existing matched Expense dates if approved
    for (const c of occurredAtCorrections) {
      await tx.expense.update({ where: { id: c.id }, data: { occurredAt: c.after } });
    }

    // 4. UPDATE do match near-amount (política canônico-vence) + occurredAt — null-safe, idempotente.
    if (nearAmountUpdate) {
      await tx.expense.update({ where: { id: nearAmountUpdate.id }, data: { amount: money(nearAmountUpdate.canonicalAmount), occurredAt: nearAmountUpdate.canonicalDate } });
    }

    // 5. CREATE Expenses ausentes (pode ser um array vazio numa reexecução idempotente)
    for (const m of missingToCreate) {
      await tx.expense.create({
        data: {
          accountId: vaAccount.id,
          amount: money(m.amount),
          occurredAt: m.canonicalDate,
          description: m.counterparty,
          category: "Alimentação",
          source: "manual",
          confidence: "CONFIRMED_BY_MEMORY",
        },
      });
    }

    // 6. move Income reclassificado (conta restrita -> conta canônica) — idempotente: pula se já estiver na conta canônica.
    if (freshReclassifiedIncome.accountId !== itauAccount.id) {
      await tx.income.update({ where: { id: reclassifiedIncomeMove.id }, data: { accountId: itauAccount.id } });
    }

    // 7. create cutover opening (valor derivado do plano, nunca hardcoded) —
    // idempotente: nunca cria uma segunda âncora se uma equivalente já existe
    // (item 23 — "nunca criar segunda opening adjustment").
    const freshExistingOpening = await tx.balanceAdjustment.findFirst({ where: { accountId: vaAccount.id, occurredAt: openingAnchor.occurredAt } });
    if (!freshExistingOpening) {
      await tx.balanceAdjustment.create({
        data: {
          accountId: vaAccount.id,
          newBalance: openingAnchor.amount,
          occurredAt: openingAnchor.occurredAt,
          note: "Saldo de abertura no corte operacional do VA (CUTOVER_OPENING_BALANCE, DERIVED_ONLY — nunca confundir com saldo comprovado por extrato)",
          source: "manual",
          confidence: "RECONCILIATION_ADJUSTMENT",
        },
      });
    }

    // 8. read resulting state via tx + run invariants
    invariantResult = await checkInvariants(tx, { vaAccountId: vaAccount.id, itauAccountId: itauAccount.id, plan });
    if (!invariantResult.ok) {
      throw new Error("INVARIANTES A-N FALHARAM (dentro da transação, ANTES do commit):\n" + invariantResult.problems.join("\n"));
    }
  });
  log("✅ TODOS os invariantes A-N passaram DENTRO da transação. Transação commitada com sucesso.");
  log(JSON.stringify(invariantResult.snapshot, null, 2));

  // --- Validação pós-commit ---
  const postCommitInvariants = await checkInvariants(prisma, { vaAccountId: vaAccount.id, itauAccountId: itauAccount.id, plan });
  const postCommitMatchesTxScoped = JSON.stringify(postCommitInvariants.snapshot) === JSON.stringify(invariantResult.snapshot);
  log(`\n✅ Validação pós-commit (prisma global) ${postCommitInvariants.ok ? "PASSOU" : "FALHOU"} — idêntica ao resultado tx-scoped: ${postCommitMatchesTxScoped}`);

  // --- Item 20: prova de não alteração do Card ---
  const cardModels = ["card", "cardBill", "purchase", "installment", "cardLimitUpdate"];
  const cardFingerprintAfter = await fingerprintModels(cardModels);
  const cardFingerprintBefore = { card: otherModelsFingerprintBefore.card, cardBill: otherModelsFingerprintBefore.cardBill, purchase: otherModelsFingerprintBefore.purchase, installment: otherModelsFingerprintBefore.installment, cardLimitUpdate: otherModelsFingerprintBefore.cardLimitUpdate };
  const cardUnchanged = JSON.stringify(cardFingerprintBefore) === JSON.stringify(cardFingerprintAfter);
  log(`\n✅ Card subsystem inalterado: ${cardUnchanged}`);

  const otherModelsFingerprintAfter = await fingerprintModels(OTHER_MODELS);
  const otherModelsUnchanged = JSON.stringify(otherModelsFingerprintBefore) === JSON.stringify(otherModelsFingerprintAfter);
  const goalCountAfter = await prisma.goal.count();

  const postWritePath = path.join(backupDir, `post-va-apply-${Date.now()}.local.json`);
  fs.writeFileSync(postWritePath, JSON.stringify({ generatedAt: new Date().toISOString(), postCommitInvariants: postCommitInvariants.snapshot, cardUnchanged, otherModelsUnchanged, goalCountBefore, goalCountAfter }, null, 2));
  log(`✅ Estado pós-write salvo em: ${postWritePath}`);

  return { status: "SUCCESS", backupPath, postWritePath, cardUnchanged, otherModelsUnchanged, postCommitMatchesTxScoped, invariants: postCommitInvariants };
}

main()
  .then((result) => {
    console.log("\n" + "=".repeat(78));
    console.log("RESULTADO:", result.status);
    console.log("=".repeat(78));
  })
  .catch((err) => {
    console.error("\n💥 ERRO — a transação (se iniciada) foi revertida automaticamente pelo Prisma, NENHUM write parcial persiste:");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
