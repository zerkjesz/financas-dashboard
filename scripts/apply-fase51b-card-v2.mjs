// ============================================================================
// Fase 5.1B-CARD-v2 — segunda tentativa de escrita real, escopo Card+CardBill+
// Purchase+Installment+CardLimitUpdate SOMENTE. Resolve os dois blockers
// achados pela v1 (768dea5): realinhamento do Installment ANTES do DELETE da
// CardBill legada, e uma nova observação de CardLimitUpdate pro used-limit.
//
// Diferença estrutural da v1: a validação crítica agora acontece DENTRO da
// transação (via `client: tx` injetado nas funções reais de produção — ver
// lib/cardBillCalculator.js/lib/cards.js), nunca commit->validar->rollback
// compensatório. Só commita se TODOS os invariantes A-L passarem.
//
// Genérico de propósito: valores canônicos vêm do mesmo input gitignored da
// Fase 5.1A/5.1B-CARD (scripts/snapshot-input.local.json, seção `card`); o
// realinhamento do Installment é derivado por execução real de
// getCardCycleForDate, nunca por ids/meses escritos à mão.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney, isPositive } from "../lib/money.js";
import { addMonthKey } from "../lib/formatMoney.js";
import { getCardBillClosesAt, getCardBillDueDate, getCardCycleForDate } from "../lib/cardCycle.js";
import { listCardBillsView, computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { resolveCurrentRelevantCardBillCycleMonth } from "../lib/freeMoney.js";
import { classifyCardBill, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeCardUsedLimit, computeCardAvailableLimit, computeCardTotalLimit } from "../lib/cards.js";
import {
  classifyPersistedCardBills,
  buildCardBillManifestById,
  investigateLegacyCardBillArtifact,
  confirmCardBillUniqueConstraint,
} from "./snapshot-dry-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler";
const ASOF = new Date("2026-09-04T00:00:00.000Z");
// Item 3 — CUTOVER SNAPSHOT RULE: quando uma observação bancária só tem
// evidência de DATA (não de horário), a âncora usa o FIM do dia (23:59:59.999
// UTC) — trata TODA a atividade daquele dia como já incorporada na
// observação, e a fórmula (`occurredAt > since`) só soma atividade
// ESTRITAMENTE POSTERIOR. Verificado nesta mesma execução (antes de decidir)
// que não existe nenhuma Expense/Purchase/Transfer do cartão com occurredAt
// em 2026-09-04 — logo esta escolha de boundary é comprovadamente segura
// pra este caso específico, e é a convenção correta em geral.
const CUTOVER_SNAPSHOT_BOUNDARY = new Date("2026-09-04T23:59:59.999Z");

const DRY_RUN = process.argv.includes("--dry-run");

const OTHER_MODELS = [
  "account", "income", "expense", "transfer", "balanceAdjustment",
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
  else if (directUrl.includes(PRODUCTION_DB_HOST_SUBSTRING)) problems.push(`DIRECT_URL aponta pro host de produção (contém "${PRODUCTION_DB_HOST_SUBSTRING}")`);

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

function shapeBill(b) {
  return {
    id: b.id,
    cycleMonth: b.cycleMonth,
    totalAmount: b.totalAmount.toString(),
    paidAmount: b.paidAmount?.toString() ?? null,
    remainingAmount: subtractMoney(money(b.totalAmount), money(b.paidAmount ?? 0)).toString(),
    status: b.status,
    closesAt: b.closesAt.toISOString(),
    dueAt: b.dueAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

// Simula, EM MEMÓRIA (zero write), o efeito de aplicar o plano — usado só
// pelo --dry-run, pra rodar os MESMOS invariantes reais (checkInvariants)
// sem hardcodar nenhum valor esperado no código. Delega toda leitura não
// afetada pro `prisma` real; intercepta só os pontos que o plano mudaria.
function buildSimulatedClient({ cardId, purchaseId, canonicalFirstMonth, installmentUpdates, legacyCycleMonth, updateApprovals, metadataOnlyUpdates, desiredLimitUpdate, existingIdenticalLimitUpdate, cardInput }) {
  const billMonthOverride = new Map(installmentUpdates.map((u) => [u.id, u.after]));
  const cardBillUpdateById = new Map(updateApprovals.map((u) => [u.id, u]));
  const metadataUpdateById = new Map(metadataOnlyUpdates.map((u) => [u.id, u]));

  return {
    card: {
      findUnique: async (args) => {
        const real = await prisma.card.findUnique(args);
        return real && real.id === cardId ? { ...real, closingDay: cardInput.closingDay, dueDay: cardInput.dueDay } : real;
      },
    },
    purchase: {
      findUnique: async (args) => {
        const real = await prisma.purchase.findUnique(args);
        return real && real.id === purchaseId ? { ...real, firstInstallmentMonth: canonicalFirstMonth } : real;
      },
      aggregate: (args) => prisma.purchase.aggregate(args),
    },
    installment: {
      count: async (args) => {
        // Após o shift, nenhuma Installment desta Purchase tem billMonth=legacyCycleMonth.
        if (args?.where?.purchaseId === purchaseId && args?.where?.billMonth === legacyCycleMonth) return 0;
        return prisma.installment.count(args);
      },
      aggregate: async (args) => {
        const targetBillMonth = args?.where?.billMonth;
        if (targetBillMonth == null) return prisma.installment.aggregate(args);
        // Reconstrói a soma tratando o shift: uma Installment com billMonth ORIGINAL=X agora conta pro cycleMonth shiftado.
        const allForCard = await prisma.installment.findMany({ where: { purchase: args.where.purchase } });
        const shifted = allForCard.filter((i) => (billMonthOverride.get(i.id) ?? i.billMonth) === targetBillMonth);
        const sum = shifted.reduce((acc, i) => addMoney(acc, money(i.amount)), money(0));
        return { _sum: { amount: sum.isZero() && shifted.length === 0 ? null : sum } };
      },
    },
    cardBill: {
      findUnique: async (args) => {
        const cm = args?.where?.cardId_cycleMonth?.cycleMonth;
        if (cm === legacyCycleMonth) return null; // deletada
        const real = await prisma.cardBill.findUnique(args);
        if (!real) return real;
        if (cardBillUpdateById.has(real.id)) {
          const u = cardBillUpdateById.get(real.id);
          return { ...real, totalAmount: money(u.canonical.totalAmount), paidAmount: u.canonical.paidAmount != null ? money(u.canonical.paidAmount) : null, status: u.canonical.status, closesAt: getCardBillClosesAt(cardInput, real.cycleMonth), dueAt: getCardBillDueDate(cardInput, real.cycleMonth) };
        }
        if (metadataUpdateById.has(real.id)) {
          const u = metadataUpdateById.get(real.id);
          return { ...real, closesAt: u.closesAt, dueAt: u.dueAt };
        }
        return real;
      },
      findMany: (args) => prisma.cardBill.findMany(args),
    },
    expense: { aggregate: (args) => prisma.expense.aggregate(args) },
    transfer: { aggregate: (args) => prisma.transfer.aggregate(args) },
    cardLimitUpdate: {
      findFirst: async (args) => {
        if (existingIdenticalLimitUpdate) return prisma.cardLimitUpdate.findFirst(args);
        const real = await prisma.cardLimitUpdate.findFirst(args);
        // A nova âncora simulada é sempre a mais recente (occurredAt = boundary do snapshot).
        if (!args?.where?.newTotalLimit) {
          return { newUsedLimit: desiredLimitUpdate.newUsedLimit, occurredAt: desiredLimitUpdate.occurredAt, reportedAvailable: desiredLimitUpdate.reportedAvailable };
        }
        return real; // newTotalLimit não muda nesta fase
      },
    },
  };
}

// Item 20 — os 12 invariantes (A-L), reutilizados dentro E fora da
// transação, usando SEMPRE as funções REAIS de produção via `client`
// injetado (nunca reimplementadas).
async function checkInvariants(client, { cardId, purchaseId, canonicalBills, cardInput }) {
  const problems = [];

  // A) nenhuma installment da Purchase com billMonth=2026-08 (genérico: o
  // cycleMonth legado que foi deletado) — deriva do próprio input, nunca hardcoded.
  const legacyCycleMonth = canonicalBills.legacyCycleMonth;
  const installmentsStillLegacy = await client.installment.count({ where: { purchaseId, billMonth: legacyCycleMonth } });
  if (installmentsStillLegacy > 0) problems.push(`A) ${installmentsStillLegacy} Installment(s) ainda com billMonth=${legacyCycleMonth}`);

  // B) Purchase.firstInstallmentMonth aponta pro ciclo canônico
  const purchase = await client.purchase.findUnique({ where: { id: purchaseId } });
  if (purchase.firstInstallmentMonth !== canonicalBills.canonicalFirstMonth) problems.push(`B) Purchase.firstInstallmentMonth=${purchase.firstInstallmentMonth}, esperado ${canonicalBills.canonicalFirstMonth}`);

  // C) Card.closingDay
  const card = await client.card.findUnique({ where: { id: cardId } });
  if (card.closingDay !== cardInput.closingDay) problems.push(`C) Card.closingDay=${card.closingDay}, esperado ${cardInput.closingDay}`);

  // D) CardBill legada não existe mais
  const legacyStillExists = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth: legacyCycleMonth } } });
  if (legacyStillExists) problems.push(`D) CardBill ${legacyCycleMonth} ainda existe (id=${legacyStillExists.id})`);

  // E-L: precisam do billsView real (via client) — calculado uma vez, reusado.
  const billsView = await listCardBillsView(cardId, { now: ASOF, client });
  const legacyProjected = billsView.find((b) => b.cycleMonth === legacyCycleMonth);
  const legacyRemaining = legacyProjected ? subtractMoney(money(legacyProjected.totalAmount), money(legacyProjected.paidAmount ?? 0)) : money(0);
  if (isPositive(legacyRemaining)) problems.push(`E) listCardBillsView ainda projeta ${legacyCycleMonth} com remaining=${legacyRemaining.toString()} (deveria ser 0)`);

  const currentRelevant = resolveCurrentRelevantCardBillCycleMonth(billsView);
  if (currentRelevant !== canonicalBills.expectedCurrentRelevant) problems.push(`F) currentRelevant=${currentRelevant}, esperado ${canonicalBills.expectedCurrentRelevant}`);

  let incurred = null;
  const future = [];
  const remainingPositive = [];
  for (const b of billsView) {
    const remaining = subtractMoney(money(b.totalAmount), money(b.paidAmount ?? 0));
    if (remaining.lte(0)) continue;
    remainingPositive.push({ cycleMonth: b.cycleMonth, remaining: remaining.toString(), closesAt: b.closesAt.toISOString() });
    const cls = classifyCardBill(b, { isCurrentRelevant: b.cycleMonth === currentRelevant });
    if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) incurred = { cycleMonth: b.cycleMonth, amount: remaining.toString() };
    else if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) future.push({ cycleMonth: b.cycleMonth, amount: remaining.toString() });
  }
  remainingPositive.sort((a, b) => new Date(a.closesAt) - new Date(b.closesAt));

  if (!incurred || compareMoney(money(incurred.amount), money(canonicalBills.expectedIncurred)) !== 0 || incurred.cycleMonth !== canonicalBills.expectedCurrentRelevant) {
    problems.push(`G) incurredLiability=${JSON.stringify(incurred)}, esperado {cycleMonth:${canonicalBills.expectedCurrentRelevant}, amount:${canonicalBills.expectedIncurred}}`);
  }
  const futureTotal = sumMoney(future.map((f) => money(f.amount)));
  if (compareMoney(futureTotal, money(canonicalBills.expectedFuture)) !== 0) {
    problems.push(`H) futureObligations.total=${futureTotal.toString()}, esperado ${canonicalBills.expectedFuture}`);
  }

  const usedLimit = await computeCardUsedLimit(cardId, { client });
  if (compareMoney(usedLimit, money(canonicalBills.expectedUsedLimit)) !== 0) problems.push(`I) computeCardUsedLimit=${usedLimit.toString()}, esperado ${canonicalBills.expectedUsedLimit}`);

  const totalLimit = await computeCardTotalLimit(cardId, { client });
  const availableLimit = subtractMoney(totalLimit, usedLimit);
  if (compareMoney(availableLimit, money(canonicalBills.expectedAvailableLimit)) !== 0) problems.push(`J) availableLimit=${availableLimit.toString()}, esperado ${canonicalBills.expectedAvailableLimit}`);

  const septBill = billsView.find((b) => b.cycleMonth === canonicalBills.septemberCycleMonth);
  if (!septBill || compareMoney(money(septBill.totalAmount), money(canonicalBills.septemberAmount)) !== 0 || septBill.status !== "paid") {
    problems.push(`K) September bill = ${JSON.stringify(septBill)}, esperado {totalAmount:${canonicalBills.septemberAmount}, status:paid}`);
  }

  const remainingCycles = remainingPositive.map((r) => r.cycleMonth).sort();
  const expectedCycles = [...canonicalBills.expectedRemainingBills.keys()].sort();
  const cyclesMatch = JSON.stringify(remainingCycles) === JSON.stringify(expectedCycles);
  let amountsMatch = true;
  for (const [cm, amt] of canonicalBills.expectedRemainingBills) {
    const found = remainingPositive.find((r) => r.cycleMonth === cm);
    if (!found || compareMoney(money(found.remaining), money(amt)) !== 0) amountsMatch = false;
  }
  const noEarlierLiability = remainingPositive.every((r) => r.cycleMonth >= canonicalBills.septemberCycleMonth);
  if (!cyclesMatch || !amountsMatch || !noEarlierLiability) {
    problems.push(`L) remainingPositive=${JSON.stringify(remainingPositive)}, esperado exatamente ${JSON.stringify([...canonicalBills.expectedRemainingBills])} (nenhuma anterior a ${canonicalBills.septemberCycleMonth})`);
  }

  return { ok: problems.length === 0, problems, snapshot: { currentRelevant, incurred, futureTotal: futureTotal.toString(), usedLimit: usedLimit.toString(), availableLimit: availableLimit.toString(), remainingPositive } };
}

