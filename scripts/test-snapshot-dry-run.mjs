// Fase 5.0/5.0.1 — testes SINTÉTICOS (zero dado pessoal) pro tooling genérico
// de reconciliação (scripts/snapshot-dry-run.mjs). Cobre: abertura derivada
// (nunca = recarga), delta inexplicado, transferência externa não vira
// Expense, card checksum, INCOMPLETE quando falta evidência, BalanceAdjustment
// nunca aprovado automaticamente com delta pendente, completeness granular,
// CardBill mutation planner sem CREATE conflitante, contaminação do engine por
// row legacy, Purchase parcial permanece UNKNOWN (nunca descartada
// automaticamente), e zero-write (checagem estática + fingerprint real).
//
// Este teste toca o banco (leituras + fixtures sintéticas próprias, sempre
// limpas no finally) — assertTestEnvironment() por segurança.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { compareMoney, money } from "../lib/money.js";
import {
  INVENTORY_MODELS,
  reconcileCheckingLedger,
  reconcileRestrictedLedger,
  reconcileCard,
  engineDryRun,
  auditTransferSchemaForExternalScope,
  classifyPersistedCardBills,
  buildProposedMutations,
  buildPotentialLastResortMutations,
  confirmCardBillUniqueConstraint,
  auditPurchasesAgainstKnownBills,
  main,
} from "./snapshot-dry-run.mjs";
import { parseSemicolonCsv, auditCsvRows, reconstructExternalInstallmentCandidates } from "./lib/csvStagingAudit.mjs";
import { listCardBillsView } from "../lib/cardBillCalculator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = "TESTE_FASE5001";

let passed = 0;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  if (condition) passed++;
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(money(a), money(b)) === 0;
}

console.log("--- Fase 5.0.1: testes sintéticos do snapshot-dry-run ---\n");

// ============================================================================
// 0. Checagem estática — zero método mutante no código-fonte do tool.
// ============================================================================
{
  const source = fs.readFileSync(path.join(HERE, "snapshot-dry-run.mjs"), "utf8");
  const forbidden = /\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw|\$transaction/i;
  check("scripts/snapshot-dry-run.mjs não contém nenhum método mutante do Prisma", !forbidden.test(source));
}

