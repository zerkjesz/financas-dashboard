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

console.log(`\n${passed}/${results.length} teste(s) passaram.`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await prisma.$disconnect();