async function main() {
  log("=".repeat(78));
  log("Fase 5.1B-CARD-v2 — apply real, escopo Card+CardBill+Purchase+Installment+CardLimitUpdate");
  log(DRY_RUN ? "MODO: --dry-run (preflight/simulação apenas, ZERO write)" : "MODO: WRITE REAL");
  log("=".repeat(78));

  const { migrateStatusOutput } = assertExtraSafety();
  log("✅ Ambiente dev confirmado + prisma migrate status clean.");

  const inputPath = path.join(HERE, "snapshot-input.local.json");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cardInput = input.card;
  if (!cardInput?.slug) throw new Error("input.card.slug ausente.");

  const cardBefore = await prisma.card.findUnique({ where: { slug: cardInput.slug } });
  if (!cardBefore) throw new Error(`Card slug=${cardInput.slug} não encontrado.`);

  const uniqueConstraint = confirmCardBillUniqueConstraint();
  if (!uniqueConstraint.isCardIdCycleMonth) throw new Error("Constraint @@unique([cardId,cycleMonth]) não confirmada.");

  const persistedBillsBefore = await prisma.cardBill.findMany({ where: { cardId: cardBefore.id }, orderBy: { cycleMonth: "asc" } });
  const purchaseBefore = await prisma.purchase.findFirst({ where: { cardId: cardBefore.id } });
  if (!purchaseBefore) throw new Error("Nenhuma Purchase encontrada pra este cartão — nada a realinhar.");
  const installmentsBefore = await prisma.installment.findMany({ where: { purchaseId: purchaseBefore.id }, orderBy: { number: "asc" } });
  const limitUpdatesBefore = await prisma.cardLimitUpdate.findMany({ where: { cardId: cardBefore.id }, orderBy: { occurredAt: "asc" } });

  // --- Item 2: novo baseline (NUNCA reutiliza o da v1) ---
  const otherModelsFingerprintBefore = await fingerprintModels(OTHER_MODELS);
  const backupDir = path.join(HERE, "snapshot-reports");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = {
    generatedAt: new Date().toISOString(),
    schemaMigrateStatus: migrateStatusOutput,
    cardBefore,
    cardBillsBefore: persistedBillsBefore,
    purchaseBefore,
    installmentsBefore,
    limitUpdatesBefore,
    otherModelsFingerprintBefore,
  };
  const backupPath = path.join(backupDir, `pre-card-v2-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`✅ Backup pré-write (novo baseline v2) salvo em: ${backupPath}`);

  // --- Deriva o plano de realinhamento (genérico: getCardCycleForDate real, nunca hardcoded) ---
  const cardHypothetical = { ...cardBefore, closingDay: cardInput.closingDay, dueDay: cardInput.dueDay };
  const canonicalFirstMonth = getCardCycleForDate(cardHypothetical, purchaseBefore.purchasedAt);
  const monthDiff = (a, b) => {
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    return (by - ay) * 12 + (bm - am);
  };
  const shift = monthDiff(purchaseBefore.firstInstallmentMonth, canonicalFirstMonth);
  log(`\nPurchase.firstInstallmentMonth persistido=${purchaseBefore.firstInstallmentMonth} | canônico (getCardCycleForDate real)=${canonicalFirstMonth} | shift=${shift} mês(es)`);
  if (shift === 0) {
    log("✅ Nenhum realinhamento necessário — Installments já no ciclo canônico.");
  }

  const installmentUpdates = shift !== 0 ? installmentsBefore.map((i) => ({ id: i.id, before: i.billMonth, after: addMonthKey(i.billMonth, shift) })) : [];
  const legacyCycleMonth = installmentUpdates.length > 0 ? installmentUpdates[0].before : null;

  // --- Deriva o apply set de CardBill (mesma lógica real da v1/da investigação) ---
  const knownBills = (cardInput.bills || []).map((b) => ({ ...b, amountMoney: money(b.amount) }));
  const knownBillsByMonth = new Map(knownBills.map((b) => [b.cycleMonth, b.amountMoney]));
  const shapedBills = persistedBillsBefore.map(shapeBill);
  const classified = classifyPersistedCardBills(shapedBills, knownBillsByMonth);
  const cardBillManifestById = buildCardBillManifestById(knownBills, classified);
  const updateApprovals = cardBillManifestById.filter((cb) => cb.proposedAction === "UPDATE");

  // Item 17-18: retained bills (canonical) cuja metadata (closesAt/dueAt) diverge sob o novo closingDay, MESMO com valor já correto (Dez/Jan).
  const metadataOnlyUpdates = [];
  for (const cb of cardBillManifestById) {
    if (cb.proposedAction === "UPDATE") continue; // já coberto acima (valor+metadata)
    const known = knownBillsByMonth.get(cb.cycleMonth);
    if (known == null) continue; // não é um ciclo canônico conhecido
    const canonClosesAt = getCardBillClosesAt(cardHypothetical, cb.cycleMonth);
    const canonDueAt = getCardBillDueDate(cardHypothetical, cb.cycleMonth);
    const persisted = persistedBillsBefore.find((b) => b.id === cb.id);
    if (persisted.closesAt.getTime() !== canonClosesAt.getTime() || persisted.dueAt.getTime() !== canonDueAt.getTime()) {
      metadataOnlyUpdates.push({ id: cb.id, cycleMonth: cb.cycleMonth, closesAt: canonClosesAt, dueAt: canonDueAt });
    }
  }

  log(`\nCardBill UPDATE (valor+metadata): ${updateApprovals.map((u) => u.cycleMonth).join(", ") || "nenhum"}`);
  log(`CardBill UPDATE (metadata só): ${metadataOnlyUpdates.map((u) => u.cycleMonth).join(", ") || "nenhum"}`);
  log(`CardBill DELETE (legada): ${legacyCycleMonth ?? "N/A"}`);

  // --- Item 28: dedup do CardLimitUpdate — não cria duplicata se já existe uma âncora idêntica ---
  const desiredLimitUpdate = {
    cardId: cardBefore.id,
    occurredAt: CUTOVER_SNAPSHOT_BOUNDARY,
    newUsedLimit: subtractMoney(money(cardInput.totalLimit), money(cardInput.observedAvailable)),
    reportedAvailable: money(cardInput.observedAvailable),
  };
  const existingIdenticalLimitUpdate = limitUpdatesBefore.find(
    (lu) =>
      lu.occurredAt.getTime() === desiredLimitUpdate.occurredAt.getTime() &&
      compareMoney(money(lu.newUsedLimit), desiredLimitUpdate.newUsedLimit) === 0 &&
      lu.reportedAvailable != null &&
      compareMoney(money(lu.reportedAvailable), desiredLimitUpdate.reportedAvailable) === 0
  );
  log(`\nCardLimitUpdate desejado: occurredAt=${desiredLimitUpdate.occurredAt.toISOString()}, newUsedLimit=${desiredLimitUpdate.newUsedLimit.toString()}, reportedAvailable=${desiredLimitUpdate.reportedAvailable.toString()}`);
  log(`Já existe uma âncora idêntica? ${existingIdenticalLimitUpdate ? "SIM (id=" + existingIdenticalLimitUpdate.id + ") — NÃO cria duplicata" : "não — será criada"}`);

  const nothingToDo = shift === 0 && updateApprovals.length === 0 && metadataOnlyUpdates.length === 0 && !legacyCycleMonth && cardBefore.closingDay === cardInput.closingDay && existingIdenticalLimitUpdate;
  if (nothingToDo) {
    log("\n✅ NO_MUTATIONS_NEEDED — idempotência confirmada.");
    return { status: "NO_MUTATIONS_NEEDED" };
  }

  const canonicalTargets = {
    legacyCycleMonth,
    canonicalFirstMonth,
    expectedCurrentRelevant: knownBills.filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth))[0]?.cycleMonth,
    expectedIncurred: knownBills.filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth))[0]?.amount,
    expectedFuture: sumMoney(
      knownBills
        .filter((b) => b.status !== "PAID")
        .sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth))
        .slice(1)
        .map((b) => money(b.amount))
    ).toString(),
    expectedUsedLimit: desiredLimitUpdate.newUsedLimit.toString(),
    expectedAvailableLimit: subtractMoney(money(cardInput.totalLimit), desiredLimitUpdate.newUsedLimit).toString(),
    septemberCycleMonth: knownBills.find((b) => b.status === "PAID")?.cycleMonth,
    septemberAmount: knownBills.find((b) => b.status === "PAID")?.amount,
    expectedRemainingBills: new Map(knownBills.filter((b) => b.status !== "PAID").map((b) => [b.cycleMonth, money(b.amount).toString()])),
  };

  if (DRY_RUN) {
    log("\n--- Simulando a transação EM MEMÓRIA (client simulado, zero write) — mesmos invariantes reais, nenhum valor esperado hardcoded ---");
    const simulatedClient = buildSimulatedClient({
      cardId: cardBefore.id,
      purchaseId: purchaseBefore.id,
      canonicalFirstMonth,
      installmentUpdates,
      legacyCycleMonth,
      updateApprovals,
      metadataOnlyUpdates,
      desiredLimitUpdate,
      existingIdenticalLimitUpdate,
      cardInput,
    });
    const simulatedInvariants = await checkInvariants(simulatedClient, { cardId: cardBefore.id, purchaseId: purchaseBefore.id, canonicalBills: canonicalTargets, cardInput });
    log(`Invariantes A-L (simulados): ${simulatedInvariants.ok ? "TODOS PASSARIAM" : "FALHARIAM"}`);
    if (!simulatedInvariants.ok) log(JSON.stringify(simulatedInvariants.problems, null, 2));
    log(JSON.stringify(simulatedInvariants.snapshot, null, 2));
    return {
      status: simulatedInvariants.ok ? "DRY_RUN_COMPLETE" : "DRY_RUN_WOULD_FAIL",
      backupPath,
      canonicalTargets,
      installmentUpdates,
      updateApprovals: updateApprovals.map((u) => u.id),
      metadataOnlyUpdates: metadataOnlyUpdates.map((u) => u.id),
      legacyCycleMonth,
      simulatedInvariants,
    };
  }

  // ==========================================================================
  // TRANSAÇÃO ÚNICA — validação DENTRO da tx, só commita se TODOS os
  // invariantes A-L passarem.
  // ==========================================================================
  log("\n--- Iniciando transação real (validação tx-scoped) ---");
  let invariantResult = null;
  const txResult = await prisma.$transaction(async (tx) => {
    // 1. Revalidar preflight via tx
    const freshCard = await tx.card.findUnique({ where: { id: cardBefore.id } });
    if (!freshCard || freshCard.updatedAt.getTime() !== cardBefore.updatedAt.getTime()) throw new Error("Card mudou desde o preflight.");
    const freshPurchase = await tx.purchase.findUnique({ where: { id: purchaseBefore.id } });
    if (!freshPurchase || freshPurchase.updatedAt.getTime() !== purchaseBefore.updatedAt.getTime()) throw new Error("Purchase mudou desde o preflight.");
    for (const cb of persistedBillsBefore) {
      const fresh = await tx.cardBill.findUnique({ where: { id: cb.id } });
      if (!fresh || fresh.updatedAt.getTime() !== cb.updatedAt.getTime()) throw new Error(`CardBill ${cb.id} mudou desde o preflight.`);
    }

    // 2. Card.closingDay
    await tx.card.update({ where: { id: cardBefore.id }, data: { closingDay: cardInput.closingDay } });

    // 3. Purchase.firstInstallmentMonth
    if (shift !== 0) {
      await tx.purchase.update({ where: { id: purchaseBefore.id }, data: { firstInstallmentMonth: canonicalFirstMonth } });
    }

    // 4. Installments — atualizar em ordem que nunca colida com @@unique([purchaseId, number]) (number não muda, só billMonth — sem colisão possível).
    for (const upd of installmentUpdates) {
      await tx.installment.update({ where: { id: upd.id }, data: { billMonth: upd.after } });
    }

    // 5. DELETE da CardBill legada — só depois do realinhamento acima.
    if (legacyCycleMonth) {
      await tx.cardBill.delete({ where: { cardId_cycleMonth: { cardId: cardBefore.id, cycleMonth: legacyCycleMonth } } });
    }

    // 6-11. UPDATE das CardBills canônicas (valor+metadata) e metadata-only (Dez/Jan)
    for (const upd of updateApprovals) {
      const newClosesAt = getCardBillClosesAt(cardHypothetical, upd.cycleMonth);
      const newDueAt = getCardBillDueDate(cardHypothetical, upd.cycleMonth);
      await tx.cardBill.update({
        where: { id: upd.id },
        data: {
          totalAmount: money(upd.canonical.totalAmount),
          paidAmount: upd.canonical.paidAmount != null ? money(upd.canonical.paidAmount) : null,
          status: upd.canonical.status,
          closesAt: newClosesAt,
          dueAt: newDueAt,
        },
      });
    }
    for (const upd of metadataOnlyUpdates) {
      await tx.cardBill.update({ where: { id: upd.id }, data: { closesAt: upd.closesAt, dueAt: upd.dueAt } });
    }

    // 12. CREATE nova CardLimitUpdate (só se ainda não existir uma idêntica)
    let newLimitUpdate = null;
    if (!existingIdenticalLimitUpdate) {
      newLimitUpdate = await tx.cardLimitUpdate.create({
        data: {
          cardId: cardBefore.id,
          newTotalLimit: null,
          newUsedLimit: desiredLimitUpdate.newUsedLimit,
          reportedAvailable: desiredLimitUpdate.reportedAvailable,
          occurredAt: desiredLimitUpdate.occurredAt,
          note: "Observação bancária confirmada (snapshot asOf=2026-09-04, boundary=fim do dia — ver CUTOVER_SNAPSHOT_BOUNDARY)",
          source: "manual",
          confidence: "CONFIRMED",
        },
      });
    }

    // 13-14. Ler o estado da PRÓPRIA transação (client: tx) e checar TODOS os invariantes A-L
    invariantResult = await checkInvariants(tx, { cardId: cardBefore.id, purchaseId: purchaseBefore.id, canonicalBills: canonicalTargets, cardInput });

    // 15. Se qualquer invariante falhar: throw -> rollback automático, NENHUM commit.
    if (!invariantResult.ok) {
      throw new Error("INVARIANTES FALHARAM (dentro da transação, ANTES do commit):\n" + invariantResult.problems.join("\n"));
    }

    return { newLimitUpdate };
  });
  log("✅ TODOS os invariantes A-L passaram DENTRO da transação. Transação commitada com sucesso.");
  log(JSON.stringify(invariantResult.snapshot, null, 2));

  // --- Validação pós-commit (item 22) — com o prisma GLOBAL, deve bater com o resultado dentro da tx ---
  const postCommitInvariants = await checkInvariants(prisma, { cardId: cardBefore.id, purchaseId: purchaseBefore.id, canonicalBills: canonicalTargets, cardInput });
  const postCommitMatchesTxScoped = JSON.stringify(postCommitInvariants.snapshot) === JSON.stringify(invariantResult.snapshot);
  log(`\n✅ Validação pós-commit (prisma global) ${postCommitInvariants.ok ? "PASSOU" : "FALHOU"} — idêntica ao resultado tx-scoped: ${postCommitMatchesTxScoped}`);
  if (!postCommitInvariants.ok || !postCommitMatchesTxScoped) {
    log("🛑 DIVERGÊNCIA DETECTADA PÓS-COMMIT — isto seria disaster recovery (não esperado, tudo já foi validado antes do commit):");
    log(JSON.stringify(postCommitInvariants.problems, null, 2));
  }

  const otherModelsFingerprintAfter = await fingerprintModels(OTHER_MODELS);
  const otherModelsUnchanged = JSON.stringify(otherModelsFingerprintBefore) === JSON.stringify(otherModelsFingerprintAfter);

  const cardAfter = await prisma.card.findUnique({ where: { id: cardBefore.id } });
  const purchaseAfter = await prisma.purchase.findUnique({ where: { id: purchaseBefore.id } });
  const installmentsAfter = await prisma.installment.findMany({ where: { purchaseId: purchaseBefore.id }, orderBy: { number: "asc" } });
  const cardBillsAfter = await prisma.cardBill.findMany({ where: { cardId: cardBefore.id }, orderBy: { cycleMonth: "asc" } });
  const limitUpdatesAfter = await prisma.cardLimitUpdate.findMany({ where: { cardId: cardBefore.id }, orderBy: { occurredAt: "asc" } });

  const postWritePath = path.join(backupDir, `post-card-v2-apply-${Date.now()}.local.json`);
  fs.writeFileSync(
    postWritePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), cardAfter, purchaseAfter, installmentsAfter, cardBillsAfter, limitUpdatesAfter, otherModelsUnchanged, postCommitInvariants: postCommitInvariants.snapshot }, null, 2)
  );
  log(`✅ Estado pós-write salvo em: ${postWritePath}`);

  return {
    status: "SUCCESS",
    backupPath,
    postWritePath,
    otherModelsUnchanged,
    postCommitMatchesTxScoped,
    invariants: postCommitInvariants,
    cardAfter,
    purchaseAfter,
    installmentsAfter,
    cardBillsAfter,
    limitUpdatesAfter,
    limitUpdateCreated: !existingIdenticalLimitUpdate,
  };
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