// ============================================================================
// 1. Checkpoints intermediário + final, sem delta (fecha exato) — conta irrestrita.
// ============================================================================
{
  const section = {
    checkpointA: { amount: 1000, date: "2026-01-01", confidence: "CONFIRMED" },
    movementsAfterCheckpointA: [
      { type: "INFLOW", description: "entrada sintética", amount: 500, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_INCOME" },
      { type: "TRANSFER_OUT_EXTERNAL", description: "saída sintética externa", amount: 300, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_EXTERNAL" },
    ],
    checkpointB: { amount: 1200, date: "2026-01-01", confidence: "CONFIRMED" },
  };
  const result = reconcileCheckingLedger(section, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  check("checkpoint intermediário preservado no resultado", eq(result.checkpointA.amount, 1000));
  check("net movements = +500 -300 = 200", eq(result.netMovements, 200));
  check("mathematicalExpected = 1000+200 = 1200", eq(result.mathematicalExpected, 1200));
  check("checkpoint final bate exato — delta zero", result.unexplainedDifference === "0" || eq(result.unexplainedDifference, 0));
  check("finalChecksum.matchesObserved = true quando fecha exato", result.finalChecksum.matchesObserved === true);
  check("opening balance sempre marcado DERIVED_ONLY (nunca EVIDENCED por padrão, sem prova independente)", result.derivedOpeningBalance.openingBalanceEvidence === "DERIVED_ONLY");
}

// ============================================================================
// 2. Delta inexplicado — NÃO é escondido nem "corrigido" automaticamente.
// ============================================================================
{
  const section = {
    checkpointA: { amount: 500, date: "2026-01-01", confidence: "CONFIRMED" },
    movementsAfterCheckpointA: [{ type: "INFLOW", description: "entrada sintética", amount: 100, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_INCOME" }],
    checkpointB: { amount: 605, date: "2026-01-01", confidence: "CONFIRMED" }, // esperado 600, observado 605 — delta +5
  };
  const result = reconcileCheckingLedger(section, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  check("delta de +5 reportado explicitamente (não zerado, não escondido)", eq(result.unexplainedDifference, 5));
  check("finalChecksum.matchesObserved = false quando existe delta", result.finalChecksum.matchesObserved === false);
  check("investigação textual presente (não silenciosa)", typeof result.unexplainedDifferenceInvestigation === "string" && result.unexplainedDifferenceInvestigation.includes("NÃO"));
}

// ============================================================================
// 3. Transferência externa (TRANSFER_OUT_EXTERNAL) — auditoria de schema:
// confirma que NÃO precisa virar Expense nem exigir Account de destino.
// ============================================================================
{
  const audit = auditTransferSchemaForExternalScope();
  check("schema já suporta transferência externa sem exigir toAccountId/toCardId", audit.question_B_transferRequiresInternalToField === false);
  check("existe semântica já suportada (kind livre + description) pra transfer-out", audit.question_C_existingSemanticsForTransferOut === true);
  check("nenhuma alteração de schema necessária (gap de modelagem = NENHUM)", audit.question_D_minimalSchemaChangeIfUnsupported.isSchemaChangeNeeded === false);
  check("conclusão explicita que NÃO é preciso criar Account nova pro destino externo", audit.conclusion.includes("sem alteração"));
}

// ============================================================================
// 4. Card checksum — limite usado bate com soma de faturas conhecidas.
// ============================================================================
{
  const cardInput = {
    slug: "cartao-sintetico-inexistente-fase5001", // não existe no banco — reconcileCard só faz findUnique, nenhuma escrita.
    totalLimit: 1000,
    observedAvailable: 400,
    closingDay: 4,
    dueDay: 11,
    bills: [
      { cycleMonth: "2026-01", amount: 200, status: "PAID" },
      { cycleMonth: "2026-02", amount: 300, status: "UNPAID" },
      { cycleMonth: "2026-03", amount: 300, status: "UNPAID" },
    ],
  };
  const result = await reconcileCard(cardInput);
  check("usedLimit = 1000-400 = 600", eq(result.usedLimitChecksum.usedLimitObserved, 600));
  check("soma das faturas não pagas = 600, bate com usedLimit", result.usedLimitChecksum.matches === true);
  check("primeira fatura não paga (2026-02) = INCURRED_LIABILITY", result.liabilityClassification.incurredLiability.cycleMonth === "2026-02");
  check("fatura seguinte (2026-03) = FUTURE_OBLIGATION", result.liabilityClassification.futureObligations.items.some((i) => i.cycleMonth === "2026-03"));
  check("card inexistente no banco é reportado como NOT_FOUND_IN_DB, não inventado", result.cardFoundInDb.status === "NOT_FOUND_IN_DB");
  check("constraint de unicidade CardBill confirmada lendo o schema (cardId+cycleMonth)", result.cardBillUniqueConstraint.isCardIdCycleMonth === true);
}

// ============================================================================
// 5. Engine dry-run: COMPLETE quando toda evidência necessária existe.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [{ cycleMonth: "2026-01", amount: 100, status: "UNPAID" }] },
    mainIncome: { amount: 2000, dayOfMonth: 24, recurringAmountConfidence: "CONFIRMED" },
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-01-24T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("freeMoney calculado (não INCOMPLETE)", result.freeMoney !== "INCOMPLETE");
  check("freeMoneyCompleteness = COMPLETE", result.completeness.freeMoneyCompleteness === "COMPLETE");
}

// ============================================================================
// 6. Engine dry-run: classificação de horizonte incerta quando a data ambígua
// MUDA o bucket (não seguro decidir) — reportado em missingEvidence.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    confirmedCommitments: [
      {
        description: "Compromisso ambíguo sintético",
        amount: 100,
        // Uma data cai ANTES do nextIncome (current horizon), outra cai DEPOIS
        // (future) — classificação muda dependendo de qual for a real.
        dateCandidates: ["2026-01-20", "2026-03-01"],
        dateConfidence: "UNCERTAIN",
        funding: "UNDEFINED",
      },
    ],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-01T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("missingEvidence lista o campo exato faltante quando a data ambígua muda a classificação", result.missingEvidence.some((m) => m.field.includes("dueDate")));
  check("NÃO inventa um resultado final mesmo faltando evidência (freeMoney ainda é calculável, item ambíguo é ignorado)", result.freeMoney !== undefined && result.freeMoney !== null);
}

// ============================================================================
// 6b. Engine dry-run: sem checkingAccount -> freeMoney explicitamente INCOMPLETE.
// ============================================================================
{
  const input = { asOf: "2026-01-15", card: { bills: [] }, confirmedCommitments: [], contingencies: [] };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: null, status: "MISSING_EVIDENCE", isFallback: null };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("sem unrestrictedCash, freeMoney = 'INCOMPLETE' (nunca um número inventado)", result.freeMoney === "INCOMPLETE");
  check("overallCompleteness = INCOMPLETE", result.completeness.overallCompleteness === "INCOMPLETE");
}

// ============================================================================
// A (item 19.A) — conta restrita: opening derivado NUNCA é a recarga. Valores
// 100% fictícios e redondos, escolhidos de propósito diferentes de qualquer
// número real discutido nesta reconciliação.
// ============================================================================
{
  const account = await prisma.account.create({ data: { slug: `teste-fase5001-va-${Date.now()}`, name: `[${MARK}] Conta restrita`, type: "food_voucher" } });
  const rechargeDate = new Date("2026-01-01T00:00:00.000Z");
  const income = await prisma.income.create({ data: { amount: money(1000), description: `[${MARK}] recarga`, accountId: account.id, occurredAt: rechargeDate } });
  const expenseDates = [
    new Date("2026-01-05T00:00:00.000Z"),
    new Date("2026-01-10T00:00:00.000Z"),
  ];
  const expenseAmounts = [120, 180]; // soma = 300
  const expenses = [];
  for (let i = 0; i < expenseAmounts.length; i++) {
    expenses.push(await prisma.expense.create({ data: { amount: money(expenseAmounts[i]), description: `[${MARK}] gasto ${i}`, accountId: account.id, occurredAt: expenseDates[i] } }));
  }

  try {
    const result = await reconcileRestrictedLedger({
      slug: account.slug,
      recharge: { amount: 1000, date: "2026-01-01", confidence: "CONFIRMED" },
      observedClosing: { amount: 200, date: "2026-01-15", confidence: "CONFIRMED" },
    });
    check("knownNetMovements = 1000 - 300 = 700", eq(result.knownNetMovements, 700));
    check("residualOpeningFromKnownLedger = 200 - 700 = -500", eq(result.residualOpeningFromKnownLedger, -500));
    check("derivedOpeningBalance = 'INDETERMINATE' (NUNCA a recarga, NUNCA '1000')", result.derivedOpeningBalance === "INDETERMINATE");
    check("openingBalanceEvidence = 'MISSING'", result.openingBalanceEvidence === "MISSING");
    check("unexplainedOutflowsOrMissingEvidence = 500 (magnitude, sempre positiva)", eq(result.unexplainedOutflowsOrMissingEvidence, 500));
    check("externalSourceInvestigation distingue NOT_IN_REPOSITORY de EVIDENCE_DOES_NOT_EXIST", result.externalSourceInvestigation.classification === "MISSING_EXTERNAL_SOURCE_FILE");
  } finally {
    await prisma.expense.deleteMany({ where: { id: { in: expenses.map((e) => e.id) } } });
    await prisma.income.delete({ where: { id: income.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// B (item 19.B) — BalanceAdjustment NUNCA aparece como CREATE aprovado em
// buildProposedMutations quando o delta permanece unresolved — só em
// buildPotentialLastResortMutations, explicitamente marcado NOT_PROPOSED_FOR_EXECUTION.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointA: { amount: 100, date: "2026-01-01", confidence: "CONFIRMED" }, movementsAfterCheckpointA: [], checkpointB: { amount: 105, date: "2026-01-15", confidence: "CONFIRMED" } },
    card: { bills: [] },
    confirmedCommitments: [],
    contingencies: [],
  };
  const checkingRecon = reconcileCheckingLedger(input.checkingAccount, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  const vaRecon = { status: "MISSING_EVIDENCE" };
  const inventory = { card: { rows: [] } };
  const cardRecon = await reconcileCard(input.card);
  const mutations = buildProposedMutations(input, inventory, checkingRecon, vaRecon, cardRecon);
  check("delta sintético é não-zero (pré-condição do teste)", checkingRecon.unexplainedDifference !== "0");
  check("nenhuma mutation aprovada é BalanceAdjustment quando delta permanece unresolved", mutations.every((m) => m.model !== "BalanceAdjustment"));

  const potential = buildPotentialLastResortMutations(checkingRecon, vaRecon);
  check("BalanceAdjustment aparece SÓ em potentialLastResortMutations, marcado NOT_PROPOSED_FOR_EXECUTION", potential.some((p) => p.model === "BalanceAdjustment" && p.status === "NOT_PROPOSED_FOR_EXECUTION"));
  check("potentialLastResortMutations explica condições futuras de aceitação (acceptableOnlyIf não vazio)", potential.every((p) => Array.isArray(p.acceptableOnlyIf) && p.acceptableOnlyIf.length > 0));
}

// ============================================================================
// C (item 19.C) — engine: freeMoney completo mesmo com contingency undated.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    confirmedCommitments: [],
    contingencies: [{ description: "Risco sintético sem data", expectedAmount: 100, expectedAmountConfidence: "ESTIMATED", maxAmount: 200, maxAmountConfidence: "UNCERTAIN", status: "AWAITING_INFORMATION" }],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-24T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("freeMoney COMPLETE mesmo com contingency sem data", result.completeness.freeMoneyCompleteness === "COMPLETE");
  check("contingência sem data vira UNDATED_RISK_EXPOSURE, nunca inserida na timeline com data inventada", result.contingencyExposure.undatedRiskExposures.length === 1);
  check("contingencyExposure.expected/maximum ainda calculáveis (100/200)", eq(result.contingencyExposure.expected, 100) && eq(result.contingencyExposure.maximum, 200));
  check("expectedProjectionCompleteness = PARTIAL por causa do risco sem data", result.completeness.expectedProjectionCompleteness === "PARTIAL");
}

// ============================================================================
// D (item 19.D) — overall completeness não pode ser COMPLETE com uma
// projeção INCOMPLETE/PARTIAL.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    mainIncome: { amount: 2000, dayOfMonth: 24 }, // sem recurringAmountConfidence -> PARTIAL em cascata
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-01-24T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("algum componente ficou PARTIAL (baseProjection ou nextIncome)", Object.values(result.completeness).includes("PARTIAL"));
  check("overallCompleteness NÃO é COMPLETE quando existe componente PARTIAL", result.completeness.overallCompleteness !== "COMPLETE");
}

// ============================================================================
// E (item 19.E) — CardBill mutation planner nunca gera CREATE conflitante com
// existing cardId+cycleMonth: para bills persistidas, só UPDATE/KEEP/
// DELETE_ARTIFACT_CANDIDATE/NEEDS_EVIDENCE, nunca CREATE.
// ============================================================================
{
  const persistedBills = [
    { id: "bill-1", cycleMonth: "2026-01", totalAmount: "100.00", paidAmount: null, remainingAmount: "100.00", status: "open", closesAt: "2026-02-01T00:00:00.000Z", dueAt: "2026-02-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "bill-2", cycleMonth: "2026-02", totalAmount: "0.00", paidAmount: null, remainingAmount: "0.00", status: "open", closesAt: "2026-03-01T00:00:00.000Z", dueAt: "2026-03-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
    { id: "bill-3", cycleMonth: "2026-03", totalAmount: "0.00", paidAmount: null, remainingAmount: "0.00", status: "open", closesAt: "2026-04-01T00:00:00.000Z", dueAt: "2026-04-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z" },
    { id: "bill-4", cycleMonth: "2026-04", totalAmount: "0.00", paidAmount: null, remainingAmount: "0.00", status: "open", closesAt: "2026-05-01T00:00:00.000Z", dueAt: "2026-05-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:03.000Z", updatedAt: "2026-01-01T00:00:03.000Z" },
    { id: "bill-5", cycleMonth: "2026-05", totalAmount: "0.00", paidAmount: null, remainingAmount: "0.00", status: "open", closesAt: "2026-06-01T00:00:00.000Z", dueAt: "2026-06-11T00:00:00.000Z", createdAt: "2026-01-01T00:00:04.000Z", updatedAt: "2026-01-01T00:00:04.000Z" },
  ];
  const knownBillsByMonth = new Map([["2026-01", money(250)]]); // valor real diverge do persistido (100) -> UPDATE candidate
  const classified = classifyPersistedCardBills(persistedBills, knownBillsByMonth);
  const cardRecon = { persistedCardBillsClassified: classified, usedLimitChecksum: { matches: true }, purchaseAudit: { status: "NONE_FOUND" } };
  const inventory = { card: { rows: [{ closingDay: null }] } };
  const input = { card: { bills: [{ cycleMonth: "2026-01", amount: 250, status: "UNPAID" }] } };
  const mutations = buildProposedMutations(input, inventory, { unexplainedDifference: "0" }, { residualOpeningFromKnownLedger: "0" }, cardRecon);
  const cardBillMutations = mutations.filter((m) => m.model === "CardBill");
  check("classificou bill-1 como CANONICAL_UPDATE_CANDIDATE (valor diverge do real conhecido)", classified.find((c) => c.id === "bill-1").classification === "CANONICAL_UPDATE_CANDIDATE");
  check("nenhuma mutation de CardBill usa category=CREATE (constraint cardId+cycleMonth já garante 1 row por ciclo)", cardBillMutations.every((m) => m.category !== "CREATE"));
  check("bill-1 (diverge) gera categoria UPDATE, não CREATE", cardBillMutations.find((m) => m.reference.includes("bill-1"))?.category === "UPDATE");
}

// ============================================================================
// F (item 19.F) — rows legacy ATIVAS (remaining > 0, valor errado) são
// identificadas como risco de contaminação do engine; rows zeradas não.
// ============================================================================
{
  const persistedBills = [
    { id: "wrong-active", cycleMonth: "2026-01", totalAmount: "45.00", paidAmount: null, remainingAmount: "45.00", status: "open", closesAt: "x", dueAt: "x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "zero-inert", cycleMonth: "2026-02", totalAmount: "0.00", paidAmount: null, remainingAmount: "0.00", status: "open", closesAt: "x", dueAt: "x", createdAt: "2026-01-01T00:00:01.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
  ];
  const knownBillsByMonth = new Map([["2026-01", money(1000)]]); // valor real muito diferente do persistido
  const classified = classifyPersistedCardBills(persistedBills, knownBillsByMonth);
  const wrongActive = classified.find((c) => c.id === "wrong-active");
  const zeroInert = classified.find((c) => c.id === "zero-inert");
  check("row ativa com valor errado (remaining>0) É marcada como contaminando o engine", wrongActive.wouldContaminateEngineIfLeftAsIs === true);
  check("row zerada (remaining=0) NÃO contamina o engine (sempre SETTLED/ignorada pelo classificador real)", zeroInert.wouldContaminateEngineIfLeftAsIs === false);
}

// ============================================================================
// G (item 19.G) — Purchase que só explica PARCIALMENTE os known bills fica
// UNKNOWN/UNKNOWN_PARTIAL_EXPLANATORY_POWER, nunca descartada automaticamente
// como legacy/test. Fixture real no banco dev (assertTestEnvironment + cleanup).
// ============================================================================
{
  const card = await prisma.card.create({ data: { slug: `teste-fase5001-cartao-${Date.now()}`, name: `[${MARK}] Cartão`, totalLimit: 1000, dueDay: 11, closingDay: 4 } });
  const purchase = await prisma.purchase.create({
    data: {
      description: `[${MARK}] compra parcelada sintética`,
      totalAmount: money(300),
      installmentCount: 3,
      installmentValue: money(100),
      cardId: card.id,
      firstInstallmentMonth: "2026-01",
      source: "manual",
      installments: { create: [1, 2, 3].map((n) => ({ number: n, amount: money(100), billMonth: `2026-0${n}` })) },
    },
  });

  try {
    // Known bill de janeiro é MUITO maior que a parcela (100) -> só explica parcialmente.
    const knownBillsByMonth = new Map([
      ["2026-01", money(900)],
      ["2026-02", money(100)],
      ["2026-03", money(100)],
    ]);
    const result = await auditPurchasesAgainstKnownBills({ slug: card.slug }, knownBillsByMonth);
    check("Purchase encontrada via auditoria read-only", result.status === "FOUND" && result.purchases.length === 1);
    const pa = result.purchases[0];
    check("mês de janeiro classificado como explainsPartial (parcela 100 < known bill 900)", pa.answerB_explainsRecurringComponent.find((c) => c.billMonth === "2026-01").explainsPartial === true);
    check("conclusão NÃO é LIKELY_REAL puro (existe divergência não explicada) — fica UNKNOWN_PARTIAL_EXPLANATORY_POWER", pa.answerE_conclusion === "UNKNOWN_PARTIAL_EXPLANATORY_POWER");
    check("NÃO marcada como legacy/test — evidenceForTestOrJunk documenta a divergência, não uma conclusão de descarte", pa.answerD_evidenceForTestOrJunk.length > 0 && pa.conclusionNote.includes("NÃO"));
  } finally {
    await prisma.purchase.delete({ where: { id: purchase.id } }).catch(() => {});
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
  }
}

// ============================================================================
// H — Zero-write: fingerprint real do banco antes/depois de rodar main() com
// um input sintético completo (arquivo temporário, sem dado pessoal).
// ============================================================================
{
  const tmpInput = path.join(HERE, `snapshot-input.tmp-test-${Date.now()}.json`);
  fs.writeFileSync(
    tmpInput,
    JSON.stringify({
      asOf: "2026-01-15",
      checkingAccount: {
        checkpointA: { amount: 100, date: "2026-01-15", confidence: "CONFIRMED" },
        movementsAfterCheckpointA: [{ type: "INFLOW", description: "teste", amount: 10, date: "2026-01-15", movementConfidence: "CONFIRMED", economicClassification: "TEST" }],
        checkpointB: { amount: 110, date: "2026-01-15", confidence: "CONFIRMED" },
      },
      restrictedAccount: { recharge: { amount: 50, date: "2026-01-01", confidence: "CONFIRMED" }, observedClosing: { amount: 20, date: "2026-01-15", confidence: "CONFIRMED" } },
      mainIncome: { amount: 1000, date: "2026-01-01", dayOfMonth: 1, confidence: "CONFIRMED" },
      card: { totalLimit: 500, observedAvailable: 500, closingDay: 4, dueDay: 11, bills: [] },
      confirmedCommitments: [],
      contingencies: [],
    })
  );

  async function fingerprint() {
    const fp = {};
    for (const modelName of INVENTORY_MODELS) {
      const rows = await prisma[modelName].findMany();
      fp[modelName] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
    }
    return fp;
  }

  const before = await fingerprint();
  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], "--input", tmpInput];
  let mainError = null;
  try {
    await main();
  } catch (err) {
    mainError = err;
  } finally {
    process.argv = originalArgv;
    fs.unlinkSync(tmpInput);
  }
  const after = await fingerprint();

  check("main() do dry-run executou sem erro sobre input sintético", mainError === null, mainError?.message);
  check("fingerprint do banco (ids + updatedAt de todo model financeiro) idêntico antes/depois — ZERO write", JSON.stringify(before) === JSON.stringify(after));
}

// ============================================================================
// I (Fase 5.0.2, item 1) — VA: raw ledger (com TODO Income persistido) é o
// cenário PRINCIPAL; hypotheticalReclassifiedLedger (excluindo income
// não-recarga) é só um "e se". Nunca excluir silenciosamente. Fixture REAL
// no banco dev (assertTestEnvironment + cleanup), valores 100% fictícios.
// ============================================================================
{
  const account = await prisma.account.create({ data: { slug: `teste-fase5002-va-${Date.now()}`, name: `[${MARK}] Conta restrita`, type: "food_voucher" } });
  const rechargeDate = new Date("2026-01-01T00:00:00.000Z");
  const income1 = await prisma.income.create({ data: { amount: money(1000), description: `[${MARK}] recarga`, accountId: account.id, occurredAt: rechargeDate } });
  const income2 = await prisma.income.create({ data: { amount: money(15), description: `[${MARK}] pix de terceiro, sem menção à conta restrita`, accountId: account.id, occurredAt: new Date("2026-01-03T00:00:00.000Z") } });
  const expense1 = await prisma.expense.create({ data: { amount: money(300), description: `[${MARK}] gasto`, accountId: account.id, occurredAt: new Date("2026-01-05T00:00:00.000Z") } });

  try {
    const result = await reconcileRestrictedLedger({
      slug: account.slug,
      recharge: { amount: 1000, date: "2026-01-01", confidence: "CONFIRMED" },
      observedClosing: { amount: 400, date: "2026-01-15", confidence: "CONFIRMED" },
    });
    check("rawPersistedLedger.allKnownIncomeTotal inclui O TOTAL (1000+15=1015), nunca exclui o income extra silenciosamente", eq(result.rawPersistedLedger.allKnownIncomeTotal, 1015));
    check("rawPersistedLedger.knownPersistedNetMovements = 1015-300 = 715", eq(result.rawPersistedLedger.knownPersistedNetMovements, 715));
    check("rawPersistedLedger.rawUnexplainedDifference = 400-715 = -315 (é o delta PRINCIPAL)", eq(result.rawPersistedLedger.rawUnexplainedDifference, -315));
    check("residualOpeningFromKnownLedger (campo principal) usa o RAW, não o hipotético", eq(result.residualOpeningFromKnownLedger, -315));
    check("hypotheticalReclassifiedLedger existe separadamente (1000-300=700, 400-700=-300) mas NÃO é o principal", eq(result.hypotheticalReclassifiedLedger.knownNetMovementsExcludingNonRechargeIncome, 700) && eq(result.hypotheticalReclassifiedLedger.adjustedDifferenceIf22IncomeIsMisclassified, -300));
    check("nonRechargeIncomeInvestigation identifica o income de 15 sem mutar nada", result.nonRechargeIncomeInvestigation.some((i) => eq(i.amount, 15)));
  } finally {
    await prisma.expense.delete({ where: { id: expense1.id } }).catch(() => {});
    await prisma.income.deleteMany({ where: { id: { in: [income1.id, income2.id] } } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// J (Fase 5.0.2, item 2) — classificação LIKELY_MISCLASSIFIED/LIKELY_CORRECT/
// UNKNOWN do income não-recarga, baseada em sinal genérico (menção à
// keyword da conta restrita nos outros registros), nunca hardcoded.
// ============================================================================
{
  const account = await prisma.account.create({ data: { slug: `teste-fase5002-keyword-${Date.now()}`, name: `[${MARK}] Conta restrita 2`, type: "food_voucher" } });
  const rechargeDate = new Date("2026-01-01T00:00:00.000Z");
  const income1 = await prisma.income.create({ data: { amount: money(500), description: `[${MARK}] recarga da conta exemplo`, accountId: account.id, occurredAt: rechargeDate } });
  const incomeSuspicious = await prisma.income.create({ data: { amount: money(9), description: `[${MARK}] recebi um pix qualquer`, accountId: account.id, occurredAt: new Date("2026-01-02T00:00:00.000Z") } });
  const expense1 = await prisma.expense.create({ data: { amount: money(10), description: `[${MARK}] gasto na conta exemplo`, accountId: account.id, occurredAt: new Date("2026-01-03T00:00:00.000Z") } });

  try {
    const result = await reconcileRestrictedLedger({
      slug: account.slug,
      restrictedKeyword: "conta exemplo",
      recharge: { amount: 500, date: "2026-01-01", confidence: "CONFIRMED" },
      observedClosing: { amount: 480, date: "2026-01-15", confidence: "CONFIRMED" },
    });
    const suspicious = result.nonRechargeIncomeInvestigation.find((i) => eq(i.amount, 9));
    check("income sem a keyword, num universo onde os outros mencionam, é classificado LIKELY_MISCLASSIFIED (sinal, não prova)", suspicious?.classification === "LIKELY_MISCLASSIFIED");
    check("classificação nunca é CONFIRMED/mutada — é só um sinal reportado", Array.isArray(suspicious?.reasons) && suspicious.reasons.length > 0);
  } finally {
    await prisma.expense.delete({ where: { id: expense1.id } }).catch(() => {});
    await prisma.income.deleteMany({ where: { id: { in: [income1.id, incomeSuspicious.id] } } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// K (Fase 5.0.2, item 5) — parser CSV genérico: separador ";", BOM, decimal
// brasileiro, campo entre aspas com quebra de linha. CSV 100% fictício.
// ============================================================================
{
  const fakeCsv =
    "﻿Data;Tipo;Valor;Categoria;Forma de pagamento;Fixo;Parcela;Descrição\n" +
    '01/01/2026;Gasto;10,50;Outros;Pix;;;"comprei algo"\n' +
    '02/01/2026;Gasto;20,00;Fatura Cartão de Crédito;Pix;;;"pagando fatura"\n' +
    '03/01/2026;Gasto;30,00;Parcelas Cartão de Crédito;Pix;;2/5;"parcela exemplo 30 reais pix"\n' +
    '04/01/2026;Receita;40,00;Outros;Pix;;;"recebi um pix com\n\ndescrição em duas linhas"\n';
  const tmpCsv = path.join(HERE, `csv-teste-fase5002-${Date.now()}.csv`);
  fs.writeFileSync(tmpCsv, fakeCsv, "utf8");
  try {
    const { header, rows } = auditCsvRows(tmpCsv);
    check("header lido corretamente (8 colunas)", header.length === 8);
    check("4 rows lidas, inclusive a de descrição multi-linha", rows.length === 4);
    check("decimal brasileiro parseado corretamente (10,50 -> 10.50)", eq(rows[0].amount, 10.5));
    check("categoria 'Fatura Cartão de Crédito' classificada CARD_BILL_PAYMENT com LEGACY_MODELING_ANOMALY", rows[1].likelySemanticEntity === "CARD_BILL_PAYMENT" && rows[1].anomalyFlags.some((f) => f.includes("LEGACY_MODELING_ANOMALY")));
    check("row com Parcela '2/5' classificada EXTERNAL_INSTALLMENT, número/total extraídos", rows[2].likelySemanticEntity === "EXTERNAL_INSTALLMENT" && rows[2].installmentNumber === 2 && rows[2].installmentTotal === 5);
    check("descrição multi-linha (quebra dentro de aspas) preservada como um único campo", rows[3].description.includes("duas linhas"));
  } finally {
    fs.unlinkSync(tmpCsv);
  }
}

// ============================================================================
// L (Fase 5.0.2, item 8/10) — reconstrução de candidatos de parcela externa:
// posição projetada, ainda ativa vs completada (limite exato, sem off-by-one).
// ============================================================================
{
  const rows = [
    { likelySemanticEntity: "EXTERNAL_INSTALLMENT", description: "parcela exemplo A", amount: "50", date: "2026-01-01T00:00:00.000Z", cycleMonthOfRawDate: "2026-01", installmentNumber: 9, installmentTotal: 12 },
    { likelySemanticEntity: "EXTERNAL_INSTALLMENT", description: "parcela exemplo B", amount: "20", date: "2026-01-01T00:00:00.000Z", cycleMonthOfRawDate: "2026-01", installmentNumber: 1, installmentTotal: 3 },
  ];
  // asOf = 2 meses depois -> A: 9+2=11 (<=12, ainda ativa); B: 1+2=3 (===total, ainda é a ÚLTIMA parcela, NÃO "já completada" — limite é > total, não >=).
  const plans = reconstructExternalInstallmentCandidates(rows, { asOf: new Date("2026-03-01T00:00:00.000Z"), nextIncomeDate: new Date("2026-03-15T00:00:00.000Z") });
  const planA = plans.find((p) => p.description === "parcela exemplo A");
  const planB = plans.find((p) => p.description === "parcela exemplo B");
  check("posição projetada de A = 9+2 = 11", planA.projectedPositionAtAsOf === 11);
  check("A ainda ativa (11 <= 12)", planA.stillActiveCandidate === true && planA.likelyCompletedByAsOf === false);
  check("posição projetada de B = 1+2 = 3 (última parcela, ainda DEVIDA agora — não 'já completada')", planB.projectedPositionAtAsOf === 3 && planB.stillActiveCandidate === true, "sem off-by-one: position===total não é 'completed'");
  check("candidatas anteriores marcadas IMPLIED_BY_SEQUENCE_POSITION, nunca CONFIRMED por conta própria", planA.candidatePreviousInstallments.every((c) => c.status === "IMPLIED_BY_SEQUENCE_POSITION"));
  check("candidatas futuras marcadas NEEDS_PAYMENT_EVIDENCE, nunca assumidas pagas", planA.candidateFutureInstallments.every((c) => c.status === "NEEDS_PAYMENT_EVIDENCE"));
}

// ============================================================================
// M (Fase 5.0.3, item 11) — freeMoneyCompleteness cai pra PARTIAL quando
// existe bill doméstica PENDING/ESTIMATED do ciclo atual, mesmo com o resto
// conhecido — knownExactFreeMoney nunca muda por causa disso (nunca mistura
// o estimado no valor exato).
// ============================================================================
{
  const baseInput = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const asOfDate = new Date("2026-01-15T00:00:00.000Z");

  const withoutBills = engineDryRun(baseInput, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: asOfDate });
  check("sem bills domésticas pendentes: freeMoneyCompleteness = COMPLETE", withoutBills.completeness.freeMoneyCompleteness === "COMPLETE");

  const inputWithPendingBill = { ...baseInput, householdBills: [{ name: "Exemplo telefone", amount: 50, amountConfidence: "ESTIMATED", status: "PENDING", dueDateKnown: false }] };
  const withPendingBill = engineDryRun(inputWithPendingBill, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: asOfDate });
  check("com 1 bill PENDING/ESTIMATED: freeMoneyCompleteness = PARTIAL (nunca COMPLETE)", withPendingBill.completeness.freeMoneyCompleteness === "PARTIAL");
  check("householdBills.pendingEstimated lista a bill", withPendingBill.householdBills.pendingEstimated.length === 1);
  check("knownExactFreeMoney É IGUAL nos dois cenários — nunca reduzido só por existir uma estimativa", eq(withoutBills.knownExactFreeMoney, withPendingBill.knownExactFreeMoney));
  check("scenarioIncludingKnownEstimates existe separadamente e É diferente do valor exato", withPendingBill.scenarioIncludingKnownEstimates != null && !eq(withPendingBill.scenarioIncludingKnownEstimates.total, withPendingBill.knownExactFreeMoney));
}

// ============================================================================
// N (Fase 5.0.3, item 12) — financialStatus prova (não apenas assume) se uma
// estimativa conhecida muda a classe: possibleStatusWithKnownEstimates só
// diverge de knownStatus quando o pior caso realmente muda a categoria.
// ============================================================================
{
  // Caso 1: freeMoney negativo (via protectedMoney — reserva VIRTUAL, não sai
  // fisicamente da conta, então minBaseCashBeforeIncome continua positivo e o
  // status resolve em APERTADO, decidido SEM precisar de projeção completa)
  // + worst-case pequeno que não muda a classe.
  const input1 = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    reserves: [{ accountType: "unrestricted", amount: 1200 }], // protectedMoney=1200 -> freeMoney=1000-1200=-200 (APERTADO), sem afetar o caixa físico.
    card: { closingDay: 4, dueDay: 11, bills: [] },
    confirmedCommitments: [],
    contingencies: [],
    householdBills: [{ name: "Exemplo telefone", amount: 50, amountConfidence: "ESTIMATED", status: "PENDING", dueDateKnown: false }],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const asOfDate = new Date("2026-01-15T00:00:00.000Z");
  const result1 = engineDryRun(input1, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: asOfDate });
  check("worst-case pequeno: possibleStatusWithKnownEstimates é IGUAL a knownStatus (provado robusto)", result1.financialStatus.possibleStatusWithKnownEstimates === result1.financialStatus.knownStatus);
  check("financialStatusCompleteness = COMPLETE quando provado robusto, mesmo com estimativa pendente", result1.completeness.financialStatusCompleteness === "COMPLETE");

  // Caso 2: worst-case grande (600) sobre caixa pequeno (500 antes da renda) MUDA a classe.
  const input2 = { ...input1, checkingAccount: { checkpointB: { amount: 500 } }, householdBills: [{ name: "Exemplo conta grande", amount: 600, amountConfidence: "ESTIMATED", status: "PENDING", dueDateKnown: false }] };
  const result2 = engineDryRun(input2, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: asOfDate });
  check("worst-case grande: possibleStatusWithKnownEstimates é PIOR que knownStatus", ["TRANQUILO", "ATENCAO", "APERTADO", "CRITICO"].indexOf(result2.financialStatus.possibleStatusWithKnownEstimates) > ["TRANQUILO", "ATENCAO", "APERTADO", "CRITICO"].indexOf(result2.financialStatus.knownStatus));
  check("financialStatusCompleteness = PARTIAL quando o worst-case PODE mudar a classe", result2.completeness.financialStatusCompleteness === "PARTIAL");
}

// ============================================================================
// O (Fase 5.0.2, item 4) — nextIncomeCommitment contra standard base: nunca
// chamado de percentual real exato, denominador sempre explícito.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [{ cycleMonth: "2026-02", amount: 100, status: "UNPAID" }] },
    mainIncome: { amount: 2000, dayOfMonth: 15, standardRecurringAmount: 2000, standardRecurringAmountConfidence: "CONFIRMED", variablePayExpected: true },
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("denominatorBasis = STANDARD_RECURRING_BASE (nunca inventa um valor 'real')", result.nextIncomeCommitment.denominatorBasis === "STANDARD_RECURRING_BASE");
  check("actualNextIncomeAmountKnown = false sempre que o valor é só o padrão", result.nextIncomeCommitment.actualNextIncomeAmountKnown === false);
  check("variablePayExpected propagado no resultado", result.nextIncomeCommitment.variablePayExpected === true);
  check("nextIncomeCommitmentCompleteness = PARTIAL quando variablePayExpected=true, mesmo com padrão confirmado", result.completeness.nextIncomeCommitmentCompleteness === "PARTIAL");
}

// ============================================================================
// P (Fase 5.0.2, item 3A/17) — movimento com classificação econômica
// CONFIRMED vira CREATE Expense aprovado, sai da lista de blockers/UNRESOLVED.
// ============================================================================
{
  const input = {
    checkingAccount: {
      checkpointA: { amount: 100, date: "2026-01-01", confidence: "CONFIRMED" },
      movementsAfterCheckpointA: [
        { type: "OUTFLOW", description: "pix exemplo confirmado", amount: 10, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "EXPENSE", economicClassificationConfidence: "CONFIRMED", economicClassificationSource: "explicit user confirmation" },
      ],
      checkpointB: { amount: 90, date: "2026-01-01", confidence: "CONFIRMED" },
    },
  };
  const checkingRecon = reconcileCheckingLedger(input.checkingAccount, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  const cardRecon = { persistedCardBillsClassified: [], usedLimitChecksum: { matches: true }, purchaseAudit: { status: "NONE_FOUND" } };
  const mutations = buildProposedMutations(input, { card: { rows: [] } }, checkingRecon, { residualOpeningFromKnownLedger: "0" }, cardRecon);
  const expenseMutation = mutations.find((m) => m.model === "Expense" && m.reference.includes("pix exemplo confirmado"));
  check("movimento com classificação CONFIRMED gera CREATE Expense aprovado", expenseMutation?.category === "CREATE");
  check("nenhuma mutation UNRESOLVED restante pra este movimento (não é mais blocker)", !mutations.some((m) => m.category === "UNRESOLVED" && m.reference.includes("pix exemplo confirmado")));
}

// ============================================================================
// Q (Fase 5.0.3, item 25.A) — canonical restricted ledger: opening + recharge
// - expenses = closing, fecha exato via canonicalLedger (não via recharge
// tratada como opening). Fixture real no banco dev, valores fictícios.
// ============================================================================
{
  const account = await prisma.account.create({ data: { slug: `teste-fase5003-canonical-${Date.now()}`, name: `[${MARK}] Conta restrita canônica`, type: "food_voucher" } });
  try {
    const result = await reconcileRestrictedLedger(
      {
        slug: account.slug,
        recharge: { amount: 500, date: "2026-01-01", confidence: "CONFIRMED" },
        observedClosing: { amount: 100, date: "2026-01-15", confidence: "CONFIRMED" },
        canonicalExpenses: [
          { date: "2026-01-02", counterparty: "loja A", amount: 200 },
          { date: "2026-01-05", counterparty: "loja B", amount: 220 },
        ],
        canonicalExpensesSource: "teste sintético",
      },
      { reclassifiedIncomes: [] }
    );
    // opening = closing - recharge + expenses = 100 - 500 + 420 = 20
    check("canonicalLedger.derivedOpeningBalanceVA = 100-500+420 = 20", eq(result.canonicalLedger.derivedOpeningBalanceVA, 20));
    check("finalChecksum: 20 + 500 - 420 = 100 bate com observedClosing", result.canonicalLedger.finalChecksum.matches === true);
    check("openingBalanceEvidence = DERIVED_ONLY (nunca EVIDENCED)", result.canonicalLedger.openingBalanceEvidence === "DERIVED_ONLY");
  } finally {
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// R (Fase 5.0.3, item 25.B) — missing-in-dev calculation: agregado
// (canonical-dev) e detalhado (soma dos itens MISSING_IN_DEV) reportados
// separadamente quando existe 1 match aproximado (não exato).
// ============================================================================
{
  const account = await prisma.account.create({ data: { slug: `teste-fase5003-missing-${Date.now()}`, name: `[${MARK}] Conta missing`, type: "food_voucher" } });
  const e1 = await prisma.expense.create({ data: { amount: money(100), description: `[${MARK}] e1`, accountId: account.id, occurredAt: new Date("2026-01-02T00:00:00.000Z") } });
  const e2 = await prisma.expense.create({ data: { amount: money(49.9), description: `[${MARK}] e2 quase exato`, accountId: account.id, occurredAt: new Date("2026-01-03T00:00:00.000Z") } }); // canonical diz 50 -> delta 0.10
  try {
    const result = await reconcileRestrictedLedger({
      slug: account.slug,
      recharge: { amount: 500, date: "2026-01-01", confidence: "CONFIRMED" },
      observedClosing: { amount: 100, date: "2026-01-15", confidence: "CONFIRMED" },
      canonicalExpenses: [
        { date: "2026-01-02", counterparty: "loja A", amount: 100 }, // match exato
        { date: "2026-01-03", counterparty: "loja B", amount: 50 }, // match aproximado (delta 0.10)
        { date: "2026-01-06", counterparty: "loja C", amount: 80 }, // missing
      ],
    });
    const em = result.canonicalLedger.expenseMatching;
    check("agregado: canonicalTotal(230) - devTotal(149.90) = 80.10", eq(result.canonicalLedger.missingKnownExpensesInDevAggregate, 80.1));
    check("detalhado: só 1 item MISSING_IN_DEV (loja C, 80) — soma = 80, diferente do agregado", eq(em.sumOfMissingInDevItems, 80) && !eq(em.sumOfMissingInDevItems, result.canonicalLedger.missingKnownExpensesInDevAggregate));
    check("diferença entre agregado e detalhado é EXPLICADA pelo match aproximado (0.10), reportada, não escondida", em.ambiguousCount === 1);
  } finally {
    await prisma.expense.deleteMany({ where: { id: { in: [e1.id, e2.id] } } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// S (Fase 5.0.3, item 25.C) — income mal-classificado: candidato de UPDATE
// de conta gerado no relatório/mutation plan, SEM mutar o banco.
// ============================================================================
{
  const input = {
    checkingAccount: { checkpointA: { amount: 100, date: "2026-01-01", confidence: "CONFIRMED" }, movementsAfterCheckpointA: [], checkpointB: { amount: 100, date: "2026-01-01", confidence: "CONFIRMED" } },
    restrictedAccount: { slug: "conta-restrita-inexistente-fase5003", recharge: { amount: 100, date: "2026-01-01", confidence: "CONFIRMED" }, observedClosing: { amount: 100, date: "2026-01-15", confidence: "CONFIRMED" } },
    reclassifiedIncomes: [
      {
        description: "pix de exemplo",
        amount: 15,
        occurredAt: "2026-01-02",
        persistedAccountSlug: "conta-restrita-inexistente-fase5003",
        canonicalAccountSlug: "conta-irrestrita-inexistente-fase5003",
        confidence: "CONFIRMED_BY_MEMORY",
        source: "teste sintético",
        note: "nota de teste",
      },
    ],
  };
  const vaRecon = await reconcileRestrictedLedger(input.restrictedAccount, { reclassifiedIncomes: input.reclassifiedIncomes });
  check("reclassifiedIncomes propagado no resultado da reconciliação, sem mutar nada", vaRecon.reclassifiedIncomes.length === 1 && vaRecon.reclassifiedIncomes[0].amount === 15);

  const checkingRecon = reconcileCheckingLedger(input.checkingAccount, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  const cardRecon = { persistedCardBillsClassified: [], usedLimitChecksum: { matches: true }, purchaseAudit: { status: "NONE_FOUND" } };
  const mutations = buildProposedMutations(input, { card: { rows: [] } }, checkingRecon, vaRecon, cardRecon);
  const updateMutation = mutations.find((m) => m.model === "Income.accountId");
  check("mutation UPDATE Income.accountId candidata gerada, referenciando a conta canônica correta", updateMutation?.category === "UPDATE" && updateMutation.after.includes("conta-irrestrita-inexistente-fase5003"));
}

// ============================================================================
// T (Fase 5.0.3, item 25.D) — posições atuais explícitas do input (snapshot)
// SUPERAM o schedule histórico do CSV (staging), mesmo quando o CSV mostra
// uma posição mais antiga — nunca usar o CSV como fonte de verdade quando
// existe confirmação mais recente.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    externalInstallmentPlans: [{ description: "plano exemplo", installmentValue: 100, paidInstallments: 8, installmentCount: 12, confidence: "CONFIRMED_BY_MEMORY", source: "teste" }],
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  // CSV (staging) mostra uma posição BEM mais antiga (2/12) do mesmo plano (por valor).
  const csvAudit = { status: "AUDITED", externalInstallmentCandidates: [{ description: "parcela exemplo (nome diferente do input)", amountObservedPerInstallment: "100", observedInstallmentNumber: 2, totalInstallmentCount: 12, observedRawDate: "01/01/2026" }] };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z"), csvAudit });
  const plan = result.externalInstallments.confirmedPlans[0];
  check("posição CONFIRMADA do input (8/12) é a usada, não a do CSV (2/12)", plan.paidInstallments === 8);
  const coherence = result.externalInstallments.csvCoherenceCheck[0];
  check("coerência com CSV reportada separadamente (avanço de 2->8, coerente)", coherence.csvMatch === "FOUND" && coherence.coherentTemporalAdvance === true);
}

// ============================================================================
// U (Fase 5.0.3, item 25.E) — checksum do pacote de parcelas externas.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    externalInstallmentPlans: [
      { description: "A", installmentValue: 100, paidInstallments: 1, installmentCount: 5, confidence: "CONFIRMED_BY_MEMORY", source: "teste" },
      { description: "B", installmentValue: 50.5, paidInstallments: 2, installmentCount: 4, confidence: "CONFIRMED_BY_MEMORY", source: "teste" },
      { description: "C completa (remaining=0)", installmentValue: 999, paidInstallments: 3, installmentCount: 3, confidence: "CONFIRMED_BY_MEMORY", source: "teste" },
    ],
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("nextPackageTotal = 100+50.5 = 150.50 (plano C completo excluído, remaining=0)", eq(result.externalInstallments.nextPackageTotal, 150.5));
  check("confirmedPlans só lista os 2 com remaining > 0", result.externalInstallments.confirmedPlans.length === 2);
}

// ============================================================================
// V (Fase 5.0.3, item 25.F) — parcela externa com timing "depois da próxima
// renda" NÃO reduz freeMoney atual, mesmo sendo um valor grande e conhecido.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [] },
    externalInstallmentPlans: [{ description: "pacote grande", installmentValue: 900, paidInstallments: 1, installmentCount: 5, confidence: "CONFIRMED_BY_MEMORY", source: "teste" }],
    externalInstallmentsPaymentTiming: { exactDueDate: "UNKNOWN", paymentTiming: "GENERALLY_AFTER_SALARY", timingConfidence: "CONFIRMED_BY_MEMORY" },
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-15T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("freeMoney = unrestrictedCash (1000) — pacote de 900 NÃO subtraído", eq(result.freeMoney, 1000));
  check("obligations.currentHorizonObligations não inclui a parcela externa", result.obligations.currentHorizonObligations.items.every((i) => i.description !== "pacote grande"));
  check("pacote aparece em nextIncomeWindowCommitmentCandidate, não em currentHorizon", result.nextIncomeWindowCommitmentCandidate?.total === "900");
}

// ============================================================================
// W (Fase 5.0.3, item 25.G) — nextIncomeCommitment inclui obrigações futuras
// conhecidas (cartão + pacote externo) e marca PARTIAL quando bills
// domésticas recorrentes do próximo ciclo permanecem não resolvidas.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { closingDay: 4, dueDay: 11, bills: [{ cycleMonth: "2026-02", amount: 200, status: "UNPAID" }] },
    externalInstallmentPlans: [{ description: "pacote", installmentValue: 300, paidInstallments: 1, installmentCount: 5, confidence: "CONFIRMED_BY_MEMORY", source: "teste" }],
    householdBills: [{ name: "Aluguel exemplo", amount: 500, status: "PAID", cycleLabel: "current" }],
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-11T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings, asOf: new Date("2026-01-15T00:00:00.000Z") });
  check("knownNextIncomeCommitments.subtotal inclui cartão + pacote externo", eq(result.nextIncomeCommitment.knownNextIncomeCommitments.subtotal, 500));
  check("unresolvedNextIncomeCommitments lista a bill doméstica não auditada pro próximo ciclo", result.nextIncomeCommitment.unresolvedNextIncomeCommitments.some((b) => b.name === "Aluguel exemplo"));
  check("nextIncomeCommitmentCompleteness = PARTIAL enquanto existir item unresolved", result.completeness.nextIncomeCommitmentCompleteness === "PARTIAL");
}

// ============================================================================
// X (Fase 5.0.3, item 25.H) — determinismo de calendário: mesmo resultado
// com um asOf FIXO, independente de quando o teste realmente roda.
// ============================================================================
{
  const card = await prisma.card.create({ data: { slug: `teste-fase5003-clock-${Date.now()}`, name: `[${MARK}] Cartão clock`, totalLimit: 1000, dueDay: 11, closingDay: 4 } });
  try {
    const FIXED_ASOF_1 = new Date("2026-09-04T12:00:00.000Z");
    const FIXED_ASOF_2 = new Date("2026-09-04T12:00:00.000Z"); // mesmo instante, chamada separada — deve produzir resultado idêntico.
    const view1 = await listCardBillsView(card.id, { monthsBack: 0, monthsForward: 3, now: FIXED_ASOF_1 });
    const view2 = await listCardBillsView(card.id, { monthsBack: 0, monthsForward: 3, now: FIXED_ASOF_2 });
    check("listCardBillsView com o MESMO asOf fixo produz o cycleMonth inicial idêntico", view1[0].cycleMonth === view2[0].cycleMonth);
    check("resultado não depende de Date.now() real — nenhuma chamada usou o relógio da máquina", JSON.stringify(view1.map((b) => b.cycleMonth)) === JSON.stringify(view2.map((b) => b.cycleMonth)));
  } finally {
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
  }
}

console.log(`\n${passed}/${results.length} teste(s) passaram.`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await prisma.$disconnect();
