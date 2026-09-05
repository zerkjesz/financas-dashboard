// Fase 5.0 — Real Snapshot Reconciliation / Dry-Run.
//
// ESTRITAMENTE READ-ONLY. Este script NUNCA cria, atualiza, apaga ou faz upsert
// de nada no banco — só lê (findMany/findUnique/count/aggregate) e faz contas em
// memória. Ver scripts/test-snapshot-dry-run.mjs pra prova automatizada de zero
// writes + checagem estática de ausência de métodos mutantes neste arquivo.
//
// NUNCA hardcode dados financeiros reais aqui — este arquivo é genérico e
// versionado. As âncoras reais vêm de um arquivo LOCAL GITIGNORED
// (scripts/snapshot-input.local.json, nunca commitado) no formato de
// scripts/snapshot-input.example.json (esse sim, versionável, só valores
// fictícios). Uso:
//
//   node scripts/snapshot-dry-run.mjs [--input <path>] [--out <path>]
//
// --input default: scripts/snapshot-input.local.json (ao lado deste arquivo).
// --out (opcional): salva o relatório em JSON nesse caminho — deve ficar fora do
// git (ex: scripts/snapshot-reports/, já gitignored) ou fora do repo inteiramente.
// Sem --out, o relatório só é impresso no stdout.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, multiplyMoney, divideMoney, sumMoney, compareMoney, isPositive, isNegative, ZERO } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";
import { listCardBillsView } from "../lib/cardBillCalculator.js";
import { classifyCardBill, classifyConfirmedCommitment, classifyContingency, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend, isWithinNextIncomeCommitmentWindow, resolveCurrentRelevantCardBillCycleMonth } from "../lib/freeMoney.js";
import { resolveNextExpectedIncome, resolveNextExpectedIncomeFromDb } from "../lib/incomeHorizon.js";
import { minProjectedCashBefore } from "../lib/financialProjection.js";
import { computeFinancialStatus } from "../lib/financialStatus.js";
import { computeCurrentObligationHorizonEnd } from "../lib/financialEngine.js";
import { getAppSettings } from "../lib/settings.js";
import { isValidConfidence } from "../lib/dataConfidence.js";
import { computeFileHash, auditCsvRows, reconstructExternalInstallmentCandidates } from "./lib/csvStagingAudit.mjs";

// Fase 5.0.1 — três estados de completude, usados em toda parte do engine
// dry-run que depende de evidência parcial. Nunca usar um valor livre fora
// deste enum (item 10 do pedido).
export const COMPLETENESS = Object.freeze({ COMPLETE: "COMPLETE", PARTIAL: "PARTIAL", INCOMPLETE: "INCOMPLETE" });

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Todo model financeiro relevante (item 7 do pedido) — usado tanto pro
// inventário quanto pra fingerprint de zero-write (scripts/test-snapshot-dry-run.mjs).
export const INVENTORY_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment",
  "cardLimitUpdate", "purchase", "installment", "cardBill", "bill",
  "recurringRule", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment",
  "contingency", "receivable", "categoryBudget", "cardCreditMovement",
  "appSettings",
];

function parseArgs(argv) {
  const args = { input: path.join(HERE, "snapshot-input.local.json"), out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") args.input = path.resolve(argv[++i]);
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
  }
  return args;
}

export function loadSnapshotInput(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `Arquivo de input não encontrado: ${inputPath}\n` +
        "Copie scripts/snapshot-input.example.json para scripts/snapshot-input.local.json " +
        "(gitignored) e preencha com os dados reais antes de rodar o dry-run."
    );
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  validateInput(raw);
  return raw;
}

// Validação estrutural mínima — confidence precisa ser um valor válido do enum
// onde declarado; datas precisam ser strings ISO parseáveis. Não tenta validar
// TODO o schema — o objetivo é falhar cedo em erro óbvio de digitação, não
// substituir revisão humana do input.
function validateInput(input) {
  const problems = [];
  const checkConfidence = (value, label) => {
    if (value != null && !isValidConfidence(value)) problems.push(`${label}: confidence inválida "${value}"`);
  };
  const checkDate = (value, label) => {
    if (value != null && Number.isNaN(new Date(value).getTime())) problems.push(`${label}: data inválida "${value}"`);
  };

  if (!input.asOf) problems.push("asOf é obrigatório (data de referência do snapshot, formato YYYY-MM-DD)");
  checkDate(input.asOf, "asOf");

  const ck = input.checkingAccount;
  if (ck) {
    checkConfidence(ck.checkpointA?.confidence, "checkingAccount.checkpointA.confidence");
    checkConfidence(ck.checkpointB?.confidence, "checkingAccount.checkpointB.confidence");
    for (const [i, m] of (ck.movementsAfterCheckpointA || []).entries()) {
      checkConfidence(m.movementConfidence, `checkingAccount.movementsAfterCheckpointA[${i}].movementConfidence`);
      checkDate(m.date, `checkingAccount.movementsAfterCheckpointA[${i}].date`);
    }
  }
  for (const [i, c] of (input.confirmedCommitments || []).entries()) {
    checkConfidence(c.amountConfidence, `confirmedCommitments[${i}].amountConfidence`);
    checkConfidence(c.dateConfidence, `confirmedCommitments[${i}].dateConfidence`);
  }
  for (const [i, c] of (input.contingencies || []).entries()) {
    checkConfidence(c.expectedAmountConfidence, `contingencies[${i}].expectedAmountConfidence`);
    checkConfidence(c.maxAmountConfidence, `contingencies[${i}].maxAmountConfidence`);
  }

  if (problems.length > 0) {
    throw new Error(`Input inválido (${path.basename(input.__path || "input")}):\n- ${problems.join("\n- ")}`);
  }
}

function d(s) {
  if (s == null) return null;
  return new Date(`${s}T00:00:00.000Z`);
}

function normalizeForKeywordCheck(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// ============================================================================
// B. Estado atual do dev — inventário READ-ONLY (item 7)
// ============================================================================
async function buildInventory() {
  const inventory = {};
  for (const model of INVENTORY_MODELS) {
    inventory[model] = { count: await prisma[model].count() };
  }

  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  inventory.account.rows = await Promise.all(
    accounts.map(async (a) => ({
      id: a.id,
      slug: a.slug,
      type: a.type,
      currentComputedBalance: (await computeAccountBalance(a.id)).toString(),
    }))
  );

  const cards = await prisma.card.findMany();
  inventory.card.rows = cards.map((c) => ({
    id: c.id,
    slug: c.slug,
    totalLimit: c.totalLimit.toString(),
    closingDay: c.closingDay,
    dueDay: c.dueDay,
  }));

  const settings = await getAppSettings();
  inventory.appSettings.singleton = {
    id: settings.id,
    cycleStartDay: settings.cycleStartDay,
    safetyMarginPercent: settings.safetyMarginPercent,
    operationalHistoryStart: settings.operationalHistoryStart?.toISOString() ?? null,
    vaHistoryStart: settings.vaHistoryStart?.toISOString() ?? null,
  };

  const recurringRules = await prisma.recurringRule.findMany();
  inventory.recurringRule.rows = recurringRules.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    dayOfMonth: r.dayOfMonth,
    accountId: r.accountId,
    isActive: r.isActive,
    hasAmount: r.amount != null,
  }));

  return inventory;
}

// ============================================================================
// C/D/E/F/G/H/I/J — ledger de uma conta irrestrita: checkpointA ->
// movimentos confirmados -> checkpointB, delta não explicado, opening balance
// derivado vs evidenciado (itens 9/11/14).
// ============================================================================
function reconcileCheckingLedger(section, { operationalHistoryStart }) {
  if (!section) return { status: "MISSING_EVIDENCE", reason: "checkingAccount não informado no input" };

  const checkpointA = money(section.checkpointA.amount);
  const checkpointB = money(section.checkpointB.amount);
  const movements = (section.movementsAfterCheckpointA || []).map((m) => ({
    ...m,
    amountMoney: money(m.amount),
    signedAmount: m.type === "INFLOW" ? money(m.amount) : money(m.amount).negated(),
  }));

  const netMovements = sumMoney(movements.map((m) => m.signedAmount));
  const mathematicalExpected = addMoney(checkpointA, netMovements);
  const unexplainedDifference = subtractMoney(checkpointB, mathematicalExpected);

  // Opening balance: residual necessário pra fechar exatamente em checkpointB,
  // partindo do cutoff operacional — SEM afirmar que é historicamente
  // comprovado (item 11). Como não temos, neste dry-run, uma reconstrução
  // completa dia-a-dia de todos os movimentos entre o cutoff e o checkpointA,
  // o valor DERIVADO só pode ser calculado com precisão a partir do
  // checkpointA (evidência direta mais próxima do cutoff que temos) — reportado
  // explicitamente como tal, nunca como EVIDENCED.
  const derivedOpeningBalance = {
    value: null,
    basis: "checkpointA",
    note:
      "Sem uma reconstrução completa e verificada de TODOS os movimentos entre " +
      `operationalHistoryStart (${operationalHistoryStart?.toISOString?.() ?? operationalHistoryStart}) e o checkpointA, ` +
      "não é seguro derivar um saldo de abertura único — precisaria do ledger completo do período, que este dry-run não recebeu como input. " +
      "Reportado como MISSING_EVIDENCE, não inventado.",
    openingBalanceEvidence: "DERIVED_ONLY",
    status: "MISSING_EVIDENCE",
  };

  return {
    checkpointA: { amount: checkpointA.toString(), date: section.checkpointA.date, confidence: section.checkpointA.confidence, note: section.checkpointA.note ?? null },
    movements: movements.map((m) => ({
      type: m.type,
      description: m.description,
      amount: m.amountMoney.toString(),
      date: m.date,
      movementConfidence: m.movementConfidence,
      economicClassification: m.economicClassification,
      formerlyModeledAs: m.formerlyModeledAs ?? null,
    })),
    netMovements: netMovements.toString(),
    mathematicalExpected: mathematicalExpected.toString(),
    checkpointB: { amount: checkpointB.toString(), date: section.checkpointB.date, confidence: section.checkpointB.confidence },
    unexplainedDifference: unexplainedDifference.toString(),
    unexplainedDifferenceInvestigation:
      unexplainedDifference.isZero()
        ? "Nenhum delta — checkpointB bate exatamente com checkpointA + movimentos."
        : [
            "Delta NÃO explicado pelos movimentos conhecidos.",
            "Investigado e NÃO atribuído automaticamente a nenhuma causa — candidatos a investigar manualmente:",
            "outro lançamento de centavos; rendimento/juros; arredondamento; checkpointA levemente impreciso; " +
              "movimento omitido entre os checkpoints; erro de digitação; evento do banco; outra evidência.",
            "NÃO convertido em BalanceAdjustment/RECONCILIATION_ADJUSTMENT automaticamente — ver seção de mutações propostas.",
          ].join(" "),
    derivedOpeningBalance,
    finalChecksum: {
      target: checkpointB.toString(),
      formula: `${checkpointA.toString()} + (${netMovements.toString()}) = ${mathematicalExpected.toString()}`,
      matchesObserved: unexplainedDifference.isZero(),
    },
  };
}

// ============================================================================
// Fase 5.0.3, item 4 — cruza as Expenses canônicas conhecidas (evidência do
// usuário) contra as Expenses já persistidas no dev, por VALOR (a única
// dimensão confiável — datas no dev são de backfill, descrições variam).
// Casamento em duas passadas: exato primeiro, depois aproximado (tolerância
// pequena, pra sinalizar possível arredondamento/erro de digitação sem
// assumir que é a mesma transação às cegas) — nunca consome o mesmo dev
// expense duas vezes, nunca decide por conta própria quando é ambíguo.
// ============================================================================
function matchCanonicalExpenses(canonicalExpenses, devExpenses, { tolerance = 0.1 } = {}) {
  const pool = devExpenses.map((e) => ({ id: e.id, amount: money(e.amount), description: e.description, occurredAt: e.occurredAt, consumed: false }));
  const results = canonicalExpenses.map((c) => ({ canonical: c, classification: "PENDING", }));

  // Passada 1 — match exato.
  for (const r of results) {
    const cAmount = money(r.canonical.amount);
    const candidates = pool.filter((d) => !d.consumed && d.amount.eq(cAmount));
    if (candidates.length === 1) {
      candidates[0].consumed = true;
      r.classification = "ALREADY_PERSISTED";
      r.matchType = "EXACT_AMOUNT";
      r.matchedDevExpenseId = candidates[0].id;
      r.matchedDevAmount = candidates[0].amount.toString();
    } else if (candidates.length > 1) {
      r.classification = "AMBIGUOUS_MATCH";
      r.matchType = "MULTIPLE_EXACT_AMOUNT_CANDIDATES";
      r.candidateDevExpenseIds = candidates.map((d) => d.id);
    }
  }

  // Passada 2 — match aproximado (só pra quem ainda está PENDING), dentro de
  // uma tolerância pequena — sinaliza AMBIGUOUS_MATCH (nunca ALREADY_PERSISTED
  // direto), pra revisão humana explícita antes de qualquer persistência futura.
  for (const r of results) {
    if (r.classification !== "PENDING") continue;
    const cAmount = money(r.canonical.amount);
    const candidates = pool.filter((d) => !d.consumed && subtractMoney(d.amount, cAmount).abs().lte(tolerance));
    if (candidates.length === 1) {
      candidates[0].consumed = true;
      r.classification = "AMBIGUOUS_MATCH";
      r.matchType = "NEAR_AMOUNT";
      r.matchedDevExpenseId = candidates[0].id;
      r.matchedDevAmount = candidates[0].amount.toString();
      r.delta = subtractMoney(candidates[0].amount, cAmount).toString();
    } else if (candidates.length > 1) {
      r.classification = "AMBIGUOUS_MATCH";
      r.matchType = "MULTIPLE_NEAR_AMOUNT_CANDIDATES";
      r.candidateDevExpenseIds = candidates.map((d) => d.id);
    } else {
      r.classification = "MISSING_IN_DEV";
    }
  }

  const unmatchedDevExpenses = pool.filter((d) => !d.consumed).map((d) => ({ id: d.id, amount: d.amount.toString(), description: d.description, occurredAt: d.occurredAt.toISOString() }));
  const missingItems = results.filter((r) => r.classification === "MISSING_IN_DEV");
  const ambiguousItems = results.filter((r) => r.classification === "AMBIGUOUS_MATCH");
  return {
    matches: results.map((r) => ({
      date: r.canonical.date,
      counterparty: r.canonical.counterparty,
      amount: money(r.canonical.amount).toString(),
      classification: r.classification,
      matchType: r.matchType ?? null,
      matchedDevExpenseId: r.matchedDevExpenseId ?? null,
      matchedDevAmount: r.matchedDevAmount ?? null,
      delta: r.delta ?? null,
      candidateDevExpenseIds: r.candidateDevExpenseIds ?? null,
    })),
    unmatchedDevExpenses,
    sumOfMissingInDevItems: sumMoney(missingItems.map((r) => money(r.canonical.amount))).toString(),
    ambiguousCount: ambiguousItems.length,
    ambiguousItemsNote:
      ambiguousItems.length > 0
        ? `${ambiguousItems.length} item(ns) casado(s) por valor APROXIMADO (dentro de ${tolerance}), não exato — revisar manualmente antes de qualquer CREATE/dedup real.`
        : "Nenhum match ambíguo — todos os itens casados foram por valor exato.",
  };
}

// ============================================================================
// Fase 5.1A, itens 2-3 — resolve cada match AMBIGUOUS_MATCH/NEAR_AMOUNT em
// DOIS cenários nomeados explícitos (nunca decide silenciosamente qual valor
// está certo): Cenário A (o valor CANÔNICO está certo — o dev precisaria de
// UPDATE) e Cenário B (o valor PERSISTIDO está certo — KEEP, a lista
// canônica tinha um erro de transcrição/arredondamento). Genérico: funciona
// pra qualquer número de ambiguidades near-amount, não só uma.
// ============================================================================
function buildCentLevelScenarios(canonicalExpenses, expenseMatching, { recharge, observedClosing }) {
  const nearAmountAmbiguities = (expenseMatching?.matches || []).filter((m) => m.classification === "AMBIGUOUS_MATCH" && m.matchType === "NEAR_AMOUNT");
  if (nearAmountAmbiguities.length === 0) return { status: "NO_CENT_LEVEL_AMBIGUITY" };

  function computeScenario(expensesOverride) {
    const total = sumMoney(expensesOverride.map((e) => money(e.amount)));
    const netMovements = subtractMoney(money(recharge), total);
    const derivedOpening = addMoney(subtractMoney(money(observedClosing), money(recharge)), total);
    const checksum = subtractMoney(addMoney(derivedOpening, money(recharge)), total);
    return {
      canonicalExpensesTotal: total.toString(),
      derivedOpeningBalanceVA: derivedOpening.toString(),
      finalChecksum: { formula: `${derivedOpening.toString()} + ${money(recharge).toString()} - ${total.toString()} = ${checksum.toString()}`, target: money(observedClosing).toString(), matches: compareMoney(checksum, money(observedClosing)) === 0 },
    };
  }

  const scenarios = nearAmountAmbiguities.map((amb) => {
    const canonicalAmount = money(amb.amount);
    const devAmount = money(amb.matchedDevAmount);

    const scenarioACanonicalCorrect = canonicalExpenses; // já usa o valor canônico como está.
    const scenarioBDevCorrect = canonicalExpenses.map((e) => (e.counterparty === amb.counterparty && e.date === amb.date ? { ...e, amount: Number(devAmount.toString()) } : e));

    return {
      item: { date: amb.date, counterparty: amb.counterparty, canonicalAmount: canonicalAmount.toString(), persistedDevAmount: devAmount.toString(), delta: amb.delta, matchedDevExpenseId: amb.matchedDevExpenseId },
      scenarioA_canonicalIsCorrect: {
        description: `R$${canonicalAmount.toString()} (canônico) está correto`,
        ...computeScenario(scenarioACanonicalCorrect),
        devExpenseAction: `UPDATE amount ${devAmount.toString()} -> ${canonicalAmount.toString()} (id=${amb.matchedDevExpenseId}) — NÃO é KEEP neste cenário.`,
      },
      scenarioB_devIsCorrect: {
        description: `R$${devAmount.toString()} (persistido no dev) está correto`,
        ...computeScenario(scenarioBDevCorrect),
        devExpenseAction: `KEEP (id=${amb.matchedDevExpenseId}, amount=${devAmount.toString()}) — a lista canônica tinha um erro de transcrição/arredondamento neste item.`,
      },
    };
  });

  return {
    status: "UNRESOLVED_CENT_LEVEL_DEPENDENCY",
    ambiguities: scenarios,
    note: "O manifesto NÃO pode aprovar uma âncora de abertura (opening anchor) enquanto esta dependência não for resolvida pelo usuário — ver VA_OPENING_ANCHOR=UNRESOLVED_CENT_LEVEL_DEPENDENCY no manifesto final.",
  };
}

// ============================================================================
// Fase 5.1A, itens 6-9 — reconstrói o ledger OPERACIONAL do Itaú entre
// operationalHistoryStart (24/08) e checkpointA (04/09), a partir de uma
// lista de movimentos candidatos (evidência conversacional anterior — valores
// e ordem aproximada, NUNCA datas exatas inventadas). Classifica cada
// movimento semanticamente (nunca tudo vira Expense) e deriva o opening
// balance operacional — sempre DERIVED_ONLY, nunca confundido com saldo
// comprovado por extrato.
// ============================================================================
function reconcileItauOperationalLedger(operationalHistoryEvidence, { checkpointA, operationalHistoryStart }) {
  if (!operationalHistoryEvidence?.operationalLedgerCandidates) return { status: "NOT_PROVIDED" };

  const movements = operationalHistoryEvidence.operationalLedgerCandidates.map((m) => ({ ...m, amountMoney: money(m.amount) }));
  const netOperationalMovements = sumMoney(movements.map((m) => m.amountMoney));
  const derivedOpeningBalanceItau = subtractMoney(money(checkpointA), netOperationalMovements);

  const semanticBreakdown = {};
  for (const m of movements) {
    semanticBreakdown[m.semanticHint] = addMoney(semanticBreakdown[m.semanticHint] ?? ZERO, m.amountMoney);
  }

  const evidenced20Aug = operationalHistoryEvidence.evidenced20Aug;
  const gapVsEvidenced20Aug = evidenced20Aug ? subtractMoney(derivedOpeningBalanceItau, money(evidenced20Aug.amount)) : null;

  return {
    status: "PROVIDED",
    operationalHistoryStart: operationalHistoryStart?.toISOString?.() ?? operationalHistoryStart,
    checkpointA: money(checkpointA).toString(),
    movementCount: movements.length,
    movements: movements.map((m) => ({ amount: m.amountMoney.toString(), description: m.description, semanticHint: m.semanticHint, note: m.note ?? null, settlesPlan: m.settlesPlan ?? null, settlesPlans: m.settlesPlans ?? null, settlesCardBillCycleMonth: m.settlesCardBillCycleMonth ?? null })),
    netOperationalMovements: netOperationalMovements.toString(),
    semanticBreakdown: Object.fromEntries(Object.entries(semanticBreakdown).map(([k, v]) => [k, v.toString()])),
    derivedOpeningBalanceItau: derivedOpeningBalanceItau.toString(),
    openingBalanceEvidence: "DERIVED_ONLY",
    datesNote: operationalHistoryEvidence.datesNote || "Datas individuais não fornecidas com confiança suficiente — apenas valor e ordem aproximada são evidência.",
    evidenced20Aug: evidenced20Aug ?? null,
    gapVsEvidenced20Aug: gapVsEvidenced20Aug?.toString() ?? null,
    gapNote: gapVsEvidenced20Aug != null ? "Diferença entre o derived opening (24/08) e o saldo evidenciado em 20/08 — fora do cutoff operacional, NÃO preenchida com movimentos inventados entre 21-23/08." : null,
  };
}

// ============================================================================
// K/L/M — ledger da conta restrita: recharge -> observedClosing.
//
// Fase 5.0.1, item 1 — CORREÇÃO CONCEITUAL: o valor da recarga NUNCA é o
// "opening balance" (são conceitos diferentes — a recarga é um INFLOW
// conhecido, não um saldo de abertura). O residual da equação
// `opening + recharge - knownExpenses = observedClosing` é reportado como
// INDETERMINATE quando não há evidência independente do saldo imediatamente
// anterior à recarga — um residual não-zero é tratado como sinal de que o
// ledger conhecido está INCOMPLETO, nunca como prova de que a conta esteve
// negativa.
// ============================================================================
async function reconcileRestrictedLedger(section, { reclassifiedIncomes = [] } = {}) {
  if (!section) return { status: "MISSING_EVIDENCE", reason: "restrictedAccount não informado no input" };

  const recharge = money(section.recharge.amount);
  const observedClosing = money(section.observedClosing.amount);

  // Consumo real conhecido no banco (Expense na conta restrita, desde a data
  // da recarga) — read-only, só pra tentar explicar a diferença, nunca pra
  // ajustar automaticamente.
  let knownConsumption = null;
  let account = null;
  let reviewCandidates = [];
  if (section.slug) {
    account = await prisma.account.findUnique({ where: { slug: section.slug } });
    if (account) {
      const rechargeDate = d(section.recharge.date);
      const [expenses, incomesInAccount] = await Promise.all([
        prisma.expense.findMany({ where: { accountId: account.id, occurredAt: { gte: rechargeDate } }, orderBy: { occurredAt: "asc" } }),
        prisma.income.findMany({ where: { accountId: account.id, occurredAt: { gte: rechargeDate } }, orderBy: { occurredAt: "asc" } }),
      ]);
      knownConsumption = {
        count: expenses.length,
        total: sumMoney(expenses.map((e) => e.amount)).toString(),
        items: expenses.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          amount: e.amount.toString(),
          description: e.description,
          category: e.category,
          source: e.source,
          confidence: e.confidence,
        })),
      };

      // --- Review candidates (item 3) — heurística SÓ pra apontar, nunca pra mutar. ---

      // (a) Toda a atividade conhecida da conta restrita no período está
      // concentrada num único timestamp de poucos minutos? Sinal de backfill em
      // lote (o usuário digitou vários dias de gasto de uma vez), não um
      // registro contínuo — explica por que pode haver gasto real não
      // logado nos dias sem nenhuma entrada.
      const allTimestamps = [...expenses, ...incomesInAccount].map((r) => r.occurredAt.getTime()).sort((a, b) => a - b);
      if (allTimestamps.length > 1) {
        const spanMinutes = (allTimestamps[allTimestamps.length - 1] - allTimestamps[0]) / 60000;
        const daysSinceRecharge = (observedClosing && rechargeDate) ? (d(section.observedClosing.date) - rechargeDate) / (24 * 60 * 60 * 1000) : null;
        if (spanMinutes < 30 && daysSinceRecharge != null && daysSinceRecharge > 3) {
          reviewCandidates.push({
            kind: "BATCH_BACKFILL_PATTERN",
            description: `Todos os ${allTimestamps.length} registros conhecidos da conta desde a recarga foram lançados dentro de uma janela de ~${spanMinutes.toFixed(1)} minutos, cobrindo um período de ~${daysSinceRecharge.toFixed(1)} dias.`,
            implication: "Padrão típico de lançamento retroativo em lote (o usuário registrou vários dias de uma vez). Dias fora dessa janela podem ter gasto real nunca lançado — plausível explicação para um residual não-zero, não evidência de erro no ledger.",
          });
        }
      }

      // (b) Income não-recarga creditado na conta restrita (ex: um P2P que
      // "sobrou" na conta errada) — economicamente atípico pra uma conta
      // food-voucher, vale reportar como candidato de revisão.
      const rechargeAmountStr = recharge.toString();
      for (const inc of incomesInAccount) {
        if (compareMoney(money(inc.amount), recharge) !== 0) {
          reviewCandidates.push({
            kind: "UNEXPECTED_INCOME_IN_RESTRICTED_ACCOUNT",
            description: `Income de ${inc.amount.toString()} ("${inc.description}") creditado na conta restrita em ${inc.occurredAt.toISOString()}, valor diferente da recarga (${rechargeAmountStr}).`,
            implication: "Verificar se esse crédito é uma recarga extra legítima ou um lançamento que deveria ter ido para outra conta.",
          });
        }
      }

      // (c) A própria recarga: o Income persistido bate em DATA com o que o
      // input declarou? (achado real: pode ter sido lançada com occurredAt de
      // um dia de backfill, não do dia real da recarga.)
      const persistedRecharge = incomesInAccount.find((i) => compareMoney(money(i.amount), recharge) === 0);
      if (persistedRecharge) {
        const persistedDate = persistedRecharge.occurredAt.toISOString().slice(0, 10);
        if (persistedDate !== section.recharge.date) {
          reviewCandidates.push({
            kind: "RECHARGE_DATE_MISMATCH",
            description: `Income de ${rechargeAmountStr} persistido no banco tem occurredAt=${persistedDate}, diferente da data declarada no input (${section.recharge.date}).`,
            implication: "occurredAt provavelmente reflete a data do LANÇAMENTO (backfill via bot), não a data real do evento — não afeta o valor, mas explica por que filtros por data podem excluir/incluir a linha errada.",
          });
        }
      } else {
        reviewCandidates.push({
          kind: "RECHARGE_NOT_FOUND_AS_INCOME",
          description: `Nenhum Income de valor ${rechargeAmountStr} encontrado na conta restrita — a recarga declarada no input não tem um registro correspondente óbvio no banco.`,
          implication: "Pode ser que a recarga nunca tenha sido lançada, ou tenha sido lançada com valor/conta diferentes — precisa revisão manual.",
        });
      }

      // (d) Expense com descrição de conta restrita (palavras-chave) lançado
      // em OUTRA conta — cruza against TODAS as contas, não só a restrita.
      const misclassifiedCandidates = await prisma.expense.findMany({
        where: { accountId: { not: account.id }, description: { contains: section.restrictedKeyword || "vale aliment", mode: "insensitive" } },
      });
      for (const e of misclassifiedCandidates) {
        reviewCandidates.push({
          kind: "POSSIBLE_MISCLASSIFIED_EXPENSE",
          description: `Expense ${e.id} ("${e.description.slice(0, 80)}") menciona a conta restrita mas está lançado em outra Account (accountId=${e.accountId}).`,
          implication: "Se for de fato um gasto da conta restrita lançado na conta errada, isso NÃO afeta o residual desta reconciliação (o gasto já está contado em algum lugar), mas indica erro de classificação a corrigir separadamente.",
        });
      }
    }
  }

  // Fase 5.0.2, item 1 — SEPARA dois cenários. A Fase 5.0.1 cometeu o erro de
  // excluir silenciosamente qualquer Income que não batesse com o valor da
  // recarga (o R$22 "extra" nunca entrava na conta). O cenário RAW (tudo que
  // está de fato persistido, sem excluir nada) é o PRINCIPAL — o hipotético
  // (excluindo o income não-recarga) só é reportado como o que SERIA se esse
  // income se provar mal-classificado, nunca como o número padrão.
  const allKnownIncomeTotal = section.slug ? sumMoney((await prisma.income.findMany({ where: { accountId: account?.id, occurredAt: { gte: d(section.recharge.date) } } })).map((i) => i.amount)) : null;
  const knownExpensesTotal = knownConsumption != null ? money(knownConsumption.total) : null;

  const rawKnownPersistedNetMovements = allKnownIncomeTotal != null && knownExpensesTotal != null ? subtractMoney(allKnownIncomeTotal, knownExpensesTotal) : null;
  const rawUnexplainedDifference = rawKnownPersistedNetMovements != null ? subtractMoney(observedClosing, rawKnownPersistedNetMovements) : null;

  const hypotheticalNetMovementsExcludingNonRechargeIncome = knownExpensesTotal != null ? subtractMoney(recharge, knownExpensesTotal) : null;
  const adjustedDifferenceIf22IncomeIsMisclassified =
    hypotheticalNetMovementsExcludingNonRechargeIncome != null ? subtractMoney(observedClosing, hypotheticalNetMovementsExcludingNonRechargeIncome) : null;

  // Item 2 — investiga CADA Income não-recarga persistido na conta restrita,
  // sem mutar nada. Heurística genérica (nunca hardcoded a um valor
  // específico): a esmagadora maioria dos lançamentos LEGÍTIMOS desta conta
  // menciona a palavra-chave da conta restrita na descrição (ex: "vale
  // alimentação") — um Income que NÃO menciona, num universo onde os outros
  // mencionam, é um sinal real (não prova) de possível classificação errada.
  const nonRechargeIncomeInvestigation = [];
  if (account) {
    const restrictedKeyword = section.restrictedKeyword || "vale aliment";
    const allAccountRecords = [...(knownConsumption?.items ?? [])];
    const allIncomesInWindow = await prisma.income.findMany({ where: { accountId: account.id, occurredAt: { gte: d(section.recharge.date) } }, orderBy: { occurredAt: "asc" } });
    const totalWithKeyword = [...allAccountRecords, ...allIncomesInWindow].filter((r) => normalizeForKeywordCheck(r.description).includes(normalizeForKeywordCheck(restrictedKeyword))).length;
    const totalRecords = allAccountRecords.length + allIncomesInWindow.length;
    for (const inc of allIncomesInWindow) {
      if (compareMoney(money(inc.amount), recharge) === 0) continue; // é a própria recarga, não "não-recharge".
      const mentionsKeyword = normalizeForKeywordCheck(inc.description).includes(normalizeForKeywordCheck(restrictedKeyword));
      let classification = "UNKNOWN";
      const reasons = [];
      if (!mentionsKeyword && totalRecords > 0 && totalWithKeyword / totalRecords > 0.5) {
        classification = "LIKELY_MISCLASSIFIED";
        reasons.push(`${totalWithKeyword} de ${totalRecords} outros registros conhecidos desta conta mencionam "${restrictedKeyword}" na descrição — este NÃO menciona, sinal (não prova) de que pode ter caído na conta errada.`);
      } else if (mentionsKeyword) {
        classification = "LIKELY_CORRECT";
        reasons.push(`Descrição menciona "${restrictedKeyword}", consistente com os demais lançamentos legítimos desta conta.`);
      } else {
        reasons.push("Sem sinal suficiente (nem a favor, nem contra) — permanece UNKNOWN.");
      }
      nonRechargeIncomeInvestigation.push({
        id: inc.id,
        description: inc.description,
        occurredAt: inc.occurredAt.toISOString(),
        accountId: inc.accountId,
        category: inc.category,
        source: inc.source,
        confidence: inc.confidence,
        createdAt: inc.createdAt.toISOString(),
        amount: inc.amount.toString(),
        classification,
        reasons,
      });
    }
  }

  const unexplainedMagnitude = rawUnexplainedDifference != null ? rawUnexplainedDifference.abs() : null;

  // ==========================================================================
  // Fase 5.0.3, itens 1-4 — CANONICAL LEDGER: constrói a partir de evidência
  // conversacional anterior do usuário (section.canonicalExpenses), não do
  // que está persistido no dev. Este é o cenário PRINCIPAL desta fase — o
  // "raw persisted dev ledger" acima vira só um diagnóstico de quanto do
  // canônico já está no banco, nunca mais a fonte de verdade da reconciliação.
  // ==========================================================================
  let canonicalLedger = { status: "NOT_PROVIDED" };
  let expenseMatching = null;
  if (Array.isArray(section.canonicalExpenses) && section.canonicalExpenses.length > 0) {
    const canonicalExpensesTotal = sumMoney(section.canonicalExpenses.map((e) => money(e.amount)));
    const canonicalNetMovements = subtractMoney(recharge, canonicalExpensesTotal);
    // opening + recharge - canonicalExpenses = observedClosing
    // => opening = observedClosing - recharge + canonicalExpensesTotal
    const derivedOpeningBalanceVA = addMoney(subtractMoney(observedClosing, recharge), canonicalExpensesTotal);
    // Recomputa closing a partir do opening derivado — deve bater exatamente
    // com observedClosing por construção; serve como prova visível no
    // relatório, não como um cálculo independente.
    const checksumRecomputedClosing = subtractMoney(addMoney(derivedOpeningBalanceVA, recharge), canonicalExpensesTotal);
    const missingKnownExpensesInDevAggregate = knownExpensesTotal != null ? subtractMoney(canonicalExpensesTotal, knownExpensesTotal) : null;

    if (account) {
      // Mesma janela do resto da reconciliação (desde a recarga) — cruzar
      // contra TODO o histórico da conta misturaria o ciclo anterior (pré-21/08)
      // e causaria ambiguidade artificial (ex: dois Expenses de mesmo valor em
      // ciclos diferentes parecendo candidatos do MESMO item canônico).
      const devExpensesForMatching = await prisma.expense.findMany({ where: { accountId: account.id, occurredAt: { gte: d(section.recharge.date) } }, orderBy: { occurredAt: "asc" } });
      expenseMatching = matchCanonicalExpenses(section.canonicalExpenses, devExpensesForMatching);
    }

    canonicalLedger = {
      status: "PROVIDED",
      source: section.canonicalExpensesSource || "prior user-provided financial reconstruction",
      canonicalExpensesCount: section.canonicalExpenses.length,
      canonicalExpensesTotal: canonicalExpensesTotal.toString(),
      canonicalNetMovements: canonicalNetMovements.toString(),
      derivedOpeningBalanceVA: derivedOpeningBalanceVA.toString(),
      openingBalanceEvidence: "DERIVED_ONLY",
      openingBalanceNote:
        "Representa saldo CARREGADO antes da recarga (carryover), não uma despesa/receita do ciclo. NÃO inventar uma transação — é só o residual matemático necessário pra fechar a equação. Se a arquitetura futura exigir uma âncora, a forma mínima correta seria um BalanceAdjustment com confidence=RECONCILIATION_ADJUSTMENT — não executado nesta fase.",
      finalChecksum: {
        formula: `${derivedOpeningBalanceVA.toString()} + ${recharge.toString()} - ${canonicalExpensesTotal.toString()} = ${checksumRecomputedClosing.toString()}`,
        target: observedClosing.toString(),
        matches: compareMoney(checksumRecomputedClosing, observedClosing) === 0,
      },
      missingKnownExpensesInDevAggregate: missingKnownExpensesInDevAggregate?.toString() ?? null,
      expenseMatching,
    };
  }

  // Item 5 — Income(s) que evidência anterior confirma NÃO pertencerem a esta
  // conta restrita: excluídos do cálculo RAW também agora que a
  // classificação é CONFIRMED_BY_MEMORY (não mais só uma heurística) —
  // reportados aqui, NUNCA mutados.
  const reclassifiedIncomesForThisAccount = (reclassifiedIncomes || []).filter((r) => r.persistedAccountSlug === section.slug);

  return {
    account: account ? { id: account.id, slug: account.slug } : { status: "NOT_FOUND_IN_DB", slugSearched: section.slug ?? null },
    recharge: { amount: recharge.toString(), date: section.recharge.date, confidence: section.recharge.confidence },
    observedClosing: { amount: observedClosing.toString(), date: section.observedClosing.date, confidence: section.observedClosing.confidence },
    knownConsumptionFoundInDb: knownConsumption,
    nonRechargeIncomeInvestigation,
    reclassifiedIncomes: reclassifiedIncomesForThisAccount,
    // Item 1A — RAW PERSISTED DEV LEDGER: só o que está no banco hoje — usado
    // como DIAGNÓSTICO (quanto do canônico já foi persistido), nunca mais
    // como a reconciliação principal a partir da Fase 5.0.3 (ver canonicalLedger).
    rawPersistedLedger: {
      allKnownIncomeTotal: allKnownIncomeTotal?.toString() ?? null,
      knownExpensesTotal: knownExpensesTotal?.toString() ?? null,
      knownPersistedNetMovements: rawKnownPersistedNetMovements?.toString() ?? null,
      rawUnexplainedDifference: rawUnexplainedDifference?.toString() ?? null,
      note: "PERSISTED_DEV_LEDGER — reflete só o que está gravado no banco dev hoje, sabidamente incompleto. Não é mais a reconciliação principal (ver canonicalLedger).",
    },
    // Item 1B (Fase 5.0.2, mantido por histórico) — hipotético baseado só na
    // exclusão do income não-recarga, SEM a lista canônica de expenses. A
    // Fase 5.0.3 supera isso com canonicalLedger, que já incorpora ambos os
    // ajustes (expenses canônicas + exclusão do income reclassificado).
    hypotheticalReclassifiedLedger: {
      note: "SUPERADO por canonicalLedger (Fase 5.0.3) — mantido só por histórico/comparação.",
      knownNetMovementsExcludingNonRechargeIncome: hypotheticalNetMovementsExcludingNonRechargeIncome?.toString() ?? null,
      adjustedDifferenceIf22IncomeIsMisclassified: adjustedDifferenceIf22IncomeIsMisclassified?.toString() ?? null,
    },
    // Item 1A/2/3 — KNOWN_CANONICAL_LEDGER: fonte de verdade PRINCIPAL desta
    // fase, construída a partir de evidência conversacional anterior do
    // usuário (canonicalExpenses), não do que está persistido no dev.
    canonicalLedger,
    // Nomenclatura corrigida: NUNCA "derivedOpeningBalance = recharge". Usa o
    // canônico quando disponível; cai pro RAW (Fase 5.0.1/2) só se a lista
    // canônica não foi informada nesta rodada.
    knownNetMovements: canonicalLedger.status === "PROVIDED" ? canonicalLedger.canonicalNetMovements : rawKnownPersistedNetMovements?.toString() ?? null,
    residualOpeningFromKnownLedger: canonicalLedger.status === "PROVIDED" ? "0" : rawUnexplainedDifference?.toString() ?? null,
    derivedOpeningBalance: canonicalLedger.status === "PROVIDED" ? canonicalLedger.derivedOpeningBalanceVA : "INDETERMINATE",
    unexplainedOutflowsOrMissingEvidence: canonicalLedger.status === "PROVIDED" ? "0" : unexplainedMagnitude?.toString() ?? null,
    openingBalanceEvidence: canonicalLedger.status === "PROVIDED" ? "DERIVED_ONLY" : "MISSING",
    // Mantido só por compatibilidade de leitura do relatório anterior.
    unexplainedDifferenceVA: canonicalLedger.status === "PROVIDED" ? "0" : rawUnexplainedDifference?.toString() ?? null,
    reviewCandidates,
    investigationNote:
      canonicalLedger.status === "PROVIDED"
        ? `Reconciliação CANÔNICA fecha exatamente (checksum=${canonicalLedger.finalChecksum.matches}) usando a lista de expenses conhecidas do usuário — o delta que antes aparecia como "não explicado" (RAW, ver rawPersistedLedger) era, em grande parte, o dev estando incompleto (missingKnownExpensesInDevAggregate=${canonicalLedger.missingKnownExpensesInDevAggregate}), não falta de evidência financeira real. O resíduo de abertura (derivedOpeningBalanceVA) é DERIVED_ONLY, não uma transação inventada.`
        : rawUnexplainedDifference != null && !rawUnexplainedDifference.isZero()
          ? "Ledger conhecido (RAW, incluindo TODO Income persistido, sem excluir nada) está INCOMPLETO — o residual NÃO deve ser interpretado como a conta tendo ficado negativa, e sim como evidência de gasto/movimento real ainda não lançado no banco dev (ou lançado fora da janela consultada). " +
            "NÃO convertido em ajuste automaticamente. Ver reviewCandidates e nonRechargeIncomeInvestigation para achados concretos desta investigação."
          : "N/A — sem base de comparação suficiente (nenhuma Expense encontrada na conta) ou diferença zero.",
    externalSourceInvestigation: {
      searchedRepositoryForCsv: true,
      csvFoundInRepository: false,
      // Item 4 — distinção explícita exigida: a AUSÊNCIA de um CSV no
      // repositório não é prova de que a evidência não existe em lugar nenhum
      // (extrato do app do vale-refeição, e-mail, notificação no celular do
      // usuário — fora do alcance desta ferramenta e deste repositório).
      classification: "MISSING_EXTERNAL_SOURCE_FILE",
      note:
        "NOT_IN_REPOSITORY != EVIDENCE_DOES_NOT_EXIST. Nenhum arquivo .csv foi encontrado no repositório local, mas isso não fecha o caso — " +
        "um extrato do provedor do vale-refeição (app/e-mail/notificação) pode existir fora do alcance desta ferramenta e precisa ser " +
        "disponibilizado antes de considerar a reconciliação da conta restrita definitivamente concluída.",
    },
  };
}

// ============================================================================
// Confirma no schema (read-only, lê o arquivo .prisma) a constraint real de
// unicidade de CardBill — item 6 do pedido. Nunca assume; sempre relê o
// arquivo, então uma mudança de schema futura quebra esta checagem em vez de
// silenciosamente mentir sobre a constraint.
// ============================================================================
function confirmCardBillUniqueConstraint() {
  const schemaPath = path.join(HERE, "..", "prisma", "schema.prisma");
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const modelMatch = schemaText.match(/model CardBill \{[\s\S]*?\n\}/);
  const modelText = modelMatch ? modelMatch[0] : "";
  const uniqueMatch = modelText.match(/@@unique\(\[([^\]]+)\]\)/);
  const fields = uniqueMatch ? uniqueMatch[1].split(",").map((s) => s.trim()) : [];
  return {
    confirmed: fields.length > 0,
    fields,
    isCardIdCycleMonth: fields.length === 2 && fields.includes("cardId") && fields.includes("cycleMonth"),
    implication:
      fields.includes("cardId") && fields.includes("cycleMonth")
        ? "No máximo UMA CardBill por (cardId, cycleMonth). Uma correção pra um ciclo que já tem row persistida é NECESSARIAMENTE um UPDATE — propor CREATE ali colidiria com a constraint e falharia (ou seria um bug de modelagem se contornado)."
        : "Constraint não encontrada como esperado — revisar manualmente antes de propor qualquer mutação de CardBill.",
  };
}

// ============================================================================
// Fase 5.1A, item 12 — lê lib/externalInstallments.js (read-only, só leitura
// de arquivo) e confirma por evidência de código (não por suposição) a
// semântica real de settlement: (A) markExternalInstallmentPaid cria
// Expense? (B) ExternalInstallment é só obligation-state? (C) como o saldo
// da conta é reduzido? (D) qual a relação Expense<->ExternalInstallment?
// ============================================================================
function auditExternalInstallmentSettlementSemantics() {
  const libPath = path.join(HERE, "..", "lib", "externalInstallments.js");
  const source = fs.readFileSync(libPath, "utf8");
  const markPaidMatch = source.match(/export async function markExternalInstallmentPaid[\s\S]*?\n}/);
  const markPaidBody = markPaidMatch ? markPaidMatch[0] : "";

  const createsExpenseInsideMarkPaid = /tx\.expense\.create|prisma\.expense\.create/.test(markPaidBody);
  const expenseIdIsOptionalParam = /\{\s*expenseId,\s*paidAt\s*\}\s*=\s*\{\}/.test(markPaidBody) || /expenseId\s*\|\|\s*null/.test(markPaidBody);
  const statusFieldOnly = /data:\s*\{\s*status:\s*"PAID",\s*paidAt:.*expenseId:/.test(markPaidBody.replace(/\s+/g, " "));

  const schemaPath = path.join(HERE, "..", "prisma", "schema.prisma");
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const modelMatch = schemaText.match(/model ExternalInstallment \{[\s\S]*?\n\}/);
  const expenseIdUnique = /expenseId\s+String\?\s+@unique/.test(modelMatch?.[0] ?? "");

  return {
    sourceFile: "lib/externalInstallments.js",
    question_A_marksPaidAlsoCreatesExpense: createsExpenseInsideMarkPaid,
    evidence_A: createsExpenseInsideMarkPaid
      ? "markExternalInstallmentPaid CRIA um Expense internamente."
      : "markExternalInstallmentPaid NÃO cria Expense — só ATUALIZA a própria ExternalInstallment (status: 'PAID', paidAt, expenseId) via prisma.externalInstallment, sem tocar em Expense. `expenseId` é OPCIONAL e vem de fora (o caller já deve ter criado o Expense antes, se aplicável).",
    question_B_isOnlyObligationState: statusFieldOnly,
    evidence_B: "O update só toca `status`/`paidAt`/`expenseId` — nenhum campo monetário de saldo é lido/escrito aqui. ExternalInstallment é puramente estado de obrigação (PENDING/PAID), nunca a fonte do efeito de caixa.",
    question_C_howAccountBalanceIsReduced: "Via Expense normal (lib/accounts.js:computeAccountBalance soma Expense por accountId/occurredAt) — o mesmo mecanismo de QUALQUER outro gasto. externalInstallments.js não implementa nenhuma lógica de saldo própria.",
    question_D_relationshipExpenseToExternalInstallment: {
      expenseIdOptional: expenseIdIsOptionalParam,
      expenseIdUniqueInSchema: expenseIdUnique,
      relationship: "1:1 OPCIONAL — um Expense pode estar linkado a NO MÁXIMO uma ExternalInstallment (constraint @unique), mas uma ExternalInstallment pode estar PAID com expenseId=null (documentado no schema pra parcela paga antes do início do histórico operacional).",
    },
    conclusion: {
      canRepresentOnePaymentSettlingMultipleInstallments: true,
      how:
        "Quando UM pagamento real (ex: pix de R$1.050,59) quita a parcela corrente de VÁRIOS planos simultaneamente, o schema já suporta isso SEM alteração: criar UM Expense (o fato de caixa, uma vez só) e linkar `expenseId` em NO MÁXIMO UMA das ExternalInstallment correspondentes (a constraint @unique não permite mais que isso) — as OUTRAS ficam PAID com expenseId=null, exatamente como o schema já permite pra pagamentos pré-histórico operacional. Isso evita: débito duplicado (Expense criado só 1x), Expense duplicado (idem), e parcela pendente (todas ficam PAID independentemente do link).",
      noSchemaChangeNeeded: true,
    },
  };
}

// ============================================================================
// Auditoria read-only da(s) Purchase existente(s) contra os valores de fatura
// conhecidos (item 5 do pedido). Genérica: cruza QUALQUER Purchase do cartão
// informado contra QUALQUER known bill do input — não assume nada sobre
// descrição/nome específico.
// ============================================================================
async function auditPurchasesAgainstKnownBills(cardInput, knownBillsByMonth, csvAudit) {
  if (!cardInput?.slug) return { status: "MISSING_EVIDENCE", reason: "card.slug não informado — não é possível localizar Purchase" };

  const card = await prisma.card.findUnique({ where: { slug: cardInput.slug } });
  if (!card) return { status: "NOT_FOUND_IN_DB", slugSearched: cardInput.slug };

  const purchases = await prisma.purchase.findMany({
    where: { cardId: card.id },
    include: { installments: { orderBy: { number: "asc" } } },
    orderBy: { purchasedAt: "asc" },
  });

  const purchaseAudits = purchases.map((p) => {
    const installmentsByMonth = new Map(p.installments.map((i) => [i.billMonth, i]));
    const monthsOccupied = p.installments.map((i) => i.billMonth);

    // B) Explica o(s) componente(s) recorrente(s) dos known bills? Cruza CADA
    // parcela contra o valor conhecido do mesmo cycleMonth, se houver.
    const explainsComponent = [];
    for (const inst of p.installments) {
      const known = knownBillsByMonth.get(inst.billMonth);
      if (known == null) continue;
      const instAmount = money(inst.amount);
      explainsComponent.push({
        billMonth: inst.billMonth,
        installmentAmount: instAmount.toString(),
        knownBillTotal: known.toString(),
        exactMatch: compareMoney(instAmount, known) === 0,
        explainsPartial: compareMoney(instAmount, known) < 0,
        remainderUnexplainedByThisPurchase: subtractMoney(known, instAmount).toString(),
      });
    }

    // C/D/E — evidência de dado real vs teste, sem decidir por conta própria:
    // reporta os sinais encontrados, deixa a classificação como UNKNOWN salvo
    // sinal forte o suficiente.
    const evidenceForReal = [];
    const evidenceForTest = [];
    if (p.source === "manual" || p.source === "telegram") evidenceForReal.push(`source="${p.source}" (não é um marcador de teste conhecido do projeto)`);
    if (!/teste|test|fixture|sample/i.test(p.description)) evidenceForReal.push("descrição não contém nenhum marcador de teste conhecido (ex: TESTE_, [TESTE], test, fixture)");
    const exactMatches = explainsComponent.filter((e) => e.exactMatch);
    if (exactMatches.length > 0) evidenceForReal.push(`bate EXATAMENTE com ${exactMatches.length} known bill(s): ${exactMatches.map((e) => e.billMonth).join(", ")}`);
    const partialMatches = explainsComponent.filter((e) => e.explainsPartial);
    if (partialMatches.length > 0) evidenceForTest.push(`NÃO explica sozinha ${partialMatches.length} known bill(s) maior(es) que a parcela: ${partialMatches.map((e) => e.billMonth).join(", ")} — precisaria de outras compras reais não capturadas`);
    const knownMonthsNotCovered = [...knownBillsByMonth.keys()].filter((m) => !monthsOccupied.includes(m) && money(knownBillsByMonth.get(m)).gt(0));
    if (knownMonthsNotCovered.length > 0) evidenceForTest.push(`não cobre known bill(s) fora da sua janela de parcelas: ${knownMonthsNotCovered.join(", ")}`);

    let conclusion = "UNKNOWN";
    if (evidenceForReal.length > 0 && evidenceForTest.length === 0) conclusion = "LIKELY_REAL";
    else if (evidenceForReal.length > 0 && evidenceForTest.length > 0) conclusion = "UNKNOWN_PARTIAL_EXPLANATORY_POWER";

    // Fase 5.0.2, item 12 — cruza contra o CSV legado (se auditado): a
    // AUSÊNCIA de uma row correspondente no CSV só é informativa se o CSV
    // realmente COBRE o período da compra — nunca tratada como evidência
    // contra a realidade da Purchase se o CSV é de um período anterior.
    let csvCrossCheck = { status: "NOT_APPLICABLE_NO_CSV" };
    if (csvAudit?.status === "AUDITED") {
      const csvDates = csvAudit.rows.map((r) => (r.date ? new Date(r.date) : null)).filter(Boolean);
      const csvMin = csvDates.length ? new Date(Math.min(...csvDates.map((d) => d.getTime()))) : null;
      const csvMax = csvDates.length ? new Date(Math.max(...csvDates.map((d) => d.getTime()))) : null;
      const csvCoversPeriod = csvMin && csvMax && p.purchasedAt >= csvMin && p.purchasedAt <= csvMax;
      if (!csvCoversPeriod) {
        csvCrossCheck = {
          status: "UNKNOWN",
          classification: "NOT_APPLICABLE_CSV_PREDATES_OR_POSTDATES_PURCHASE",
          note: `O CSV cobre ${csvMin?.toISOString().slice(0, 10)}..${csvMax?.toISOString().slice(0, 10)}; a Purchase é de ${p.purchasedAt.toISOString().slice(0, 10)}, fora dessa janela — ausência no CSV NÃO é evidência de artefato, o CSV simplesmente não cobre esta data.`,
        };
      } else {
        const pDescNorm = p.description.toLowerCase();
        const matches = csvAudit.rows.filter((r) => {
          const rAmount = r.amount ? Number(r.amount) : null;
          const amountMatches = rAmount != null && (Math.abs(rAmount - Number(p.installmentValue)) < 0.01 || Math.abs(rAmount - Number(p.totalAmount)) < 0.01);
          return amountMatches;
        });
        if (matches.length > 0) {
          csvCrossCheck = { status: "LIKELY_MATCH", classification: "LIKELY_MATCH", matchedRows: matches.map((m) => ({ rawDate: m.rawDate, amount: m.amount, description: m.description })), note: "Match por VALOR (parcela ou total) dentro do período coberto pelo CSV — não é matching só pelo valor genérico 60,60, cruza contra o período real também." };
        } else {
          csvCrossCheck = { status: "UNKNOWN", classification: "UNKNOWN", note: "CSV cobre o período, mas nenhuma row com valor compatível foi encontrada — não é evidência de artefato, só ausência de confirmação adicional." };
        }
      }
    }

    return {
      csvCrossCheck,
      purchase: {
        id: p.id,
        description: p.description,
        purchasedAt: p.purchasedAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        totalAmount: p.totalAmount.toString(),
        installmentValue: p.installmentValue.toString(),
        installmentCount: p.installmentCount,
        cardId: p.cardId,
        source: p.source,
        confidence: p.confidence,
      },
      installments: p.installments.map((i) => ({ number: i.number, amount: i.amount.toString(), billMonth: i.billMonth, createdAt: i.createdAt.toISOString() })),
      answerA_monthsOccupied: monthsOccupied,
      answerB_explainsRecurringComponent: explainsComponent,
      answerC_evidenceForReal: evidenceForReal,
      answerD_evidenceForTestOrJunk: evidenceForTest,
      answerE_conclusion: conclusion,
      conclusionNote: "NÃO marcada como legacy/test sem evidência suficiente — ver evidenceForReal/evidenceForTestOrJunk acima.",
    };
  });

  return { status: purchases.length > 0 ? "FOUND" : "NONE_FOUND", purchases: purchaseAudits };
}

// ============================================================================
// Classifica CADA CardBill persistida contra a realidade conhecida (item 6/7
// do pedido). Usa: (a) cruzamento de valor com known bills; (b) clustering de
// createdAt (lote de materialização = mesmo segundo/minuto de criação, sinal
// forte de efeito colateral do bug antigo — Fase 4.1.2/4.1.3); (c) se
// remaining > 0, a row PODE contaminar incurredLiabilities/futureObligations
// se deixada como está — nunca assume que "legacy" é seguro sem checar isso.
// ============================================================================
function classifyPersistedCardBills(persistedBills, knownBillsByMonth) {
  if (persistedBills.length === 0) return [];

  // Clustering: agrupa por minuto de createdAt — um lote de materialização
  // (Fase 4.1.2, item 6) cria várias rows em segundos umas das outras.
  const createdBuckets = new Map();
  for (const b of persistedBills) {
    const bucketKey = b.createdAt.slice(0, 16); // "YYYY-MM-DDTHH:MM"
    createdBuckets.set(bucketKey, (createdBuckets.get(bucketKey) || 0) + 1);
  }

  return persistedBills.map((b) => {
    const known = knownBillsByMonth.get(b.cycleMonth);
    const remaining = money(b.remainingAmount);
    const totalAmount = money(b.totalAmount);
    const isZero = totalAmount.isZero();
    const inBatch = createdBuckets.get(b.createdAt.slice(0, 16)) >= 4; // 4+ rows no mesmo minuto = lote

    let classification;
    let reasoning;
    if (known != null && compareMoney(totalAmount, known) === 0) {
      classification = "KEEP_OR_PARTIAL_MATCH";
      reasoning = "totalAmount já bate com o valor real conhecido — mas closesAt/dueAt podem mudar se o Card.closingDay real for diferente do usado quando esta row foi criada; verificar paidAmount/status antes de considerar 100% correta.";
    } else if (known != null) {
      classification = "CANONICAL_UPDATE_CANDIDATE";
      reasoning = `totalAmount persistido (${b.totalAmount}) diverge do valor real conhecido (${known.toString()}) — precisa de UPDATE, nunca CREATE (constraint cardId+cycleMonth já garante que só existe esta row pra este ciclo).`;
    } else if (isZero && inBatch) {
      classification = "CLEAR_ARTIFACT_CANDIDATE";
      reasoning = "totalAmount=0, criada no mesmo lote (mesmo minuto) que outras rows zeradas, fora da janela de ciclos conhecidos — padrão exato do bug de materialização antigo (Fase 4.1.2/4.1.3), sem nenhum pagamento/transfer vinculado.";
    } else {
      classification = "UNKNOWN";
      reasoning = "Nem bate com um valor conhecido, nem se encaixa no padrão claro de artefato zerado em lote — precisa de investigação adicional antes de decidir a mutação.";
    }

    // Contaminação: qualquer row com remaining > 0 participa da classificação
    // de obrigações (incurred/future) do engine REAL hoje — mesmo que
    // "legacy"/incorreta. Rows com remaining == 0 são sempre SETTLED e
    // ignoradas pelo classificador (lib/obligationClassifier.js), então são
    // inofensivas ao cálculo (mas ainda poluem a UI de /cartoes).
    const wouldContaminateEngineIfLeftAsIs = isPositive(remaining) && classification !== "KEEP_OR_PARTIAL_MATCH";

    return {
      id: b.id,
      cycleMonth: b.cycleMonth,
      totalAmount: b.totalAmount,
      paidAmount: b.paidAmount,
      remainingAmount: b.remainingAmount,
      status: b.status,
      closesAt: b.closesAt,
      dueAt: b.dueAt,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      knownRealAmount: known?.toString() ?? null,
      classification,
      reasoning,
      wouldContaminateEngineIfLeftAsIs,
    };
  });
}

// ============================================================================
// N/O — Card reconciliation + persisted vs known CardBills (itens 6-8, 17-19)
// ============================================================================
async function reconcileCard(cardInput, csvAudit) {
  if (!cardInput) return { status: "MISSING_EVIDENCE", reason: "card não informado no input" };

  const totalLimit = money(cardInput.totalLimit);
  const observedAvailable = money(cardInput.observedAvailable);
  const usedLimitObserved = subtractMoney(totalLimit, observedAvailable);

  const knownBills = (cardInput.bills || []).map((b) => ({ ...b, amountMoney: money(b.amount) }));
  const knownBillsByMonth = new Map(knownBills.map((b) => [b.cycleMonth, b.amountMoney]));
  const unpaidSum = sumMoney(knownBills.filter((b) => b.status !== "PAID").map((b) => b.amountMoney));
  const usedLimitChecksum = {
    formula: `${totalLimit.toString()} - ${observedAvailable.toString()} = ${usedLimitObserved.toString()}`,
    usedLimitObserved: usedLimitObserved.toString(),
    sumOfKnownUnpaidBills: unpaidSum.toString(),
    matches: compareMoney(usedLimitObserved, unpaidSum) === 0,
  };

  // Regra oficial da Fase 4.1.2: primeira bill não liquidada (cronologicamente)
  // = INCURRED_LIABILITY, as demais = FUTURE_OBLIGATION. Aplicada aqui sobre os
  // valores CONHECIDOS reais (input), não sobre o que está persistido no banco
  // (item 8: não confiar no saldo atual do app).
  const unpaidSorted = knownBills.filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const incurred = unpaidSorted[0] ?? null;
  const future = unpaidSorted.slice(1);
  const futureSum = sumMoney(future.map((b) => b.amountMoney));

  let card = null;
  let persistedBills = [];
  let classifiedBills = [];
  if (cardInput.slug) {
    card = await prisma.card.findUnique({ where: { slug: cardInput.slug } });
    if (card) {
      persistedBills = (await prisma.cardBill.findMany({ where: { cardId: card.id }, orderBy: { cycleMonth: "asc" } })).map((b) => ({
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
      }));
      classifiedBills = classifyPersistedCardBills(persistedBills, knownBillsByMonth);
    }
  }

  const purchaseAudit = await auditPurchasesAgainstKnownBills(cardInput, knownBillsByMonth, csvAudit);

  // Item 8 — OBSERVED BILL TOTAL vs UNDERLYING PURCHASES EXPLAINED, por ciclo.
  const explainedByMonth = new Map();
  if (purchaseAudit.status === "FOUND") {
    for (const pa of purchaseAudit.purchases) {
      for (const comp of pa.answerB_explainsRecurringComponent) {
        const prev = explainedByMonth.get(comp.billMonth) || ZERO;
        explainedByMonth.set(comp.billMonth, addMoney(prev, money(comp.installmentAmount)));
      }
    }
  }
  const observedVsExplained = knownBills.map((b) => {
    const explained = explainedByMonth.get(b.cycleMonth) || ZERO;
    return {
      cycleMonth: b.cycleMonth,
      observedBillTotal: b.amountMoney.toString(),
      underlyingPurchasesExplained: explained.toString(),
      unexplainedByKnownPurchases: subtractMoney(b.amountMoney, explained).toString(),
      fullyExplained: compareMoney(explained, b.amountMoney) === 0,
    };
  });

  return {
    totalLimit: totalLimit.toString(),
    observedAvailable: observedAvailable.toString(),
    usedLimitChecksum,
    closingDay: cardInput.closingDay,
    dueDay: cardInput.dueDay,
    knownBills: knownBills.map((b) => ({ cycleMonth: b.cycleMonth, amount: b.amountMoney.toString(), status: b.status })),
    observedVsUnderlyingPurchasesExplained: observedVsExplained,
    liabilityClassification: {
      rule: "Fase 4.1.2 — primeira bill não liquidada (cronológica) = INCURRED_LIABILITY, demais = FUTURE_OBLIGATION",
      incurredLiability: incurred ? { cycleMonth: incurred.cycleMonth, amount: incurred.amountMoney.toString() } : null,
      futureObligations: { total: futureSum.toString(), items: future.map((b) => ({ cycleMonth: b.cycleMonth, amount: b.amountMoney.toString() })) },
    },
    cardFoundInDb: card ? { id: card.id, slug: card.slug } : { status: "NOT_FOUND_IN_DB", slugSearched: cardInput.slug ?? null },
    cardBillUniqueConstraint: confirmCardBillUniqueConstraint(),
    persistedCardBillsInDb: persistedBills,
    persistedCardBillsClassified: classifiedBills,
    cardBillManifestById: buildCardBillManifestById(knownBills, classifiedBills),
    purchaseAudit,
    currentCardCreditBalanceAssumption: "R$0,00 — nenhuma evidência de saldo credor atual informada neste snapshot.",
  };
}

// ============================================================================
// Fase 5.1A, item 14 — manifesto CardBill por id, pra TODAS as CardBills
// persistidas: current (total/paid/status/remaining), canonical (total/paid/
// status, se conhecido), proposedAction e contamination risk. Nunca propõe
// CREATE onde já existe row única (cardId+cycleMonth) — a constraint garante
// isso, então toda correção de ciclo já persistido é necessariamente UPDATE.
// ============================================================================
function buildCardBillManifestById(knownBills, classifiedBills) {
  const knownByMonth = new Map(knownBills.map((b) => [b.cycleMonth, b]));

  return classifiedBills.map((cb) => {
    const known = knownByMonth.get(cb.cycleMonth) ?? null;
    const canonicalTotal = known ? known.amountMoney.toString() : null;
    const canonicalStatus = known ? (known.status === "PAID" ? "paid" : "open") : null;
    const canonicalPaidAmount = known ? (known.status === "PAID" ? known.amountMoney.toString() : "0.00") : null;

    let proposedAction;
    let reason;
    if (cb.classification === "CLEAR_ARTIFACT_CANDIDATE") {
      proposedAction = "DELETE_ARTIFACT_CANDIDATE";
      reason = cb.reasoning;
    } else if (cb.classification === "UNKNOWN") {
      proposedAction = "DEFER_UNKNOWN";
      reason = cb.reasoning;
    } else if (known == null) {
      proposedAction = "DEFER_UNKNOWN";
      reason = "Sem valor canônico conhecido pra este ciclo — não é possível propor KEEP nem UPDATE com confiança.";
    } else {
      const totalMatches = compareMoney(money(cb.totalAmount), money(canonicalTotal)) === 0;
      const statusMatches = cb.status === canonicalStatus;
      const paidMatches = compareMoney(money(cb.paidAmount ?? 0), money(canonicalPaidAmount)) === 0;
      if (totalMatches && statusMatches && paidMatches) {
        proposedAction = "KEEP";
        reason = "totalAmount, status e paidAmount persistidos já batem exatamente com os valores canônicos conhecidos.";
      } else {
        proposedAction = "UPDATE";
        const diffs = [];
        if (!totalMatches) diffs.push(`totalAmount ${cb.totalAmount} -> ${canonicalTotal}`);
        if (!statusMatches) diffs.push(`status ${cb.status} -> ${canonicalStatus}`);
        if (!paidMatches) diffs.push(`paidAmount ${cb.paidAmount ?? "null"} -> ${canonicalPaidAmount}`);
        reason = `Diverge do canônico em: ${diffs.join(", ")}. Constraint @@unique([cardId, cycleMonth]) garante que esta é a ÚNICA row possível pra este ciclo — a correção é OBRIGATORIAMENTE um UPDATE, nunca um CREATE.`;
      }
    }

    return {
      id: cb.id,
      cycleMonth: cb.cycleMonth,
      current: { totalAmount: cb.totalAmount, paidAmount: cb.paidAmount, status: cb.status, remainingAmount: cb.remainingAmount },
      canonical: known ? { totalAmount: canonicalTotal, paidAmount: canonicalPaidAmount, status: canonicalStatus } : { status: "UNKNOWN" },
      proposedAction,
      reason,
      contaminationRisk: cb.wouldContaminateEngineIfLeftAsIs,
    };
  });
}

// ============================================================================
// R — Transferência para escopo externo não monitorado: auditoria de schema
// (item 25) — pura, não lê banco. Genérica de propósito: aplica-se a QUALQUER
// destino fora do escopo do Norte pessoal (outra pessoa jurídica, outra
// pessoa, etc.) — o input concreto de cada rodada é que traz o "quem"/"por quê".
// ============================================================================
function auditTransferSchemaForExternalScope() {
  return {
    question_A_scopeIsPersonalOnly: true,
    evidence_A: "Nenhum campo de 'entity'/'scope' existe em nenhum model do schema — Account/Card/Income/Expense/Transfer não distinguem uma entidade de outra.",
    question_B_transferRequiresInternalToField: false,
    evidence_B:
      "prisma/schema.prisma: Transfer.toAccountId e Transfer.toCardId são AMBOS nullable (String?). " +
      "lib/accounts.js:computeAccountBalance subtrai qualquer Transfer com fromAccountId=<conta> do saldo, " +
      "INDEPENDENTE de toAccountId/toCardId estarem setados. app/api/transfers/route.js só exige " +
      "'fromAccountId OU toAccountId' (não ambos) — um Transfer com fromAccountId setado e toAccountId=null/toCardId=null " +
      "JÁ é aceito e JÁ reduz o saldo da conta de origem corretamente, sem exigir uma Account de destino.",
    question_C_existingSemanticsForTransferOut: true,
    evidence_C:
      "Transfer.kind é uma STRING livre (não um enum do Prisma) com valores hoje em uso 'generic'/'card_bill_payment'/'installment_anticipation' " +
      "— um novo valor 'external_transfer' (ou similar) pode ser usado HOJE, sem migration, sem alterar o schema. " +
      "Transfer.description já é um campo de texto livre, suficiente para registrar destino/finalidade de qualquer transferência externa.",
    question_D_minimalSchemaChangeIfUnsupported: {
      isSchemaChangeNeeded: false,
      reasoning:
        "O schema JÁ suporta representar uma saída para fora do escopo monitorado, sem nenhuma migration: " +
        "Transfer{ fromAccountId: <conta pessoal>, toAccountId: null, toCardId: null, kind: 'external_transfer', " +
        "description: '<finalidade + destino>' }. Isso NÃO vira Expense (não usa o model Expense), " +
        "NÃO precisa de uma Account nova pro destino externo, e é corretamente subtraído do saldo da conta de origem por " +
        "computeAccountBalance — sem dupla contagem, sem tratar como consumo pessoal.",
      optionalFutureRefinement:
        "Se o rastreamento de MÚLTIPLAS transferências externas por finalidade/destino precisar de filtro/relatório " +
        "dedicado no futuro, um campo opcional Transfer.externalCounterparty (String?, nullable, aditivo) seria a " +
        "menor migration possível — mas NÃO é necessário pra representar corretamente o fato de hoje.",
    },
    conclusion: "GAP_DE_MODELAGEM: NENHUM — o schema atual já suporta o caso sem alteração. Decisão sobre se o destino externo entra no escopo do Norte pessoal continua em aberto, mas não bloqueia representar corretamente a SAÍDA de caixa já ocorrida.",
  };
}

// ============================================================================
// Fase 5.0.2, itens 0/5-8 — auditoria genérica read-only de um CSV legado
// (STAGING/EVIDÊNCIA, nunca importado cegamente). O caminho vem de
// input.legacyCsvPath (arquivo LOCAL, gitignored — nunca dentro do repo).
// Se ausente/inexistente, retorna status explícito, nunca inventa conteúdo.
// ============================================================================
function auditLegacyCsv(input, { asOf, nextIncomeDate, operationalHistoryStart, vaHistoryStart }) {
  const csvPath = input.legacyCsvPath;
  if (!csvPath) return { status: "NOT_PROVIDED", note: "input.legacyCsvPath não informado — nenhuma fonte histórica externa a auditar nesta rodada." };
  if (!fs.existsSync(csvPath)) return { status: "FILE_NOT_FOUND", pathSearched: csvPath };

  const hash = computeFileHash(csvPath);
  const { header, rows } = auditCsvRows(csvPath);

  const operationalCutoff = operationalHistoryStart;
  const vaCutoff = vaHistoryStart;
  const rowsWithCutoffFlags = rows.map((r) => {
    const rowDate = r.date ? new Date(r.date) : null;
    return {
      ...r,
      isBeforeOperationalCutoff: rowDate && operationalCutoff ? rowDate < operationalCutoff : null,
      isBeforeVaCutoff: rowDate && vaCutoff ? rowDate < vaCutoff : null,
    };
  });

  const cardBillPaymentAnomalies = rowsWithCutoffFlags.filter((r) => r.likelySemanticEntity === "CARD_BILL_PAYMENT");
  const possibleTotalValueInstallmentPurchases = rowsWithCutoffFlags.filter((r) => r.likelySemanticEntity === "CARD_PURCHASE_POSSIBLY_INSTALLMENT");
  const cardPurchases = rowsWithCutoffFlags.filter((r) => r.likelySemanticEntity === "CARD_PURCHASE" || r.likelySemanticEntity === "CARD_PURCHASE_POSSIBLY_INSTALLMENT");
  const vaRows = rowsWithCutoffFlags.filter((r) => r.likelySemanticEntity === "VA_INCOME" || r.likelySemanticEntity === "VA_EXPENSE");
  const vaRowsAfterCutoff = vaRows.filter((r) => r.isBeforeVaCutoff === false);
  const vaRowsBeforeCutoff = vaRows.filter((r) => r.isBeforeVaCutoff !== false);

  const externalInstallmentCandidates = reconstructExternalInstallmentCandidates(rowsWithCutoffFlags, { asOf, nextIncomeDate });
  const materialActiveCandidates = externalInstallmentCandidates.filter((p) => p.stillActiveCandidate);

  return {
    status: "AUDITED",
    file: { path: csvPath, sha256: hash.sha256, bytes: hash.bytes, preservedOriginalUnmodified: true },
    header,
    rowCount: rows.length,
    disclaimer: "STAGING/EVIDÊNCIA — NÃO importado cegamente. Datas podem refletir backfill, não o dia real do evento. Ver anomalyFlags por row.",
    rows: rowsWithCutoffFlags,
    cardBillPaymentAnomalies: cardBillPaymentAnomalies.map((r) => ({ rawDate: r.rawDate, amount: r.amount, category: r.category, description: r.description, classification: "LEGACY_MODELING_ANOMALY", note: "Pagamento de fatura registrado como Gasto no Norte antigo — NÃO importar como Expense operacional; reforça que pagamento de fatura != Expense." })),
    possibleTotalValueInstallmentPurchases,
    cardPurchases,
    vaHistoricalEvidence: {
      note: "A maioria dos movimentos de VA no CSV é ANTERIOR ao cutoff atual (vaHistoryStart) — usados só como HISTORICAL/STAGING EVIDENCE (padrões, não fatos operacionais do ciclo atual). NÃO usados automaticamente para explicar o saldo de 04/09.",
      rowsBeforeCutoff: vaRowsBeforeCutoff.length,
      rowsAfterCutoff: vaRowsAfterCutoff.length,
      rowsAfterCutoffDetail: vaRowsAfterCutoff,
    },
    externalInstallmentCandidates,
    materialActiveExternalInstallmentCandidates: materialActiveCandidates,
  };
}

// ============================================================================
// W — Financial Engine dry-run (item 24, corrigido pelo item 9 da Fase 5.0.1)
// — 100% em memória, sobre o ESTADO CANÔNICO PROPOSTO (input), NUNCA sobre a
// ausência de rows V2 no banco (isso mediria "o que já foi persistido", não
// "o que o snapshot proposto diz"). Reusa as funções PURAS de
// lib/obligationClassifier.js, lib/freeMoney.js, lib/financialProjection.js
// (minProjectedCashBefore), lib/financialStatus.js e lib/financialEngine.js
// (computeCurrentObligationHorizonEnd) — nenhuma chamada a prisma aqui.
// ============================================================================
function addDaysUtc(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb, appSettings, asOf, csvAudit }) {
  const missing = [];
  const HORIZON_DAYS = 90;
  const horizonEnd = addDaysUtc(asOf, HORIZON_DAYS);

  // Fase 5.0.3, itens 6-9 — as posições ATUAIS confirmadas
  // (input.externalInstallmentPlans) SUPERAM o status UNKNOWN_PAYMENT_STATUS
  // reconstruído só do CSV (Fase 5.0.2) — "não está no banco" != "não existe
  // financeiramente", mas evidência conversacional explícita > reconstrução
  // de um CSV desatualizado. O CSV vira só validação de COERÊNCIA temporal
  // (item 8), nunca a fonte de verdade quando existe confirmação mais recente.
  const confirmedExternalInstallmentPlans = (input.externalInstallmentPlans || []).map((p) => {
    const remaining = p.installmentCount - p.paidInstallments;
    return { ...p, remaining, nextInstallmentAmount: money(p.installmentValue) };
  });
  const activeExternalInstallmentPlans = confirmedExternalInstallmentPlans.filter((p) => p.remaining > 0);
  const nextExternalInstallmentPackageTotal = sumMoney(activeExternalInstallmentPlans.map((p) => p.nextInstallmentAmount));

  // Cruzamento de coerência temporal (item 8) — casa por VALOR da parcela
  // (única dimensão comparável entre o input em inglês/livre e o CSV em
  // português), nunca por descrição textual. Só relatado, nunca usado pra
  // decidir a obrigação (a posição CONFIRMADA já é suficiente por si só).
  const csvCandidatesByAmount = new Map((csvAudit?.externalInstallmentCandidates || []).map((c) => [money(c.amountObservedPerInstallment).toString(), c]));
  const externalInstallmentCsvCoherence = activeExternalInstallmentPlans.map((p) => {
    const csvMatch = csvCandidatesByAmount.get(p.nextInstallmentAmount.toString());
    if (!csvMatch) return { description: p.description, csvMatch: "NOT_FOUND_IN_CSV", note: "Sem correspondência no CSV por valor — pode ter começado depois do período coberto pelo CSV. Isso NÃO torna o plano menos real (evidência conversacional já confirma a posição atual)." };
    const coherent = p.paidInstallments >= csvMatch.observedInstallmentNumber;
    return {
      description: p.description,
      csvMatch: "FOUND",
      csvObservedPosition: `${csvMatch.observedInstallmentNumber}/${csvMatch.totalInstallmentCount}`,
      csvObservedDate: csvMatch.observedRawDate,
      currentConfirmedPosition: `${p.paidInstallments}/${p.installmentCount}`,
      coherentTemporalAdvance: coherent,
      note: coherent
        ? "Posição atual confirmada é IGUAL OU MAIOR que a posição observada no CSV — avanço coerente no tempo."
        : "Posição atual confirmada é MENOR que a posição observada no CSV — inconsistência a investigar (não esperado; parcelas não regridem).",
    };
  });

  // Item 9 — timing confirmado: pacote normalmente pago DEPOIS do salário.
  // NÃO classificar como CURRENT_HORIZON_OBLIGATION antes da renda de 24/09,
  // NÃO reduzir freeMoney por isso — vira candidato pro próximo ciclo
  // (nextIncomeWindowCommitmentCandidate), reportado separadamente.
  const externalInstallmentsTiming = input.externalInstallmentsPaymentTiming || null;
  const nextIncomeWindowCommitmentCandidate =
    activeExternalInstallmentPlans.length > 0
      ? {
          total: nextExternalInstallmentPackageTotal.toString(),
          plans: activeExternalInstallmentPlans.map((p) => ({ description: p.description, nextInstallmentAmount: p.nextInstallmentAmount.toString(), currentPosition: `${p.paidInstallments}/${p.installmentCount}`, remaining: p.remaining })),
          exactDueDate: externalInstallmentsTiming?.exactDueDate ?? "UNKNOWN",
          paymentTiming: externalInstallmentsTiming?.paymentTiming ?? "UNKNOWN",
          timingConfidence: externalInstallmentsTiming?.timingConfidence ?? "UNKNOWN",
          note: "NÃO incluído em currentHorizonObligations nem subtraído de freeMoney — evidência aponta pagamento DEPOIS da próxima renda, não antes.",
        }
      : null;

  // Item 10/11 — Bills domésticas do ciclo atual: as já PAID neste ciclo estão
  // SETTLED (não são mais obrigação); a(s) PENDING com valor ESTIMATED e
  // dueDate desconhecida ficam num bucket à parte — nunca misturadas no
  // freeMoney exato (item 11: "NÃO misturar o estimado no valor exato").
  const householdBills = input.householdBills || [];
  const settledHouseholdBills = householdBills.filter((b) => b.status === "PAID");
  const pendingEstimatedHouseholdBills = householdBills.filter((b) => b.status !== "PAID");
  const pendingEstimatedTotal = sumMoney(pendingEstimatedHouseholdBills.map((b) => money(b.amount)));

  // --- balances ---
  const unrestrictedCash = input.checkingAccount ? money(input.checkingAccount.checkpointB.amount) : null;
  if (unrestrictedCash == null) missing.push({ field: "unrestrictedCash", impact: "bloqueia todo o resto do engine", evidenceNeeded: "checkingAccount.checkpointB no input" });
  // protectedMoney = soma de reserves propostas vinculadas a conta IRRESTRITA
  // (input.reserves é opcional — vazio/ausente = R$0 protegido, nunca assumido
  // a partir de um fato específico hardcoded; ver lib/freeMoney.js:getProtectedMoney
  // pra mesma regra sobre dado real persistido).
  const proposedReserves = (input.reserves || []).filter((r) => r.accountType !== "restricted");
  const protectedMoney = sumMoney(proposedReserves.map((r) => money(r.amount)));
  const restrictedBalance = input.restrictedAccount ? money(input.restrictedAccount.observedClosing.amount) : null;
  const totalBalances = unrestrictedCash != null && restrictedBalance != null ? addMoney(unrestrictedCash, restrictedBalance) : null;

  // --- obligations: CardBill (proposto, valores conhecidos reais + dueAt/closesAt
  // REAIS via lib/cardCycle.js, quando closingDay/dueDay do cartão são conhecidos) ---
  const cardConfig = input.card ? { closingDay: input.card.closingDay ?? null, dueDay: input.card.dueDay } : null;
  const cardBillsProposed = (input.card?.bills || [])
    .map((b) => ({
      ...b,
      dueAt: cardConfig ? getCardBillDueDate(cardConfig, b.cycleMonth) : null,
      closesAt: cardConfig ? getCardBillClosesAt(cardConfig, b.cycleMonth) : null,
    }))
    .sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const unsettledSorted = [...cardBillsProposed].filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const currentRelevantCycleMonth = unsettledSorted[0]?.cycleMonth ?? null;

  let incurredLiabilities = ZERO;
  let futureObligationsFromCard = ZERO;
  const incurredItems = [];
  const futureItems = [];
  const timelineEvents = []; // { date, amount (negativo=saída), label, kind }
  for (const bill of cardBillsProposed) {
    const asFakeBill = { totalAmount: money(bill.amount), paidAmount: bill.status === "PAID" ? money(bill.amount) : money(0), cycleMonth: bill.cycleMonth };
    const cls = classifyCardBill(asFakeBill, { isCurrentRelevant: bill.cycleMonth === currentRelevantCycleMonth });
    const remaining = subtractMoney(asFakeBill.totalAmount, asFakeBill.paidAmount);
    const item = { cycleMonth: bill.cycleMonth, amount: remaining.toString(), dueAt: bill.dueAt?.toISOString() ?? null };
    if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) {
      incurredLiabilities = addMoney(incurredLiabilities, remaining);
      incurredItems.push(item);
    } else if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) {
      futureObligationsFromCard = addMoney(futureObligationsFromCard, remaining);
      futureItems.push(item);
    }
    if (isPositive(remaining) && bill.dueAt && bill.dueAt >= asOf && bill.dueAt <= horizonEnd) {
      timelineEvents.push({ date: bill.dueAt, amount: remaining.negated(), label: `Fatura cartão (${bill.cycleMonth})`, kind: "card_bill" });
    }
  }

  // --- obligations: ConfirmedCommitment (proposto, genérico — vem do input) ---
  // Item 12 — a dueDate real pode ser incerta entre N candidatas: a
  // CLASSIFICAÇÃO (current horizon vs future) só é aceita se for A MESMA sob
  // TODAS as candidatas (nunca finge saber qual é a certa). Pra posicionar o
  // evento na timeline física (checkpoints day30/60/90), usa a candidata MAIS
  // CEDO como placeholder conservador (dinheiro sai o quanto antes na pior
  // hipótese) — nunca apresentado como "a data real", sempre com
  // dueDateUncertain=true quando há mais de uma candidata.
  let currentHorizonObligations = ZERO;
  const currentHorizonItems = [];
  const unfundedConfirmedCommitments = { count: 0, amount: ZERO, items: [] };
  for (const c of input.confirmedCommitments || []) {
    const candidates = (c.dateCandidates || []).map((s) => d(s)).sort((a, b) => a - b);
    if (candidates.length === 0) {
      missing.push({ field: `confirmedCommitment(${c.description}).dueDate`, impact: "não é possível classificar horizonte sem nenhuma data candidata", evidenceNeeded: "data confirmada do compromisso" });
      continue;
    }
    const classifications = candidates.map((date) => classifyConfirmedCommitment({ status: "CONFIRMED", dueDate: date }, { nextIncomeDate: nextIncomeProposed.expectedDate }));
    const allSame = classifications.every((cls) => cls === classifications[0]);
    if (!allSame) {
      missing.push({ field: `confirmedCommitment(${c.description}).dueDate`, impact: "classificação de horizonte MUDA dependendo de qual candidata for a data real — não seguro decidir", evidenceNeeded: `data exata entre ${(c.dateCandidates || []).join(" ou ")}` });
      continue;
    }
    const cls = classifications[0];
    const amount = money(c.amount);
    const timelineDatePlaceholder = candidates[0];
    const item = {
      type: "ConfirmedCommitment",
      description: c.description,
      amount: amount.toString(),
      dueDateUncertain: candidates.length > 1,
      dueDateCandidates: (c.dateCandidates || []),
      timelineDatePlaceholderNote: candidates.length > 1 ? "Data real ainda UNCERTAIN_DATE_RANGE — usada a candidata mais cedo só como placeholder conservador na timeline física, nunca afirmada como a data real." : null,
      dateConfidence: c.dateConfidence,
      funding: c.funding,
      status: "CONFIRMED",
    };
    if (cls === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION) {
      currentHorizonObligations = addMoney(currentHorizonObligations, amount);
      currentHorizonItems.push(item);
      if (c.funding === "UNDEFINED") {
        unfundedConfirmedCommitments.count += 1;
        unfundedConfirmedCommitments.amount = addMoney(unfundedConfirmedCommitments.amount, amount);
        unfundedConfirmedCommitments.items.push(item);
      }
    } else {
      futureItems.push(item);
    }
    if (timelineDatePlaceholder >= asOf && timelineDatePlaceholder <= horizonEnd) {
      timelineEvents.push({ date: timelineDatePlaceholder, amount: amount.negated(), label: `${c.description} (data placeholder, ${item.dueDateUncertain ? "incerta" : "confirmada"})`, kind: "confirmed_commitment" });
    }
  }

  // --- contingencyExposure (proposto, genérico) — nunca entra em freeMoney,
  // nunca inserida na timeline com data inventada (item 11). ---
  const contingencies = input.contingencies || [];
  const contingencyExpected = sumMoney(contingencies.filter((c) => c.expectedAmount != null).map((c) => money(c.expectedAmount)));
  const contingencyMax = sumMoney(contingencies.map((c) => money(c.maxAmount)));
  const undatedRiskExposures = [];
  const contingencyItems = contingencies.map((c) => {
    if (!c.expectedDate) {
      undatedRiskExposures.push({
        description: c.description,
        expectedAmount: c.expectedAmount != null ? money(c.expectedAmount).toString() : null,
        maxAmount: money(c.maxAmount).toString(),
        classification: "UNDATED_RISK_EXPOSURE",
        note: "Sem expectedDate confiável — exposição preservada em contingencyExposure.expected/maximum, NUNCA inserida num dia fictício da timeline.",
      });
    }
    return {
      description: c.description,
      expectedAmount: c.expectedAmount != null ? money(c.expectedAmount).toString() : null,
      expectedAmountConfidence: c.expectedAmountConfidence,
      maxAmount: money(c.maxAmount).toString(),
      maxAmountConfidence: c.maxAmountConfidence,
      classification: classifyContingency({ status: c.status }),
      dated: c.expectedDate != null,
    };
  });

  // --- recurring income: SCHEDULE evidence separada de AMOUNT evidence (item
  // 16 da Fase 5.0.1 / item 3C-4 da Fase 5.0.2) ---
  // dayOfMonth vem do input (schedule) — CONFIRMED_BY_MEMORY por padrão (só 1
  // ocorrência histórica sustenta a cadência). O valor PADRÃO/BASE
  // (standardRecurringAmount) é uma evidência distinta da ocorrência REAL da
  // próxima renda — mesmo com o padrão confirmado, a próxima ocorrência real
  // pode ser MAIOR (ex: horas extras variáveis) e seu valor exato permanece
  // UNKNOWN até realmente acontecer. NUNCA tratamos standardRecurringAmount
  // como se fosse a certeza do valor real da próxima ocorrência.
  const scheduleConfidence = input.mainIncome?.scheduleConfidence ?? (input.mainIncome ? "CONFIRMED_BY_MEMORY" : null);
  const standardRecurringAmountConfidence = input.mainIncome?.standardRecurringAmountConfidence ?? null;
  const standardRecurringAmount = standardRecurringAmountConfidence != null && input.mainIncome?.standardRecurringAmount != null ? money(input.mainIncome.standardRecurringAmount) : null;
  const variablePayExpected = input.mainIncome?.variablePayExpected ?? false;
  // expectedRecurringAmount só é usado pra INSERIR um evento na timeline física
  // (afeta checkpoints de caixa) — aqui SIM precisamos ser conservadores: se o
  // valor real tende a ser MAIOR (variablePayExpected), inserir o padrão na
  // timeline já é uma estimativa razoável (nunca superestima o caixa
  // disponível) — mas o denominador do nextIncomeCommitment (item 4) usa o
  // MESMO valor, com metadata deixando claríssimo que é o padrão, não o real.
  const expectedRecurringAmount = standardRecurringAmount;
  if (input.mainIncome && expectedRecurringAmount == null) {
    missing.push({
      field: "mainIncome.standardRecurringAmountConfidence",
      impact: "schedule (dia do mês) é conhecido, mas nem o valor padrão nem o valor real da próxima ocorrência estão confirmados — nextIncomeCommitment.committedPercent e os checkpoints de projeção após a próxima renda ficam PARTIAL",
      evidenceNeeded: "confirmação explícita do valor padrão/base recorrente",
    });
  } else if (variablePayExpected) {
    missing.push({
      field: "mainIncome.nextOccurrenceActualAmount",
      impact: "valor PADRÃO confirmado, mas a próxima ocorrência real tende a ser MAIOR (pagamento variável esperado) — qualquer percentual/checkpoint calculado contra o padrão tende a SUPERESTIMAR o comprometimento real",
      evidenceNeeded: "valor real da ocorrência, disponível só depois que ela acontecer",
    });
  }

  // Ocorrências de renda dentro do horizonte (só schedule, nunca valor
  // inventado) — usadas só pra apontar QUANDO a projeção cruza um evento de
  // valor desconhecido, nunca inseridas na timeline com um valor chutado.
  const incomeScheduleEvents = [];
  if (nextIncomeProposed.expectedDate) {
    let occ = nextIncomeProposed.expectedDate;
    while (occ <= horizonEnd) {
      incomeScheduleEvents.push({ date: occ.toISOString(), amountKnown: expectedRecurringAmount != null });
      if (expectedRecurringAmount != null) timelineEvents.push({ date: occ, amount: expectedRecurringAmount, label: "Renda principal (padrão/base, valor real pode ser maior)", kind: "recurring_income" });
      occ = new Date(Date.UTC(occ.getUTCFullYear(), occ.getUTCMonth() + 1, occ.getUTCDate()));
    }
  }
  // variablePayExpected mantém a projeção PARTIAL mesmo com o padrão
  // confirmado, porque o padrão subestima sistematicamente o caixa real
  // esperado (o valor de verdade tende a ser maior) — nunca tratamos isso
  // como equivalente a "valor totalmente conhecido".
  const projectionCrossesUnknownIncomeAmount = incomeScheduleEvents.some((e) => !e.amountKnown) || (incomeScheduleEvents.length > 0 && variablePayExpected);

  const canComputeFreeMoney = unrestrictedCash != null;
  const freeMoney = canComputeFreeMoney
    ? computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney, incurredLiabilities, currentHorizonObligations })
    : null;
  if (!canComputeFreeMoney) missing.push({ field: "freeMoney", impact: "depende de unrestrictedCash", evidenceNeeded: "checkingAccount.checkpointB" });

  const safeToSpend = freeMoney != null ? computeSafeToSpend(freeMoney, appSettings.safetyMarginPercent) : null;

  // --- baseline timeline física (item 9) — só eventos DATADOS entram; ---
  const sortedTimeline = [...timelineEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = unrestrictedCash;
  const timelineWithBalances = sortedTimeline.map((e) => {
    running = running != null ? addMoney(running, e.amount) : null;
    return { ...e, dateIso: e.date.toISOString(), balanceAfter: running?.toString() ?? null };
  });
  const baseProjectionLite = unrestrictedCash != null ? { startingCash: unrestrictedCash, timeline: sortedTimeline.map((e) => ({ date: e.date, balanceAfter: null })) } : null;
  // minProjectedCashBefore precisa de balanceAfter real por evento — recalcula
  // aqui reaproveitando a MESMA função pura importada de
  // lib/financialProjection.js (não uma reimplementação paralela).
  if (baseProjectionLite) {
    let r = unrestrictedCash;
    baseProjectionLite.timeline = sortedTimeline.map((e) => {
      r = addMoney(r, e.amount);
      return { date: e.date, balanceAfter: r };
    });
  }

  const nextIncomeDate = nextIncomeProposed.expectedDate;
  const currentObligationHorizonEnd = nextIncomeDate ? computeCurrentObligationHorizonEnd(nextIncomeProposed, asOf) : null;
  const minBaseCashBeforeIncome =
    baseProjectionLite && currentObligationHorizonEnd ? minProjectedCashBefore(baseProjectionLite, currentObligationHorizonEnd) : null;

  // --- nextIncomeCommitment window (proposto, in-memory, sem prisma) ---
  // Fase 5.0.3, item 14 — separa o que é CONHECIDO (cartão com dueAt real +
  // pacote de parcelas externas, cujo timing confirmado é "depois do
  // salário" — cabe DENTRO desta janela pós-renda, mesmo sem dueDate exata)
  // do que ainda é ESTIMADO (baseline de bill variável) e do que permanece
  // NÃO AUDITADO pro próximo ciclo (demais bills domésticas recorrentes,
  // cujo valor/existência no PRÓXIMO ciclo ainda não foi confirmado — evita
  // dupla contagem: elas NÃO estão embutidas no CardBill, são obrigações
  // à parte, mas também não são inventadas como "vão repetir exatamente igual").
  let nextIncomeCommitmentWindow = null;
  if (nextIncomeProposed.expectedDate) {
    const periodStart = nextIncomeProposed.expectedDate;
    const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, periodStart.getUTCDate()));
    const cardLiabilityInWindow = sumMoney(
      sortedTimeline.filter((e) => e.kind === "card_bill" && isWithinNextIncomeCommitmentWindow(e.date, periodStart, periodEnd)).map((e) => e.amount.negated())
    );
    const knownNextIncomeCommitments = {
      cardLiability: cardLiabilityInWindow.toString(),
      externalInstallmentPackage: nextExternalInstallmentPackageTotal.toString(),
      subtotal: addMoney(cardLiabilityInWindow, nextExternalInstallmentPackageTotal).toString(),
      note: "Pacote de parcelas externas incluído aqui (janela PÓS-renda) mesmo sem dueDate exata, porque o timing confirmado (GENERALLY_AFTER_SALARY) aponta que cai dentro deste período — diferente de currentHorizonObligations/freeMoney (janela PRÉ-renda), de onde ele é excluído.",
    };
    const estimatedNextIncomeCommitments = householdBills
      .filter((b) => b.futureBaselineEstimate != null)
      .map((b) => ({ name: b.name, futureBaselineEstimate: money(b.futureBaselineEstimate).toString(), confidence: b.futureBaselineConfidence ?? "ESTIMATED" }));
    const unresolvedNextIncomeCommitments = householdBills
      .filter((b) => b.futureBaselineEstimate == null)
      .map((b) => ({ name: b.name, currentCycleAmount: b.amount != null ? money(b.amount).toString() : b.actualCurrentAmount != null ? money(b.actualCurrentAmount).toString() : null, note: "Valor/existência para o PRÓXIMO ciclo ainda não auditado — não presumido igual ao ciclo atual." }));

    const committedAmountForPercent = money(knownNextIncomeCommitments.subtotal);
    // Fase 5.0.2, item 4 — agora existe um denominador-BASE confirmado
    // (standardRecurringAmount), mas isso NUNCA é chamado de "percentual exato
    // da renda real de 24/09" — é explicitamente committedPercentAgainstStandardBase,
    // com metadata deixando claro que o valor real pode ser maior (pagamento
    // variável esperado), o que tornaria o percentual real FINAL menor que este.
    // Item 14 — NÃO é o percentual final: falta auditar rent/electricity/
    // internet/water/phone/cleaner do próximo ciclo (unresolvedNextIncomeCommitments).
    const committedPercentAgainstStandardBase =
      expectedRecurringAmount != null && isPositive(expectedRecurringAmount)
        ? multiplyMoney(divideMoney(committedAmountForPercent, expectedRecurringAmount), 100)
        : null; // nunca inventa denominador.
    nextIncomeCommitmentWindow = {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      knownNextIncomeCommitments,
      estimatedNextIncomeCommitments,
      unresolvedNextIncomeCommitments,
      committedAmount: committedAmountForPercent.toString(),
      denominatorBasis: expectedRecurringAmount != null ? "STANDARD_RECURRING_BASE" : "UNKNOWN",
      denominatorAmount: expectedRecurringAmount?.toString() ?? null,
      actualNextIncomeAmountKnown: false,
      variablePayExpected,
      committedPercentAgainstStandardBase: committedPercentAgainstStandardBase != null ? committedPercentAgainstStandardBase.toString() : null,
      note:
        "NÃO é o percentual final — ainda falta auditar as bills domésticas recorrentes do PRÓXIMO ciclo (ver unresolvedNextIncomeCommitments)." +
        (variablePayExpected ? " Como a renda real de 24/09 tende a ser MAIOR que o padrão (pagamento variável esperado), o percentual comprometido REAL final tende a ser MENOR que committedPercentAgainstStandardBase." : ""),
      completeness: expectedRecurringAmount != null && !variablePayExpected && unresolvedNextIncomeCommitments.length === 0 ? COMPLETENESS.COMPLETE : COMPLETENESS.PARTIAL,
    };
  }

  // --- financialStatus (item 15) — usa a função REAL de lib/financialStatus.js. ---
  let financialStatus = null;
  let financialStatusCompleteness = COMPLETENESS.INCOMPLETE;
  if (freeMoney != null && baseProjectionLite && currentObligationHorizonEnd) {
    const result = computeFinancialStatus({
      freeMoney,
      nextIncomeDate,
      currentObligationHorizonEnd,
      nextIncomeStatus: nextIncomeProposed.status,
      baseProjection: baseProjectionLite,
      expectedProjection: undefined,
      stressProjection: undefined,
      unfundedConfirmedCommitments,
    });
    // A função só PRECISA de expectedProjection/stressProjection pra decidir
    // entre TRANQUILO e ATENCAO (a árvore de decisão passa por CRITICO/APERTADO
    // antes) — se o resultado veio de CRITICO ou APERTADO, é determinado só com
    // dado que JÁ temos completo (freeMoney + minBaseCashBeforeIncome). Se
    // caísse em TRANQUILO/ATENCAO por causa da ausência de projeção completa,
    // isso seria confiar em "nenhuma razão encontrada" como se fosse
    // "confirmadamente tranquilo" — não inventamos essa certeza.
    const decidedWithoutFullProjection = result.status === "CRITICO" || result.status === "APERTADO";
    financialStatus = { status: decidedWithoutFullProjection ? result.status : "INDETERMINATE_NEEDS_FULL_PROJECTION", reasons: result.reasons, realStatusIfForced: result.status };
    financialStatusCompleteness = decidedWithoutFullProjection ? COMPLETENESS.COMPLETE : COMPLETENESS.PARTIAL;
    if (!decidedWithoutFullProjection) {
      missing.push({
        field: "financialStatus",
        impact: "resultado do branch CRITICO/APERTADO não se aplica (freeMoney>=0 e cash físico não fica negativo) — decidir entre TRANQUILO/ATENÇÃO exige expected/stress projection completos, que dependem de Contingency/ConfirmedCommitment persistidos (Fase 5.1)",
        evidenceNeeded: "projeção expected/stress completa (pós-persistência)",
      });
    }

    // Fase 5.0.3, item 12 — floor/severity mínima: testa se as bills
    // domésticas PENDING/ESTIMATED (ex: Phone ~60, dueDate desconhecida)
    // PODERIAM mudar a classe do status. Ao contrário da Fase 5.0.2 (onde o
    // material era genuinamente desconhecido), aqui provamos matematicamente
    // se R$60 muda a classe — se não mudar, reportamos
    // possibleStatusWithKnownEstimates IGUAL a knownStatus, com a prova, em
    // vez de simplesmente marcar tudo como incerto.
    if (pendingEstimatedHouseholdBills.length > 0) {
      const worstCaseAdditional = pendingEstimatedTotal;
      const worstCaseFreeMoney = subtractMoney(freeMoney, worstCaseAdditional);
      const worstCaseMinBaseCash = minBaseCashBeforeIncome != null ? subtractMoney(minBaseCashBeforeIncome, worstCaseAdditional) : null;
      let possibleStatusWithKnownEstimates = financialStatus.status;
      if (worstCaseMinBaseCash != null && isNegative(worstCaseMinBaseCash)) {
        possibleStatusWithKnownEstimates = "CRITICO";
      } else if (isNegative(worstCaseFreeMoney) && financialStatus.status !== "APERTADO" && financialStatus.status !== "CRITICO") {
        possibleStatusWithKnownEstimates = "APERTADO";
      }
      financialStatus.knownStatus = financialStatus.status;
      financialStatus.possibleStatusWithKnownEstimates = possibleStatusWithKnownEstimates;
      financialStatus.estimatedAdditionalObligation = worstCaseAdditional.toString();
      financialStatus.estimatedAdditionalObligationSource = pendingEstimatedHouseholdBills.map((b) => b.name).join(", ");
      financialStatus.estimateNote =
        possibleStatusWithKnownEstimates !== financialStatus.status
          ? `Incluindo ${pendingEstimatedHouseholdBills.map((b) => b.name).join(", ")} (~${worstCaseAdditional.toString()}, valor ESTIMATED), o status poderia piorar de ${financialStatus.status} para ${possibleStatusWithKnownEstimates}.`
          : `PROVADO: mesmo incluindo ${pendingEstimatedHouseholdBills.map((b) => b.name).join(", ")} (~${worstCaseAdditional.toString()}) no pior caso, a classe do status NÃO muda — permanece ${financialStatus.status}. A base monetária EXATA (knownExactFreeMoney) ainda depende dessa confirmação, mas a CLASSIFICAÇÃO categórica está provada robusta a ela.`;
      // A classe categórica pode estar PROVADA robusta (COMPLETE) mesmo que a
      // base monetária exata (freeMoney) ainda dependa da confirmação do
      // Phone — são eixos de completude DIFERENTES (item 12).
      financialStatusCompleteness = possibleStatusWithKnownEstimates === financialStatus.status && decidedWithoutFullProjection ? COMPLETENESS.COMPLETE : COMPLETENESS.PARTIAL;
    }
  }

  // --- completeness granular (item 10 da Fase 5.0.1, ajustado pelo item 11
  // da Fase 5.0.3) — freeMoney (a base monetária EXATA) nunca é COMPLETE
  // enquanto existir bill doméstica PENDING/ESTIMATED do ciclo atual (ex:
  // Phone) que pode ou não pertencer ao horizonte atual. Isso é INDEPENDENTE
  // de financialStatusCompleteness (a CLASSIFICAÇÃO categórica), que pode
  // estar provada robusta mesmo com essa mesma incerteza — ver acima.
  const freeMoneyCompleteness = freeMoney == null ? COMPLETENESS.INCOMPLETE : pendingEstimatedHouseholdBills.length > 0 ? COMPLETENESS.PARTIAL : COMPLETENESS.COMPLETE;
  const safeToSpendCompleteness = freeMoneyCompleteness;
  const baseProjectionCompleteness = !baseProjectionLite ? COMPLETENESS.INCOMPLETE : projectionCrossesUnknownIncomeAmount ? COMPLETENESS.PARTIAL : COMPLETENESS.COMPLETE;
  const expectedProjectionCompleteness =
    baseProjectionCompleteness === COMPLETENESS.INCOMPLETE ? COMPLETENESS.INCOMPLETE : undatedRiskExposures.length > 0 || projectionCrossesUnknownIncomeAmount ? COMPLETENESS.PARTIAL : COMPLETENESS.COMPLETE;
  const stressProjectionCompleteness = expectedProjectionCompleteness;
  // COMPLETE exige data conhecida E valor real conhecido com certeza — um
  // valor PADRÃO/BASE quando variablePayExpected=true ainda deixa o valor
  // real incerto, então fica PARTIAL mesmo com o padrão confirmado.
  const nextIncomeCompleteness = !nextIncomeProposed.expectedDate
    ? COMPLETENESS.INCOMPLETE
    : expectedRecurringAmount != null && !variablePayExpected
      ? COMPLETENESS.COMPLETE
      : COMPLETENESS.PARTIAL;
  const nextIncomeCommitmentCompleteness = nextIncomeCommitmentWindow?.completeness ?? COMPLETENESS.INCOMPLETE;

  const componentCompletenesses = [
    freeMoneyCompleteness,
    safeToSpendCompleteness,
    baseProjectionCompleteness,
    expectedProjectionCompleteness,
    stressProjectionCompleteness,
    nextIncomeCompleteness,
    nextIncomeCommitmentCompleteness,
    financialStatusCompleteness,
  ];
  const overallCompleteness = componentCompletenesses.includes(COMPLETENESS.INCOMPLETE)
    ? COMPLETENESS.INCOMPLETE
    : componentCompletenesses.includes(COMPLETENESS.PARTIAL)
      ? COMPLETENESS.PARTIAL
      : COMPLETENESS.COMPLETE;

  return {
    balances: {
      totalBalances: totalBalances?.toString() ?? null,
      unrestrictedCash: unrestrictedCash?.toString() ?? null,
      restrictedBalance: restrictedBalance?.toString() ?? null,
      protectedMoney: protectedMoney.toString(),
    },
    obligations: {
      incurredLiabilities: { total: incurredLiabilities.toString(), items: incurredItems },
      currentHorizonObligations: { total: currentHorizonObligations.toString(), items: currentHorizonItems },
      futureObligations: { total: addMoney(futureObligationsFromCard, ZERO).toString(), items: futureItems },
      unfundedConfirmedCommitments: { count: unfundedConfirmedCommitments.count, amount: unfundedConfirmedCommitments.amount.toString(), items: unfundedConfirmedCommitments.items },
    },
    // Item 11 — knownExactFreeMoney é a MESMA fórmula de sempre (nunca inclui
    // estimativa); scenarioIncludingEstimatedPhone é só informativo, NUNCA
    // misturado no valor exato.
    freeMoney: freeMoney?.toString() ?? "INCOMPLETE",
    knownExactFreeMoney: freeMoney?.toString() ?? "INCOMPLETE",
    scenarioIncludingKnownEstimates:
      freeMoney != null && pendingEstimatedTotal.gt(0)
        ? { total: subtractMoney(freeMoney, pendingEstimatedTotal).toString(), includes: pendingEstimatedHouseholdBills.map((b) => b.name), note: "Cenário informativo — NÃO é o valor exato de freeMoney, inclui bill(s) com amountConfidence=ESTIMATED." }
        : null,
    safeToSpend: safeToSpend ? { safetyMarginPercent: safeToSpend.safetyMarginPercent, safetyReserve: safeToSpend.safetyReserve.toString(), safeToSpend: safeToSpend.safeToSpend.toString() } : "INCOMPLETE",
    nextIncome: {
      currentDbState: nextIncomeFromDb,
      proposedIfScheduleRuleExisted: {
        expectedDate: nextIncomeProposed.expectedDate?.toISOString() ?? null,
        status: nextIncomeProposed.status,
        isFallback: nextIncomeProposed.isFallback,
        scheduleConfidence,
        standardRecurringAmountConfidence,
        standardRecurringAmount: standardRecurringAmount?.toString() ?? "UNKNOWN",
        variablePayExpected,
        nextOccurrenceActualAmount: "UNKNOWN",
        note: "Schedule (dia do mês) e AMOUNT são evidências SEPARADAS. standardRecurringAmount é o valor PADRÃO/BASE confirmado — NÃO é o valor real da próxima ocorrência, que permanece UNKNOWN até acontecer (tende a ser MAIOR se variablePayExpected=true). RecurringRule ainda NÃO existe no banco (hipotético, não persistido).",
      },
    },
    nextIncomeCommitment: nextIncomeCommitmentWindow,
    nextIncomeWindowCommitmentCandidate,
    externalInstallments: {
      confirmedPlans: activeExternalInstallmentPlans.map((p) => ({ description: p.description, installmentValue: p.nextInstallmentAmount.toString(), paidInstallments: p.paidInstallments, installmentCount: p.installmentCount, remaining: p.remaining, confidence: p.confidence, source: p.source })),
      nextPackageTotal: nextExternalInstallmentPackageTotal.toString(),
      csvCoherenceCheck: externalInstallmentCsvCoherence,
      paymentTiming: externalInstallmentsTiming,
      enteredCurrentHorizon: false,
      note: "Posições CONFIRMADAS pelo usuário (CONFIRMED_BY_MEMORY) superam o UNKNOWN_PAYMENT_STATUS do CSV — CSV usado só como validação de coerência temporal (csvCoherenceCheck), nunca como fonte de status. NÃO entram em currentHorizonObligations nem reduzem freeMoney (timing confirmado: pago depois do salário).",
    },
    householdBills: {
      settled: settledHouseholdBills,
      pendingEstimated: pendingEstimatedHouseholdBills,
      pendingEstimatedTotal: pendingEstimatedTotal.toString(),
    },
    contingencyExposure: { expected: contingencyExpected.toString(), maximum: contingencyMax.toString(), items: contingencyItems, undatedRiskExposures, entersFreeMoneyBase: false },
    minBaseCashBeforeNextIncome: minBaseCashBeforeIncome?.toString() ?? null,
    baseTimeline: timelineWithBalances,
    financialStatus,
    completeness: {
      freeMoneyCompleteness,
      safeToSpendCompleteness,
      baseProjectionCompleteness,
      expectedProjectionCompleteness,
      stressProjectionCompleteness,
      nextIncomeCompleteness,
      nextIncomeCommitmentCompleteness,
      financialStatusCompleteness,
      overallCompleteness,
    },
    projectionsNote:
      "Timeline física construída 100% EM MEMÓRIA a partir do input proposto (card bills com dueAt real via lib/cardCycle.js, " +
      "ConfirmedCommitment com placeholder conservador de data, Contingency SEM data nunca inserida na timeline). " +
      "PARTIAL quando a projeção cruza uma ocorrência de renda com valor recorrente não confirmado, ou quando existe " +
      "exposição de contingência sem data (UNDATED_RISK_EXPOSURE) dentro do horizonte de 90 dias.",
    missingEvidence: missing,
    status: overallCompleteness,
  };
}

// ============================================================================
// U — Confidence/source matrix (item 16)
// ============================================================================
function buildConfidenceMatrix(input) {
  const rows = [];
  const push = (item, field, confidence) => rows.push({ item, field, confidence });

  if (input.checkingAccount) {
    push("Conta irrestrita — checkpointA", "amount", input.checkingAccount.checkpointA.confidence);
    push("Conta irrestrita — checkpointB", "amount", input.checkingAccount.checkpointB.confidence);
    for (const m of input.checkingAccount.movementsAfterCheckpointA || []) {
      push(`Movimento: ${m.description}`, "movimento (ocorrência do cash effect)", m.movementConfidence);
      push(`Movimento: ${m.description}`, "classificação econômica", m.economicClassification === "UNKNOWN" ? "UNCERTAIN (classificação não definida)" : "N/A — classificação já definida");
    }
  }
  if (input.restrictedAccount) {
    push("Conta restrita — recarga", "amount", input.restrictedAccount.recharge.confidence);
    push("Conta restrita — saldo observado", "amount", input.restrictedAccount.observedClosing.confidence);
  }
  if (input.mainIncome) push("Renda principal", "amount", input.mainIncome.confidence);
  for (const c of input.confirmedCommitments || []) {
    push(c.description, "amount", c.amountConfidence);
    push(c.description, "data", c.dateConfidence);
  }
  for (const c of input.contingencies || []) {
    push(c.description, "expectedAmount", c.expectedAmountConfidence);
    push(c.description, "maxAmount", c.maxAmountConfidence);
  }
  for (const e of input.otherEvidence || []) push(e.description, "amount", e.confidence);

  const allConfirmed = rows.every((r) => r.confidence === "CONFIRMED");
  return { rows, allMarkedConfirmed: allConfirmed, note: allConfirmed ? "ATENÇÃO: todo item está CONFIRMED — revisar se isso reflete a realidade da evidência disponível." : "Confiança variada, como esperado — nem tudo é CONFIRMED." };
}

// ============================================================================
// V — Proposed canonical snapshot (item 27) — visão consolidada, não persiste nada.
// ============================================================================
function buildProposedCanonicalSnapshot(input, cardReconciliation) {
  return {
    asOf: input.asOf,
    checkingAccount: input.checkingAccount ? { observed: money(input.checkingAccount.checkpointB.amount).toString() } : null,
    restrictedAccount: input.restrictedAccount ? { observed: money(input.restrictedAccount.observedClosing.amount).toString() } : null,
    card: input.card
      ? {
          limit: money(input.card.totalLimit).toString(),
          available: money(input.card.observedAvailable).toString(),
          used: cardReconciliation.usedLimitChecksum.usedLimitObserved,
          nextLiability: cardReconciliation.liabilityClassification.incurredLiability,
          future: cardReconciliation.liabilityClassification.futureObligations.total,
        }
      : null,
    externalTransfers: (input.externalTransfers || []).map((t) => ({
      purpose: t.purpose,
      amountTransferred: money(t.amountTransferred).toString(),
      destination: t.destination,
      date: t.date,
      personalReserveAfter: "0.00",
    })),
    confirmedCommitments: (input.confirmedCommitments || []).map((c) => ({ description: c.description, amount: money(c.amount).toString(), funding: c.funding, dateCandidates: c.dateCandidates })),
    contingencies: (input.contingencies || []).map((c) => ({ description: c.description, expected: c.expectedAmount != null ? money(c.expectedAmount).toString() : null, max: money(c.maxAmount).toString() })),
    note: "Somente fatos com evidência no input entram aqui — nada inventado.",
  };
}

// ============================================================================
// X — Proposed mutation plan da Fase 5.1 (item 28) — NÃO EXECUTA nada.
//
// 100% derivado do INPUT (arquivo local gitignored) — nenhum fato específico
// do usuário (nome de compromisso, valor, contraparte) pode aparecer
// hardcoded aqui: este arquivo é genérico e versionado. Cada `push()` abaixo
// só usa campos do parâmetro `input`/`inventory`/reconciliações já calculadas.
// ============================================================================
function buildProposedMutations(input, inventory, checkingRecon, vaRecon, cardRecon) {
  const mutations = [];
  const push = (m) => mutations.push({ blocker: null, riskOfDoubleCounting: "nenhum identificado", ...m });

  push({
    category: "KEEP",
    model: "Account/Card/RecurringRule já existentes",
    reference: "todos os registros estruturais já existentes no banco dev",
    before: "estado atual do dev (ver seção B — inventário)",
    after: "sem mudança",
    reason: "Nada nesta fase indica que esses registros estruturais estejam errados — só desatualizados em VALOR (que é reconciliação de dado, não de estrutura).",
    source: "N/A",
    confidence: "N/A",
    risk: "nenhum",
    requiredToClose: false,
  });

  // --- CardBill: UPDATE por row existente (nunca CREATE — constraint
  // cardId+cycleMonth já garante 1 row por ciclo), DELETE_ARTIFACT_CANDIDATE
  // pros artefatos zerados, NEEDS_EVIDENCE pros UNKNOWN. ---
  for (const cb of cardRecon?.persistedCardBillsClassified || []) {
    if (cb.classification === "CANONICAL_UPDATE_CANDIDATE") {
      push({
        category: "UPDATE",
        model: "CardBill",
        reference: `id=${cb.id} (cycleMonth=${cb.cycleMonth})`,
        before: `totalAmount=${cb.totalAmount}, paidAmount=${cb.paidAmount}, status=${cb.status}`,
        after: `totalAmount=${cb.knownRealAmount} (+ paidAmount/status derivados da realidade bancária confirmada)`,
        reason: cb.reasoning,
        source: "input do usuário (checkpoint bancário direto) cruzado com achado desta auditoria (seção N/O)",
        confidence: "conforme confidence da bill correspondente no input",
        risk: "médio — mudar Card.closingDay (mutation separada abaixo) também muda closesAt/dueAt desta mesma row; coordenar as duas mutações juntas, não isoladamente",
        riskOfDoubleCounting: "nenhum — é UPDATE de uma row já existente, não criação de uma nova (a constraint cardId+cycleMonth impede duplicata)",
        requiredToClose: true,
      });
    } else if (cb.classification === "KEEP_OR_PARTIAL_MATCH") {
      push({
        category: "KEEP",
        model: "CardBill",
        reference: `id=${cb.id} (cycleMonth=${cb.cycleMonth})`,
        before: `totalAmount=${cb.totalAmount}`,
        after: "sem mudança de totalAmount — mas revisar closesAt/dueAt se Card.closingDay mudar",
        reason: cb.reasoning,
        source: "achado desta auditoria (seção N/O)",
        confidence: "N/A",
        risk: "baixo",
        requiredToClose: false,
      });
    } else if (cb.classification === "CLEAR_ARTIFACT_CANDIDATE") {
      push({
        category: "DELETE_ARTIFACT_CANDIDATE",
        model: "CardBill",
        reference: `id=${cb.id} (cycleMonth=${cb.cycleMonth}, totalAmount=0)`,
        before: `row zerada, sem paidAmount, sem Transfer vinculado (Transfer.count=0 no banco inteiro)`,
        after: "remoção proposta — SEM efeito no cálculo do engine hoje (remaining=0 já é sempre SETTLED/ignorado por lib/obligationClassifier.js), efeito é só cosmético na UI de /cartoes",
        reason: cb.reasoning,
        source: "achado desta auditoria (seção N/O) — padrão de lote de materialização, Fase 4.1.2/4.1.3",
        confidence: "N/A",
        risk: "baixo — nenhum pagamento/transfer vinculado encontrado (verificado); ainda assim, revisar item a item antes de apagar, nunca em lote automático",
        riskOfDoubleCounting: "N/A — remoção, não criação",
        requiredToClose: false,
      });
    } else if (cb.classification === "UNKNOWN") {
      push({
        category: "NEEDS_EVIDENCE",
        model: "CardBill",
        reference: `id=${cb.id} (cycleMonth=${cb.cycleMonth}, totalAmount=${cb.totalAmount})`,
        before: `totalAmount=${cb.totalAmount}, sem valor real conhecido para este ciclo no input`,
        after: "N/A — nenhuma mutação proposta até o usuário confirmar se este valor reflete atividade real do cartão neste ciclo",
        reason: cb.reasoning,
        source: "achado desta auditoria (seção N/O)",
        confidence: "UNCERTAIN",
        risk: "médio se remaining>0 (contamina incurred/future) — ver wouldContaminateEngineIfLeftAsIs",
        requiredToClose: cb.wouldContaminateEngineIfLeftAsIs,
      });
    }
  }

  if (input.card?.closingDay != null) {
    const currentClosingDay = inventory.card?.rows?.[0]?.closingDay ?? null;
    const same = currentClosingDay === input.card.closingDay;
    push({
      category: same ? "KEEP" : "UPDATE",
      model: "Card",
      reference: "closingDay do cartão informado no input",
      before: `closingDay=${currentClosingDay === undefined ? "desconhecido" : currentClosingDay}`,
      after: `closingDay=${input.card.closingDay}`,
      reason: "Sem o closingDay real, getCardBillClosesAt/getCardBillDueDate usam a fórmula de fallback (mês calendário), que pode divergir do fechamento real do cartão.",
      source: "input do usuário",
      confidence: "conforme input",
      risk: same ? "nenhum — já está correto" : "médio — muda closesAt/dueAt de TODAS as CardBills existentes e futuras; rodar JUNTO com os UPDATEs de CardBill acima, não isoladamente (senão os dois ficam temporariamente inconsistentes entre si)",
      requiredToClose: !same,
    });
  }

  // --- Purchase(s) parceladas encontradas: NEEDS_EVIDENCE, nunca legacy/test
  // sem prova — usa o resultado real da auditoria (seção N). ---
  if (cardRecon?.purchaseAudit?.status === "FOUND") {
    for (const pa of cardRecon.purchaseAudit.purchases) {
      const partialMonths = pa.answerB_explainsRecurringComponent.filter((c) => c.explainsPartial).map((c) => c.billMonth);
      push({
        category: pa.answerE_conclusion === "LIKELY_REAL" && partialMonths.length === 0 ? "KEEP" : "NEEDS_EVIDENCE",
        model: "Purchase/Installment",
        reference: `id=${pa.purchase.id} ("${pa.purchase.description.slice(0, 60)}...")`,
        before: `explica exatamente ${pa.answerB_explainsRecurringComponent.filter((c) => c.exactMatch).length} known bill(s), explica PARCIALMENTE ${partialMonths.length} outra(s) (${partialMonths.join(", ") || "nenhuma"})`,
        after:
          partialMonths.length > 0
            ? "NENHUMA mutação proposta nesta própria Purchase — mas os known bills maiores (que ela só explica parcialmente) provavelmente têm OUTRAS compras reais ainda não capturadas no banco, que precisam ser investigadas/lançadas separadamente"
            : "sem mudança — evidência já suficiente pra manter como está",
        reason: `Conclusão da auditoria (item 5 do pedido): ${pa.answerE_conclusion}. NÃO marcada como legacy/test — ver evidenceForReal/evidenceForTestOrJunk na seção N/O do relatório completo.`,
        source: `Purchase.source="${pa.purchase.source}"`,
        confidence: pa.purchase.confidence ?? "null (não classificado)",
        risk: "baixo para esta Purchase em si; risco é de SUBESTIMAR o total real das faturas se as compras faltantes não forem encontradas antes da persistência dos CardBills corrigidos",
        riskOfDoubleCounting: "nenhum — esta Purchase já é read-only nesta fase; risco seria o OPOSTO (subcontagem), não dupla contagem",
        requiredToClose: false,
      });
    }
  }

  for (const m of input.checkingAccount?.movementsAfterCheckpointA || []) {
    if (m.type === "INFLOW") {
      push({
        category: "CREATE",
        model: "Income",
        reference: m.description,
        before: "N/A",
        after: `Income — accountId=<conta informada>, amount=${money(m.amount).toString()}, isRecurring=false (salvo evidência em contrário)`,
        reason: "É dinheiro NOVO entrando na conta — Income, não Transfer. NÃO vincular a nenhuma RecurringRule sem evidência explícita de que é a mesma ocorrência.",
        source: "input do usuário",
        confidence: m.movementConfidence,
        risk: "baixo",
        riskOfDoubleCounting: "nenhum, desde que este Income não seja também somado manualmente em nenhum BalanceAdjustment futuro pro mesmo período",
        requiredToClose: true,
      });
    } else if (m.type === "TRANSFER_OUT_EXTERNAL") {
      push({
        category: "CREATE",
        model: "Transfer",
        reference: m.description,
        before: m.formerlyModeledAs ? `anteriormente modelado como: ${m.formerlyModeledAs}` : "N/A",
        after: `Transfer{ fromAccountId: <conta informada>, toAccountId: null, toCardId: null, kind: 'external_transfer', description: '${m.description}', amount: ${money(m.amount).toString()} }`,
        reason: "Ver seção de auditoria de schema (R) — já suportado sem migration. NÃO cria Expense, NÃO cria Reserve, NÃO cria Account nova só pra representar o destino.",
        source: "input do usuário",
        confidence: m.movementConfidence,
        risk: "baixo — desde que 'external_transfer' seja adotado como convenção de kind documentada (não uma migration, só um valor de string novo)",
        riskOfDoubleCounting: "risco real se uma Reserve pessoal para a mesma finalidade for criada em paralelo — NÃO criar Reserve pessoal pra este valor (ele já saiu fisicamente da conta).",
        requiredToClose: true,
      });
    } else if (m.economicClassification === "EXPENSE" && m.economicClassificationConfidence === "CONFIRMED") {
      push({
        category: "CREATE",
        model: "Expense",
        reference: m.description,
        before: "N/A",
        after: `Expense — accountId=<conta informada>, amount=${money(m.amount).toString()}, category=<inspecionar categorias já existentes no schema antes de escolher; usar categoria genérica coerente já adotada, sem criar taxonomia nova>`,
        reason: `Classificação econômica confirmada explicitamente pelo usuário (${m.economicClassificationSource || "confirmação explícita"}) — não é mais um blocker.`,
        source: "input do usuário (confirmação explícita)",
        confidence: m.economicClassificationConfidence,
        risk: "baixo",
        requiredToClose: true,
      });
    } else if (m.economicClassification === "UNKNOWN") {
      push({
        category: "UNRESOLVED",
        model: "Transfer / Expense / Receivable (classificação econômica ainda não decidida)",
        reference: m.description,
        before: "N/A",
        after: "N/A — aguardando decisão do usuário",
        reason: "Movimento de caixa confirmado, mas classificação econômica explicitamente UNKNOWN — não presumir presente/pagamento/empréstimo/divisão de despesa sem confirmação.",
        source: "input do usuário",
        confidence: `movimento=${m.movementConfidence}, classificação=UNCERTAIN`,
        risk: "nenhum financeiro — mas bloqueia fechar 100% a modelagem do ledger até decisão",
        blocker: "classificação econômica pendente de decisão do usuário",
        requiredToClose: false,
      });
    }
  }

  // Fase 5.0.3, itens 4/21/22 — expenses canônicas da conta restrita: KEEP
  // pras já persistidas (dedup exato — nunca duplicar), CREATE só pras
  // MISSING_IN_DEV, NEEDS_EVIDENCE pras AMBIGUOUS_MATCH (revisão humana antes
  // de qualquer CREATE, pra não arriscar duplicar por engano).
  const expenseMatching = vaRecon?.canonicalLedger?.expenseMatching;
  if (expenseMatching) {
    for (const m of expenseMatching.matches) {
      if (m.classification === "ALREADY_PERSISTED") {
        push({
          category: "KEEP",
          model: "Expense (conta restrita)",
          reference: `${m.date} — ${m.counterparty} (${m.amount})`,
          before: `já persistido: id=${m.matchedDevExpenseId}, amount=${m.matchedDevAmount}`,
          after: "sem mudança",
          reason: "Match exato por valor — já está no banco, não duplicar.",
          source: vaRecon.canonicalLedger.source,
          confidence: "N/A",
          risk: "nenhum",
          riskOfDoubleCounting: "seria REAL se um CREATE fosse proposto aqui por engano — por isso esta linha é KEEP, não CREATE.",
          requiredToClose: false,
        });
      } else if (m.classification === "MISSING_IN_DEV") {
        push({
          category: "CREATE",
          model: "Expense (conta restrita)",
          reference: `${m.date} — ${m.counterparty} (${m.amount})`,
          before: "N/A — não encontrado no dev dentro da janela do ciclo",
          after: `Expense{ accountId: <conta restrita>, amount: ${m.amount}, occurredAt: ${m.date}, description: '${m.counterparty}' }`,
          reason: "Presente na lista canônica (evidência conversacional anterior do usuário), ausente no dev — SOMENTE depois de dedup exato (ver expenseMatching).",
          source: vaRecon.canonicalLedger.source,
          confidence: "conforme confidence do item canônico",
          risk: "baixo — dedup já feito por valor dentro da janela do ciclo",
          riskOfDoubleCounting: "baixo — já casado 1:1 contra o que existe no dev; ainda assim, revisar antes de criar em lote",
          requiredToClose: true,
        });
      } else if (m.classification === "AMBIGUOUS_MATCH") {
        push({
          category: "NEEDS_EVIDENCE",
          model: "Expense (conta restrita)",
          reference: `${m.date} — ${m.counterparty} (${m.amount})`,
          before: m.matchedDevExpenseId ? `candidato próximo: id=${m.matchedDevExpenseId}, amount=${m.matchedDevAmount}, delta=${m.delta}` : `múltiplos candidatos: ${(m.candidateDevExpenseIds || []).join(", ")}`,
          after: "N/A — revisão manual antes de KEEP ou CREATE",
          reason: `Match ${m.matchType} — não exato o suficiente pra decidir automaticamente.`,
          source: vaRecon.canonicalLedger.source,
          confidence: "UNCERTAIN",
          risk: "baixo valor, mas risco de dupla contagem se tratado como CREATE sem confirmar que já não está persistido",
          blocker: "match ambíguo — precisa confirmação humana",
          requiredToClose: false,
        });
      }
    }
  }

  // Item 3/22 — âncora de abertura da conta restrita: só PROPOSTA, nunca
  // executada — e só se a arquitetura futura realmente exigir uma âncora pro
  // cutoff (hoje o modelo já tolera começar sem BalanceAdjustment explícito).
  if (vaRecon?.canonicalLedger?.status === "PROVIDED") {
    push({
      category: "OPENING_ANCHOR_CANDIDATE",
      model: "BalanceAdjustment (conta restrita) — CANDIDATO, não aprovado",
      reference: `derivedOpeningBalanceVA = ${vaRecon.canonicalLedger.derivedOpeningBalanceVA}`,
      before: "sem âncora explícita de abertura pro cutoff atual",
      after: `SE necessário pela arquitetura: BalanceAdjustment{ accountId: <conta restrita>, newBalance: ${vaRecon.canonicalLedger.derivedOpeningBalanceVA}, occurredAt: <véspera da recarga>, confidence: RECONCILIATION_ADJUSTMENT }`,
      reason: "Representa saldo CARREGADO antes da recarga (carryover), não uma despesa/receita do ciclo — NÃO é uma transação inventada, é o residual matemático necessário pra fechar a equação com evidência canônica completa.",
      source: "derivado da equação canônica (ver seção L)",
      confidence: "RECONCILIATION_ADJUSTMENT (último recurso, só se a arquitetura exigir uma âncora)",
      risk: "baixo — valor pequeno (R$0,51), mas categoria distinta de CREATE normal de propósito (é reconciliação, não fato novo)",
      requiredToClose: false,
    });
  }

  // Item 5/22 — Income R$22-equivalente: UPDATE de accountId, não um novo
  // Income — o fato já existe, só a conta está errada.
  for (const r of vaRecon?.reclassifiedIncomes || []) {
    push({
      category: "UPDATE",
      model: "Income.accountId",
      reference: r.description,
      before: `accountId aponta pra conta restrita (${r.persistedAccountSlug})`,
      after: `accountId -> conta irrestrita (${r.canonicalAccountSlug})`,
      reason: r.note || "Evidência conversacional anterior confirma que este Income pertence a outra conta.",
      source: r.source,
      confidence: r.confidence,
      risk: "baixo — é uma correção de classificação, não um valor novo; não afeta o checkpoint já observado da conta de destino (que é saldo bancário direto, não somado a partir de registros)",
      riskOfDoubleCounting: "nenhum — é reclassificação, não duplicação",
      requiredToClose: false,
    });
  }

  // Item 6/9/22 — parcelas externas: agora CREATE_CANDIDATE (posição atual
  // CONFIRMADA pelo usuário), não mais NEEDS_EVIDENCE — due date exata
  // permanece UNKNOWN e pode continuar assim (timing geral já confirmado).
  for (const p of input.externalInstallmentPlans || []) {
    const remaining = p.installmentCount - p.paidInstallments;
    if (remaining <= 0) continue;
    push({
      category: "CREATE_CANDIDATE",
      model: "ExternalInstallmentPlan + ExternalInstallment",
      reference: p.description,
      before: "N/A — não persistido ainda",
      after: `ExternalInstallmentPlan{ description:'${p.description}', installmentValue:${money(p.installmentValue).toString()}, installmentCount:${p.installmentCount} } + ${p.paidInstallments} ExternalInstallment(s) PAID + ${remaining} PENDING (dueDate exata UNKNOWN, timing geral: ${input.externalInstallmentsPaymentTiming?.paymentTiming ?? "UNKNOWN"})`,
      reason: "Posição atual confirmada por evidência conversacional anterior (ver seção 8 — coerência com CSV quando disponível). Due date exata permanece UNKNOWN e não bloqueia mais a existência/posição do plano.",
      source: p.source,
      confidence: p.confidence,
      risk: "baixo pra existência/posição; devida atenção ao preencher `paidAt` dos históricos sem inventar datas exatas",
      requiredToClose: false,
    });
  }

  if (input.mainIncome) {
    const hasStandardAmount = input.mainIncome.standardRecurringAmountConfidence != null && input.mainIncome.standardRecurringAmount != null;
    push({
      category: "LINK",
      model: "RecurringRule (proposta) + Income.recurringOccurrenceDate",
      reference: `renda principal informada no input (dayOfMonth=${input.mainIncome.dayOfMonth})`,
      before: "Nenhuma RecurringRule cobrindo essa renda existe hoje no banco (ver seção Q)",
      after: `RecurringRule{ kind:'income', dayOfMonth:${input.mainIncome.dayOfMonth}${hasStandardAmount ? `, amount:${money(input.mainIncome.standardRecurringAmount).toString()} (padrão/base, valor real da ocorrência pode ser maior)` : " (sem amount fixo — valor padrão ainda não confirmado)"} } + Income vinculado via recurringOccurrenceDate=${input.mainIncome.date}`,
      reason: "Formaliza a renda principal, hoje invisível pro Financial Engine (que cai em FALLBACK sem ela). Schedule (dia do mês) e amount padrão/base são evidências separadas do valor REAL de cada ocorrência futura — ver seção Q.",
      source: "input do usuário",
      confidence: input.mainIncome.confidence,
      risk: "baixo",
      requiredToClose: false,
    });
  }

  for (const c of input.confirmedCommitments || []) {
    const dateNote = (c.dateCandidates || []).length > 1 ? `UNCERTAIN_DATE_RANGE entre: ${c.dateCandidates.join(" ou ")} — decidir antes de persistir` : c.dateCandidates?.[0] ?? "sem data";
    push({
      category: "CREATE",
      model: "ConfirmedCommitment",
      reference: c.description,
      before: "N/A",
      after: `ConfirmedCommitment{ description:'${c.description}', amount:${money(c.amount).toString()}, dueDate:<${dateNote}>, status:CONFIRMED, funding:${c.funding} }`,
      reason: "Compromisso confirmado, funding possivelmente indefinido — exatamente o caso de uso do model. Classificação de horizonte (freeMoney) já é segura mesmo com a data incerta (ver seção W) — só o dueDate exato precisa ser resolvido antes do INSERT.",
      source: "input do usuário",
      confidence: `amount=${c.amountConfidence}, data=${c.dateConfidence}`,
      risk: (c.dateCandidates || []).length > 1 ? "baixo pra classificação (não muda o bucket), médio pra precisão da projeção diária — resolver a data exata antes de persistir" : "baixo",
      requiredToClose: false,
    });
  }

  for (const c of input.contingencies || []) {
    push({
      category: "CREATE",
      model: "Contingency",
      reference: c.description,
      before: "N/A",
      after: `Contingency{ description:'${c.description}', expectedAmount:${c.expectedAmount != null ? money(c.expectedAmount).toString() : "null"}, maxAmount:${money(c.maxAmount).toString()}, status:${c.status}, expectedDate:null }`,
      reason: "Risco aguardando confirmação — não é obrigação confirmada, não deve reduzir freeMoney base. Sem expectedDate: exposição fica em contingencyExposure, nunca inserida na timeline com data inventada.",
      source: "input do usuário",
      confidence: `expectedAmount=${c.expectedAmountConfidence}, maxAmount=${c.maxAmountConfidence}`,
      risk: "baixo",
      requiredToClose: false,
    });
  }

  for (const e of input.otherEvidence || []) {
    push({
      category: "NEEDS_EVIDENCE",
      model: "N/A — evidência incompleta",
      reference: e.description,
      before: "N/A",
      after: "N/A — sem data e/ou conta de destino confirmada",
      reason: e.note || "Evidência insuficiente pra propor uma mutação concreta sem inventar dado (data, conta, ou classificação).",
      source: "input do usuário (memória, incompleta)",
      confidence: e.confidence,
      risk: "a avaliar quando a evidência completa existir",
      blocker: "data e/ou conta de destino não determinadas",
      requiredToClose: false,
    });
  }

  return mutations;
}

// ============================================================================
// Item 2 do pedido — BalanceAdjustment com confidence=RECONCILIATION_ADJUSTMENT
// é ÚLTIMO RECURSO. NUNCA aparece na lista de mutações aprovadas acima —
// só aqui, explicitamente separado, explicando sob quais condições futuras
// seria aceitável. Enquanto os deltas (conta irrestrita/conta restrita)
// permanecerem não investigados a fundo, nenhum dos dois é proposto pra execução.
// ============================================================================
function buildPotentialLastResortMutations(checkingRecon, vaRecon) {
  const potential = [];

  if (checkingRecon?.unexplainedDifference && checkingRecon.unexplainedDifference !== "0") {
    potential.push({
      model: "BalanceAdjustment",
      reference: "Account irrestrita — delta não explicado",
      currentDelta: checkingRecon.unexplainedDifference,
      wouldBe: `BalanceAdjustment{ newBalance: ${checkingRecon.checkpointB.amount}, confidence: RECONCILIATION_ADJUSTMENT }`,
      status: "NOT_PROPOSED_FOR_EXECUTION",
      acceptableOnlyIf: [
        "o saldo observado (checkpointB) for reconfirmado como confiável (ex: segunda leitura do extrato);",
        "TODAS as fontes de evidência disponíveis tiverem sido investigadas (extrato completo, notificações do banco, possíveis rendimentos/tarifas);",
        "o delta permanecer inexplicado mesmo assim;",
        "o usuário decidir explicitamente que precisa fechar o ledger operacional para seguir em frente, aceitando o resíduo como ajuste de reconciliação (não como fato reconstruído).",
      ],
    });
  }

  if (vaRecon?.residualOpeningFromKnownLedger && vaRecon.residualOpeningFromKnownLedger !== "0") {
    potential.push({
      model: "BalanceAdjustment",
      reference: "Account restrita — residual não explicado pelo ledger conhecido",
      currentDelta: vaRecon.residualOpeningFromKnownLedger,
      wouldBe: `BalanceAdjustment{ newBalance: ${vaRecon.observedClosing.amount}, confidence: RECONCILIATION_ADJUSTMENT }`,
      status: "NOT_PROPOSED_FOR_EXECUTION",
      acceptableOnlyIf: [
        "a fonte externa (extrato do vale-refeição/CSV — ver externalSourceInvestigation) for obtida e efetivamente não explicar o residual;",
        "os reviewCandidates desta reconciliação (padrão de backfill em lote, income atípico, data de recarga divergente) tiverem sido investigados individualmente;",
        "o residual permanecer sem explicação mesmo assim;",
        "o usuário decidir explicitamente aceitar o ajuste pra iniciar o ledger operacional da conta restrita.",
      ],
    });
  }

  return potential;
}

// ============================================================================
// Fase 5.1A, item 25 — MANIFESTO FINAL DE APPLY, formato estrito por entrada:
// sequence, operation, model, existingRecordId, naturalKey, before, after,
// amountEffectOnAccount, amountEffectOnLiability, source, confidence, reason,
// dependency, idempotencyCheck, rollbackStrategy, status. AINDA NÃO EXECUTADO
// — só a estrutura exata que a Fase 5.1B vai seguir. Faz leituras read-only no
// banco (nunca escreve) pra resolver ids reais de dedup — nunca assume dedup
// só por VALOR (achado desta fase: várias Expenses de R$50 já existem no
// Itaú por motivos completamente diferentes — gasolina, cabelo, pix pra
// terceiros —, então dedup por valor sozinho seria falso-positivo; dedup
// exige valor + data + proximidade de descrição).
// ============================================================================
async function buildFullApplyManifest(input, { cardRecon, itauOperationalLedger, centLevelScenarios, vaExpenseMatching } = {}) {
  const entries = [];
  let seq = 0;
  const push = (e) => {
    seq += 1;
    entries.push({ sequence: seq, dependency: [], idempotencyCheck: "N/A", rollbackStrategy: "N/A", ...e });
    return seq;
  };

  const itauAccount = input.checkingAccount?.slug ? await prisma.account.findUnique({ where: { slug: input.checkingAccount.slug } }) : null;
  const vaAccount = input.restrictedAccount?.slug ? await prisma.account.findUnique({ where: { slug: input.restrictedAccount.slug } }) : null;
  const cardRow = input.card?.slug ? await prisma.card.findUnique({ where: { slug: input.card.slug } }) : null;

  const seqPreflight = push({
    operation: "PREFLIGHT",
    model: "N/A",
    existingRecordId: null,
    naturalKey: "N/A",
    before: "N/A",
    after: "N/A",
    amountEffectOnAccount: null,
    amountEffectOnLiability: null,
    source: "N/A",
    confidence: "N/A",
    reason: "Ver buildPreflightAssertions() — deve rodar e passar 100% antes de qualquer item abaixo ser executado pela Fase 5.1B.",
    rollbackStrategy: "Abortar o script inteiro antes de qualquer write.",
    status: "APPROVED_CANDIDATE",
  });

  // --- Card.closingDay ---
  let seqClosingDay = seqPreflight;
  if (cardRow && input.card?.closingDay != null) {
    const same = cardRow.closingDay === input.card.closingDay;
    seqClosingDay = push({
      operation: same ? "KEEP" : "UPDATE",
      model: "Card",
      existingRecordId: cardRow.id,
      naturalKey: `slug=${input.card.slug}`,
      before: { closingDay: cardRow.closingDay },
      after: { closingDay: input.card.closingDay },
      amountEffectOnAccount: null,
      amountEffectOnLiability: null,
      source: "input do usuário (dado bancário direto)",
      confidence: "CONFIRMED",
      reason: same ? "closingDay já está correto — nenhuma mudança." : "closingDay real confirmado (dia 4) — necessário pra closesAt/dueAt corretos das CardBills; rows já persistidas mantêm seu closesAt/dueAt já gravado (não recomputam sozinhas), então este UPDATE por si só não corrige retroativamente closesAt/dueAt já persistidos — só ciclos futuros.",
      dependency: [seqPreflight],
      idempotencyCheck: `Card.findUnique({ where: { slug: '${input.card.slug}' } }).closingDay === ${input.card.closingDay}`,
      rollbackStrategy: `UPDATE Card SET closingDay = ${JSON.stringify(cardRow.closingDay)} WHERE id='${cardRow.id}'`,
      status: "APPROVED_CANDIDATE",
    });
  }

  // --- CardBill manifest por id (item 14), reshapeado pro formato estrito ---
  for (const cb of cardRecon?.cardBillManifestById || []) {
    const statusMap = { KEEP: "APPROVED_CANDIDATE", UPDATE: "APPROVED_CANDIDATE", DELETE_ARTIFACT_CANDIDATE: "DELETE_ARTIFACT_CANDIDATE", DEFER_UNKNOWN: "DEFER" };
    if (cb.proposedAction === "KEEP") continue; // sem mutação real a listar
    push({
      operation: cb.proposedAction === "DELETE_ARTIFACT_CANDIDATE" ? "DELETE" : cb.proposedAction === "DEFER_UNKNOWN" ? "DEFER" : "UPDATE",
      model: "CardBill",
      existingRecordId: cb.id,
      naturalKey: `cardId=${cardRow?.id ?? "?"}, cycleMonth=${cb.cycleMonth}`,
      before: cb.current,
      after: cb.proposedAction === "UPDATE" ? cb.canonical : "N/A",
      amountEffectOnAccount: null,
      amountEffectOnLiability: cb.proposedAction === "UPDATE" ? `liability do ciclo ${cb.cycleMonth}: ${cb.current.totalAmount} -> ${cb.canonical.totalAmount}` : null,
      source: "input do usuário (fatura real) cruzado com achado desta auditoria",
      confidence: cb.proposedAction === "UPDATE" ? "CONFIRMED" : "UNCERTAIN",
      reason: cb.reason,
      dependency: [seqClosingDay],
      idempotencyCheck: `CardBill.findUnique({ where: { id: '${cb.id}' } })` + (cb.proposedAction === "UPDATE" ? ` já tem totalAmount=${cb.canonical.totalAmount} && status='${cb.canonical.status}'` : ""),
      rollbackStrategy: cb.proposedAction === "UPDATE" ? `UPDATE de volta para totalAmount=${cb.current.totalAmount}, paidAmount=${cb.current.paidAmount}, status='${cb.current.status}'` : cb.proposedAction === "DELETE_ARTIFACT_CANDIDATE" ? "Recriar a row com os mesmos valores (id novo — CUIDADO: perde o id original; preferir soft-verificação antes de deletar de fato)" : "N/A",
      // Achado desta rodada: DEFER_UNKNOWN com wouldContaminateEngineIfLeftAsIs
      // NUNCA pode ficar como "DEFER" simples — verificado por execução real de
      // resolveCurrentRelevantCardBillCycleMonth que, se esta row ficar como
      // está, ELA (não a bill canônica correta) é eleita como INCURRED_LIABILITY
      // por ter closesAt mais cedo. Isso é um BLOCKER de verdade, não uma
      // pendência que só aguarda uma data futura — precisa de decisão explícita
      // (UPDATE/SETTLE/DELETE_ARTIFACT) antes de qualquer declaração de "card
      // state reconciliado". Ver Z7 pra prova por execução real.
      status: cb.proposedAction === "DEFER_UNKNOWN" && cb.contaminationRisk ? "BLOCKED" : (statusMap[cb.proposedAction] ?? "DEFER"),
    });
  }

  // --- Item 15: pagamento de fatura de cartão dentro do lote operacional ---
  // Genérico: encontra QUALQUER movimento com settlesCardBillCycleMonth no
  // lote de operationalHistoryEvidence (nunca hardcoda um ciclo/valor
  // específico) — faz parte de um lote sem data individual confirmada, então
  // NÃO é proposto pra criação nesta fase (criar exigiria inventar
  // occurredAt). É representado, por ora, só de forma agregada em
  // netOperationalMovements (ver N2/item 6-9).
  const cardBillPaymentMovement = (input.checkingAccount?.operationalHistoryEvidence?.operationalLedgerCandidates || []).find((m) => m.settlesCardBillCycleMonth);
  if (cardBillPaymentMovement) {
    const paymentCycle = cardBillPaymentMovement.settlesCardBillCycleMonth;
    const paymentAmountAbs = money(cardBillPaymentMovement.amount).abs().toString();
    const targetCardBillId = cardRecon?.cardBillManifestById?.find((cb) => cb.cycleMonth === paymentCycle)?.id ?? null;
    push({
      operation: "DEFER",
      model: "Transfer (kind=card_bill_payment)",
      existingRecordId: null,
      naturalKey: `cardBillId=${targetCardBillId ?? "?"} (cycleMonth=${paymentCycle})`,
      before: "N/A — nenhum Transfer de pagamento de fatura persistido pra este ciclo",
      after: `SE/QUANDO a data exata for confirmada: Transfer{ fromAccountId: '${itauAccount?.id ?? "<itau>"}', toCardId: '${cardRow?.id ?? "<card>"}', cardBillId: '${targetCardBillId ?? `<cardbill de ${paymentCycle}, após seu UPDATE>`}', kind: 'card_bill_payment', amount: ${paymentAmountAbs}, occurredAt: <DATA EXATA AINDA NÃO CONFIRMADA> } — explicitamente NÃO um Expense.`,
      amountEffectOnAccount: `-${paymentAmountAbs} (Itaú) — já incluído agregadamente em netOperationalMovements (ver N2), não seria um efeito NOVO se este Transfer fosse criado depois, só tornaria explícito/datado um efeito já contado no agregado.`,
      amountEffectOnLiability: `Settle da liability do ciclo ${paymentCycle} — já refletido separadamente pelo UPDATE de CardBill (id acima) com paidAmount=${paymentAmountAbs}/status=paid.`,
      source: "operationalHistoryEvidence — lote de movimentos operacionais",
      confidence: "CONFIRMED (valor e fato) / UNKNOWN (data exata)",
      reason:
        "Representar isto como Transfer real exigiria um occurredAt específico, que não está confirmado individualmente (só a janela do lote). Criar com uma data escolhida seria inventar dado, proibido explicitamente. O lado da OBRIGAÇÃO (CardBill) já é resolvido pelo UPDATE correspondente (natural key by cardId+cycleMonth, nunca duplica); o lado do CAIXA fica corretamente registrado apenas de forma agregada (netOperationalMovements) até a data exata ser confirmada.",
      dependency: [seqClosingDay],
      idempotencyCheck: "N/A — não proposto pra execução nesta fase.",
      rollbackStrategy: "N/A",
      status: "DEFER",
    });
  }

  // --- Item 5/17: reclassificação de Income entre contas — UPDATE Income.accountId (fato já existe, nunca cria um novo) ---
  for (const r of input.reclassifiedIncomes || []) {
    const existing = vaAccount
      ? await prisma.income.findFirst({ where: { accountId: vaAccount.id, amount: money(r.amount).toNumber(), description: r.description } })
      : null;
    push({
      operation: existing ? "UPDATE" : "BLOCKED",
      model: "Income",
      existingRecordId: existing?.id ?? null,
      naturalKey: `accountId=${vaAccount?.id ?? "?"}, amount=${r.amount}, description="${r.description}"`,
      before: existing ? { accountId: existing.accountId, occurredAt: existing.occurredAt.toISOString() } : "NÃO ENCONTRADO — reference não localizada por valor+descrição exatos",
      after: existing ? { accountId: itauAccount?.id ?? "<itau>" } : "N/A",
      amountEffectOnAccount: `VA: -${money(r.amount).toString()}; Itaú: +${money(r.amount).toString()} — SEM mudança no totalBalances agregado (é reclassificação, não fato novo)`,
      amountEffectOnLiability: null,
      source: r.source,
      confidence: r.confidence,
      reason: r.note || "Evidência conversacional anterior confirma que este Income pertence à conta irrestrita, não à restrita.",
      dependency: [seqPreflight],
      idempotencyCheck: existing ? `Income.findUnique({ where: { id: '${existing.id}' } }).accountId === '${itauAccount?.id}'` : "N/A",
      rollbackStrategy: existing ? `UPDATE Income.accountId de volta para '${vaAccount?.id}'` : "N/A",
      status: existing ? "APPROVED_CANDIDATE" : "BLOCKED",
      _accountEffects: existing ? [{ accountId: vaAccount?.id, delta: subtractMoney(ZERO, money(r.amount)).toString() }, { accountId: itauAccount?.id, delta: money(r.amount).toString() }] : [],
    });
  }

  // --- movementsAfterCheckpointA (férias/CNPJ/namorada) — dedup real por
  // valor + data (NUNCA só valor — achado desta fase: 10 Expenses de R$50 já
  // existem no Itaú por razões completamente diferentes). ---
  for (const m of input.checkingAccount?.movementsAfterCheckpointA || []) {
    const dateOnly = m.date;
    let dup = null;
    let allByAmount = [];
    if (itauAccount) {
      if (m.type === "INFLOW") {
        allByAmount = await prisma.income.findMany({ where: { accountId: itauAccount.id, amount: money(m.amount).toNumber() } });
      } else if (m.type === "TRANSFER_OUT_EXTERNAL") {
        allByAmount = await prisma.transfer.findMany({ where: { fromAccountId: itauAccount.id, amount: money(m.amount).toNumber() } });
      } else {
        allByAmount = await prisma.expense.findMany({ where: { accountId: itauAccount.id, amount: money(m.amount).toNumber() } });
      }
      dup = allByAmount.find((c) => c.occurredAt.toISOString().slice(0, 10) === dateOnly) ?? null;
    }
    const dedupNote = `Encontrado(s) ${allByAmount.length} registro(s) com o MESMO VALOR no Itaú (dedup por valor sozinho seria falso-positivo — ver ids: ${allByAmount.map((c) => c.id).join(", ") || "nenhum"}); ${dup ? `MAS um deles bate também na MESMA DATA (${dateOnly}): id=${dup.id} — tratado como possível duplicata real.` : `NENHUM bate também na mesma data (${dateOnly}) — nenhuma duplicata real encontrada.`}`;

    if (m.type === "INFLOW") {
      push({
        operation: dup ? "BLOCKED" : "CREATE",
        model: "Income",
        existingRecordId: dup?.id ?? null,
        naturalKey: `accountId=${itauAccount?.id ?? "?"}, amount=${m.amount}, occurredAt=${dateOnly}`,
        before: "N/A",
        after: dup ? "N/A — revisar antes de criar, possível duplicata" : { accountId: itauAccount?.id ?? "<itau>", amount: money(m.amount).toString(), occurredAt: m.date, description: m.description, isRecurring: false, recurringRuleId: null },
        amountEffectOnAccount: `Itaú: +${money(m.amount).toString()}`,
        amountEffectOnLiability: null,
        source: "input do usuário",
        confidence: m.movementConfidence,
        reason: `${dedupNote} NÃO vincular a nenhuma RecurringRule (é receita atípica, não o salário mensal).`,
        dependency: [seqPreflight],
        idempotencyCheck: dedupNote,
        rollbackStrategy: "DELETE do Income criado (por id retornado no momento da criação)",
        status: dup ? "BLOCKED" : "APPROVED_CANDIDATE",
        _accountEffects: dup ? [] : [{ accountId: itauAccount?.id, delta: money(m.amount).toString() }],
      });
    } else if (m.type === "TRANSFER_OUT_EXTERNAL") {
      push({
        operation: dup ? "BLOCKED" : "CREATE",
        model: "Transfer",
        existingRecordId: dup?.id ?? null,
        naturalKey: `fromAccountId=${itauAccount?.id ?? "?"}, amount=${m.amount}, occurredAt=${dateOnly}`,
        before: "N/A",
        after: dup ? "N/A — revisar antes de criar, possível duplicata" : { fromAccountId: itauAccount?.id ?? "<itau>", toAccountId: null, toCardId: null, kind: "external_transfer", amount: money(m.amount).toString(), occurredAt: m.date, description: m.description },
        amountEffectOnAccount: `Itaú: -${money(m.amount).toString()}`,
        amountEffectOnLiability: null,
        source: "input do usuário",
        confidence: m.movementConfidence,
        reason: `${dedupNote} NÃO criar Account nova pro CNPJ, NÃO criar Reserve pessoal — dinheiro já saiu fisicamente (ver auditTransferSchemaForExternalScope, seção R).`,
        dependency: [seqPreflight],
        idempotencyCheck: dedupNote,
        rollbackStrategy: "DELETE do Transfer criado (por id retornado no momento da criação)",
        status: dup ? "BLOCKED" : "APPROVED_CANDIDATE",
        _accountEffects: dup ? [] : [{ accountId: itauAccount?.id, delta: subtractMoney(ZERO, money(m.amount)).toString() }],
      });
    } else if (m.economicClassification === "EXPENSE" && m.economicClassificationConfidence === "CONFIRMED") {
      push({
        operation: dup ? "BLOCKED" : "CREATE",
        model: "Expense",
        existingRecordId: dup?.id ?? null,
        naturalKey: `accountId=${itauAccount?.id ?? "?"}, amount=${m.amount}, occurredAt=${dateOnly}`,
        before: "N/A",
        after: dup ? "N/A — revisar antes de criar, possível duplicata" : { accountId: itauAccount?.id ?? "<itau>", amount: money(m.amount).toString(), occurredAt: m.date, description: m.description, category: "Outros (revisar taxonomia existente antes de escolher)" },
        amountEffectOnAccount: `Itaú: -${money(m.amount).toString()}`,
        amountEffectOnLiability: null,
        source: "input do usuário (confirmação explícita)",
        confidence: m.economicClassificationConfidence,
        reason: dedupNote,
        dependency: [seqPreflight],
        idempotencyCheck: dedupNote,
        rollbackStrategy: "DELETE do Expense criado (por id retornado no momento da criação)",
        status: dup ? "BLOCKED" : "APPROVED_CANDIDATE",
        _accountEffects: dup ? [] : [{ accountId: itauAccount?.id, delta: subtractMoney(ZERO, money(m.amount)).toString() }],
      });
    }
  }

  // --- Item 20: renda recorrente principal — CREATE RecurringRule + LINK Income existente ---
  let seqRecurringRule = null;
  if (input.mainIncome && itauAccount) {
    const existingRule = await prisma.recurringRule.findFirst({ where: { kind: "income", accountId: itauAccount.id } });
    const hasStandardAmount = input.mainIncome.standardRecurringAmountConfidence != null && input.mainIncome.standardRecurringAmount != null;
    seqRecurringRule = push({
      operation: existingRule ? "KEEP" : "CREATE",
      model: "RecurringRule",
      existingRecordId: existingRule?.id ?? null,
      naturalKey: `kind=income, accountId=${itauAccount.id}, dayOfMonth=${input.mainIncome.dayOfMonth}`,
      before: existingRule ? existingRule : "N/A — nenhuma RecurringRule de renda existe hoje para a conta irrestrita (verificado: a única RecurringRule kind=income hoje é a recarga do VA, conta diferente)",
      after: existingRule ? "sem mudança" : { name: "Salário", kind: "income", dayOfMonth: input.mainIncome.dayOfMonth, accountId: itauAccount.id, amount: hasStandardAmount ? money(input.mainIncome.standardRecurringAmount).toString() : null },
      amountEffectOnAccount: null,
      amountEffectOnLiability: null,
      source: "input do usuário",
      confidence: input.mainIncome.confidence,
      reason: "Formaliza a renda principal, hoje invisível pro Financial Engine (cai em FALLBACK sem RecurringRule). amount é o PADRÃO/BASE — o valor REAL de cada ocorrência pode ser maior (horas extras) e é registrado no Income individual, não aqui.",
      dependency: [seqPreflight],
      idempotencyCheck: `RecurringRule.findFirst({ where: { kind:'income', accountId:'${itauAccount.id}' } }) !== null`,
      rollbackStrategy: existingRule ? "N/A" : "DELETE da RecurringRule criada (por id retornado no momento da criação) — verificar antes que nenhum Income já tenha sido linkado a ela",
      status: "APPROVED_CANDIDATE",
    });

    const salaryOccurrence = await prisma.income.findFirst({
      where: { accountId: itauAccount.id, amount: money(input.mainIncome.amount).toNumber(), recurringOccurrenceDate: null },
      orderBy: { occurredAt: "asc" },
    });
    push({
      operation: salaryOccurrence ? "LINK" : "BLOCKED",
      model: "Income.recurringOccurrenceDate",
      existingRecordId: salaryOccurrence?.id ?? null,
      naturalKey: `accountId=${itauAccount.id}, amount=${input.mainIncome.amount}, recurringOccurrenceDate=${input.mainIncome.date}`,
      before: salaryOccurrence ? { recurringRuleId: salaryOccurrence.recurringRuleId, recurringOccurrenceDate: salaryOccurrence.recurringOccurrenceDate, occurredAt: salaryOccurrence.occurredAt.toISOString() } : "NÃO ENCONTRADO",
      after: salaryOccurrence ? { recurringRuleId: "<id da RecurringRule acima>", recurringOccurrenceDate: input.mainIncome.date } : "N/A",
      amountEffectOnAccount: null,
      amountEffectOnLiability: null,
      source: "input do usuário",
      confidence: input.mainIncome.confidence,
      reason:
        "Vincula a ocorrência de 24/08 JÁ PERSISTIDA à RecurringRule — NUNCA cria um Income novo pra essa mesma ocorrência (evitaria duplicar R$4.937,18 na renda). Nota: occurredAt desta row (data em que foi REGISTRADA) pode diferir de recurringOccurrenceDate (qual ocorrência AGENDADA ela cumpre) — são campos com semânticas diferentes por desenho do schema.",
      dependency: [seqRecurringRule],
      idempotencyCheck: salaryOccurrence ? `Income.findUnique({ where: { id: '${salaryOccurrence.id}' } }).recurringOccurrenceDate === '${input.mainIncome.date}'` : "N/A",
      rollbackStrategy: salaryOccurrence ? `UPDATE Income SET recurringRuleId=null, recurringOccurrenceDate=null WHERE id='${salaryOccurrence.id}'` : "N/A",
      status: salaryOccurrence ? "APPROVED_CANDIDATE" : "BLOCKED",
    });
  }

  // --- Item 6/9: 9 planos de parcela externa — BLOQUEADO por firstDueDate
  // NOT NULL no schema, quando só o timing GERAL é conhecido (nunca a data
  // exata do primeiro vencimento) — achado desta fase, não presente nas
  // fases anteriores (que não tinham checado esta constraint específica). ---
  const planCount = await prisma.externalInstallmentPlan.count();
  for (const p of input.externalInstallmentPlans || []) {
    const remaining = p.installmentCount - p.paidInstallments;
    if (remaining <= 0) continue;
    push({
      operation: "BLOCKED",
      model: "ExternalInstallmentPlan + ExternalInstallment",
      existingRecordId: null,
      naturalKey: `description="${p.description}"`,
      before: "N/A",
      after: `SE desbloqueado: ExternalInstallmentPlan{ description:'${p.description}', creditor:<confirmar>, installmentValue:${money(p.installmentValue).toString()}, installmentCount:${p.installmentCount}, firstDueDate:<BLOQUEADO> } + ${p.paidInstallments} ExternalInstallment(s) status=PAID com paidAt=null e expenseId=null (convenção já suportada pelo schema pra parcela paga antes do início do histórico operacional — ver P3) + ${remaining} PENDING`,
      amountEffectOnAccount: null,
      amountEffectOnLiability: `+${money(p.installmentValue).toString()} por parcela PENDING restante (${remaining}x)`,
      source: p.source,
      confidence: p.confidence,
      reason: `ExternalInstallmentPlan.firstDueDate é NOT NULL no schema, mas só o timing GERAL é conhecido (${input.externalInstallmentsPaymentTiming?.paymentTiming ?? "UNKNOWN"}), não a data exata do primeiro vencimento — setar qualquer data específica aqui seria inventar dado. Posição atual (paidInstallments/installmentCount) está CONFIRMADA e pronta pra uso assim que uma data (ou uma convenção explicitamente aprovada pelo usuário, ex: 'usar o dia do salário como estimativa marcada') for fornecida.`,
      dependency: [seqPreflight],
      idempotencyCheck: `ExternalInstallmentPlan.count() atualmente = ${planCount} (nenhum plano existente ainda — confirmado)`,
      rollbackStrategy: "N/A — não proposto pra execução nesta fase",
      status: "BLOCKED",
    });
  }

  // --- Itens 2-3 (VA opening anchor) e 6-9 (Itaú opening) e checkpoint delta ---
  // Nota de política: TODA ambiguidade que aparece em centLevelScenarios.ambiguities
  // é, por construção (ver buildCentLevelScenarios), de candidato ÚNICO
  // (matchType=NEAR_AMOUNT) — a política "canônico vence por padrão" (aplicada
  // acima na correspondente UPDATE de Expense) já resolve qual valor usar.
  // Isso NUNCA vira BLOCKED por causa da ambiguidade em si (só um
  // MULTIPLE_*_CANDIDATES, que é um caso DIFERENTE, tratado à parte acima,
  // continuaria bloqueado). A âncora de abertura em si, porém, segue SEMPRE
  // DEFER (nunca auto-aprovada) — mesmo tratamento dado à âncora do Itaú.
  const centAmb = centLevelScenarios?.ambiguities?.[0] ?? null;
  push({
    operation: "OPENING_ANCHOR_CANDIDATE",
    model: "BalanceAdjustment (conta restrita) — NÃO APROVADO",
    existingRecordId: null,
    naturalKey: "VA_OPENING_ANCHOR",
    before: "sem âncora explícita",
    after: centAmb
      ? `SE aprovado no futuro: BalanceAdjustment{ accountId:'${vaAccount?.id ?? "<va>"}', newBalance: ${centAmb.scenarioA_canonicalIsCorrect.derivedOpeningBalanceVA}, confidence: DERIVED_ONLY } — valor resolvido via Cenário A (canônico confirmado); Cenário B (${centAmb.scenarioB_devIsCorrect.derivedOpeningBalanceVA}) preservado só como histórico em M2, não é mais candidato de apply.`
      : "sem ambiguidade near-amount pendente nesta rodada — ver M2",
    amountEffectOnAccount: null,
    amountEffectOnLiability: null,
    source: "derivado da equação canônica (seção L) — ver M2 pros dois cenários",
    confidence: "DERIVED_ONLY — nunca confundir com saldo comprovado por extrato",
    reason: centAmb
      ? `Ambiguidade de ${centAmb.item.delta} (${centAmb.item.counterparty}, ${centAmb.item.date}) resolvida pela política 'canônico vence' (candidato único, ver UPDATE de Expense correspondente acima) — mas a âncora de abertura em si segue não executada automaticamente nesta fase, como qualquer opening anchor.`
      : "Sem ambiguidade centavo-a-centavo identificada nesta rodada.",
    dependency: [seqPreflight],
    idempotencyCheck: "N/A",
    rollbackStrategy: "N/A",
    status: "DEFER",
  });
  push({
    operation: "OPENING_ANCHOR_CANDIDATE",
    model: "BalanceAdjustment (conta irrestrita) — NÃO APROVADO",
    existingRecordId: null,
    naturalKey: "ITAU_OPERATIONAL_OPENING_ANCHOR",
    before: "sem âncora operacional explícita pro cutoff 24/08",
    after: `SE aprovado no futuro: BalanceAdjustment{ accountId:'${itauAccount?.id ?? "<itau>"}', newBalance: ${itauOperationalLedger?.derivedOpeningBalanceItau ?? "?"}, occurredAt: ${itauOperationalLedger?.operationalHistoryStart ?? "<operationalHistoryStart>"}, confidence: DERIVED_ONLY }`,
    amountEffectOnAccount: null,
    amountEffectOnLiability: null,
    source: `reconcileItauOperationalLedger — ${itauOperationalLedger?.movementCount ?? "?"} movimentos candidatos, ver N2`,
    confidence: "DERIVED_ONLY — nunca confundir com saldo comprovado por extrato",
    reason: `derivedOpeningBalanceItau = checkpointA (${itauOperationalLedger?.checkpointA ?? "?"}) - netOperationalMovements (${itauOperationalLedger?.netOperationalMovements ?? "?"}) = ${itauOperationalLedger?.derivedOpeningBalanceItau ?? "?"}. Gap vs saldo evidenciado em 20/08 = ${itauOperationalLedger?.gapVsEvidenced20Aug ?? "?"} — NÃO preenchido com movimentos inventados entre 21-23/08.`,
    dependency: [seqPreflight],
    idempotencyCheck: "N/A",
    rollbackStrategy: "N/A",
    status: "DEFER",
  });
  push({
    operation: "N/A",
    model: "N/A — apenas registro de não-ação",
    existingRecordId: null,
    naturalKey: "ITAU_POST_CHECKPOINT_DELTA_0_03",
    before: "delta de +0,03 entre checkpointA reconciliado e checkpointB observado (issue SEPARADA, já existente desde fases anteriores)",
    after: "SEM MUDANÇA — não absorvido na âncora de abertura operacional (item acima), permanece separado e não resolvido",
    amountEffectOnAccount: null,
    amountEffectOnLiability: null,
    source: "fases anteriores (5.0.x) — reafirmado aqui explicitamente",
    confidence: "UNRESOLVED_POST_CHECKPOINT_DIFFERENCE",
    reason: "O usuário foi explícito: este +0,03 é uma questão POSTERIOR no tempo (depois de checkpointA) e não deve ser absorvido no opening balance operacional (que é ANTES/NO cutoff de 24/08).",
    dependency: [seqPreflight],
    idempotencyCheck: "N/A",
    rollbackStrategy: "N/A",
    status: "BLOCKED",
  });

  // --- Item 21: Tattoo — BLOQUEADO por ConfirmedCommitment.dueDate NOT NULL ---
  for (const c of input.confirmedCommitments || []) {
    const multiDate = (c.dateCandidates || []).length > 1;
    push({
      operation: multiDate ? "DEFER" : "CREATE",
      model: "ConfirmedCommitment",
      existingRecordId: null,
      naturalKey: `description="${c.description}"`,
      before: "N/A",
      after: multiDate ? `BLOQUEADO: ConfirmedCommitment.dueDate é NOT NULL no schema; candidatas (${c.dateCandidates.join(" ou ")}) não decididas — escolher uma arbitrariamente seria inventar dado.` : `ConfirmedCommitment{ description:'${c.description}', amount:${money(c.amount).toString()}, dueDate:'${c.dateCandidates?.[0]}', status:CONFIRMED }`,
      amountEffectOnAccount: null,
      amountEffectOnLiability: `+${money(c.amount).toString()} se/quando criado`,
      source: "input do usuário",
      confidence: `amount=${c.amountConfidence}, data=${c.dateConfidence}`,
      reason: multiDate ? "dueDate é campo obrigatório (NOT NULL) no schema — sem uma data única confirmada, o CREATE não pode acontecer sem inventar qual das candidatas é a real. Diferente dos planos de parcela externa (BLOCKED — nenhuma data nem aproximada existe), aqui a data real é esperada em poucos dias (19 ou 20/09) — por isso DEFER, não BLOCKED." : "Data única confirmada.",
      dependency: [seqPreflight],
      idempotencyCheck: "N/A",
      rollbackStrategy: "N/A",
      status: multiDate ? "DEFER" : "APPROVED_CANDIDATE",
    });
  }

  // --- Item 22: Tiger — Contingency.expectedDate é NULLABLE, então NÃO bloqueia ---
  for (const c of input.contingencies || []) {
    push({
      operation: "CREATE",
      model: "Contingency",
      existingRecordId: null,
      naturalKey: `description="${c.description}"`,
      before: "N/A",
      after: { description: c.description, expectedAmount: c.expectedAmount != null ? money(c.expectedAmount).toString() : null, maxAmount: money(c.maxAmount).toString(), status: c.status, expectedDate: null },
      amountEffectOnAccount: null,
      amountEffectOnLiability: null,
      source: "input do usuário",
      confidence: `expectedAmount=${c.expectedAmountConfidence}, maxAmount=${c.maxAmountConfidence}`,
      reason: "Contingency.expectedDate é nullable no schema — diferente de ConfirmedCommitment/ExternalInstallmentPlan, a ausência de data NÃO bloqueia o CREATE. Risco aguardando confirmação, não reduz freeMoney base (só contingencyExposure).",
      dependency: [seqPreflight],
      idempotencyCheck: `Contingency.findFirst({ where: { description: '${c.description}' } }) === null`,
      rollbackStrategy: "DELETE da Contingency criada (por id retornado no momento da criação)",
      status: "APPROVED_CANDIDATE",
    });
  }

  // --- Item 23: household Phone — DEFER, nunca inventar valor/data ---
  for (const b of input.householdBills || []) {
    if (b.dueDateKnown === false) {
      push({
        operation: "DEFER",
        model: "Bill / RecurringRule (conta doméstica)",
        existingRecordId: null,
        naturalKey: `name="${b.name}"`,
        before: "N/A",
        after: `BLOQUEADO: amount=${b.amount} é ${b.amountConfidence ?? "ESTIMATED"}, dueDate desconhecida — persistir com valor/data inventados violaria a instrução explícita do usuário.`,
        amountEffectOnAccount: null,
        amountEffectOnLiability: null,
        source: "input do usuário",
        confidence: b.confidence,
        reason: "Sem amount exato nem dueDate, uma Bill materializada aqui seria uma invenção — permanece estimado/não resolvido até o usuário confirmar ao menos um dos dois.",
        dependency: [seqPreflight],
        idempotencyCheck: "N/A",
        rollbackStrategy: "N/A",
        status: "DEFER",
      });
    }
  }

  // --- VA: expenses canônicas — reshape do expenseMatching pro formato
  // estrito. Política (genérica, não específica de nenhum item): a lista
  // CANÔNICA (evidência conversacional anterior do usuário) é a fonte de
  // verdade por padrão — MISSING_IN_DEV vira CREATE; um NEAR_AMOUNT com
  // candidato ÚNICO (a única forma de ambiguidade que buildCentLevelScenarios
  // cobre, por construção) vira UPDATE (persistido -> canônico), desde que
  // não exista evidência competindo a favor do valor persistido — os DOIS
  // cenários seguem visíveis em M2/centLevelScenarios como histórico, nunca
  // aplicados silenciosamente. MULTIPLE_*_CANDIDATES (não sabemos QUAL row)
  // continua BLOCKED — isso não é resolvido por política, exige evidência
  // adicional pra saber qual row específica corrigir.
  for (const m of vaExpenseMatching?.matches || []) {
    if (m.classification === "ALREADY_PERSISTED") continue; // sem mutação a listar
    const canonicalSource = (input.restrictedAccount?.canonicalExpenses || []).find((c) => c.date === m.date && c.counterparty === m.counterparty && compareMoney(money(c.amount), money(m.amount)) === 0);
    if (m.classification === "MISSING_IN_DEV") {
      push({
        operation: "CREATE",
        model: "Expense (conta restrita)",
        existingRecordId: null,
        naturalKey: `accountId=${vaAccount?.id ?? "?"}, date=${m.date}, counterparty="${m.counterparty}", amount=${m.amount}`,
        before: "N/A — ausente no dev dentro da janela pesquisada (desde a recarga)",
        after: { accountId: vaAccount?.id ?? "<va>", amount: m.amount, occurredAt: m.date, description: m.counterparty, category: "Alimentação (revisar taxonomia existente antes de escolher)" },
        amountEffectOnAccount: `VA: -${m.amount}`,
        amountEffectOnLiability: null,
        source: canonicalSource?.confidence ?? "N/A",
        confidence: canonicalSource?.confidence ?? "N/A",
        reason: "Presente na lista canônica (evidência conversacional anterior do usuário), ausente no dev — data e valor exatos já confirmados pelo próprio item canônico, nenhuma data inventada.",
        dependency: [seqPreflight],
        idempotencyCheck: `nenhuma Expense com accountId='${vaAccount?.id}', amount=${m.amount}, occurredAt no mesmo dia de '${m.date}' — dedup já feito por matchCanonicalExpenses contra TODA a janela desde a recarga.`,
        rollbackStrategy: "DELETE do Expense criado (por id retornado no momento da criação)",
        status: "APPROVED_CANDIDATE",
        _accountEffects: [{ accountId: vaAccount?.id, delta: subtractMoney(ZERO, money(m.amount)).toString() }],
      });
    } else if (m.classification === "AMBIGUOUS_MATCH" && m.matchType === "NEAR_AMOUNT") {
      const amb = centLevelScenarios?.ambiguities?.find((a) => a.item.date === m.date && a.item.counterparty === m.counterparty);
      push({
        operation: "UPDATE",
        model: "Expense (conta restrita)",
        existingRecordId: m.matchedDevExpenseId,
        naturalKey: `id=${m.matchedDevExpenseId}`,
        before: { amount: m.matchedDevAmount },
        after: { amount: m.amount },
        amountEffectOnAccount: `VA: correção de ${m.matchedDevAmount} -> ${m.amount} (delta de ${m.delta} revertido, sem novo movimento de caixa)`,
        amountEffectOnLiability: null,
        source: canonicalSource?.confidence ?? "N/A",
        confidence: canonicalSource?.confidence ?? "N/A",
        reason: amb
          ? `Único candidato remanescente no dev pra este valor dentro da janela pesquisada — nenhuma outra evidência aponta a favor do valor persistido (${amb.item.persistedDevAmount}). A lista canônica é a fonte de verdade por padrão (mesmo princípio já aplicado a MISSING_IN_DEV). Cenário A (canônico correto, ${amb.scenarioA_canonicalIsCorrect.derivedOpeningBalanceVA}) e Cenário B (persistido correto, ${amb.scenarioB_devIsCorrect.derivedOpeningBalanceVA}) seguem documentados em M2 — Cenário B preservado só como histórico, NÃO é mais candidato de apply.`
          : "Único candidato remanescente no dev pra este valor — lista canônica é a fonte de verdade por padrão.",
        dependency: [seqPreflight],
        idempotencyCheck: `Expense.findUnique({ where: { id: '${m.matchedDevExpenseId}' } }).amount === ${m.amount}`,
        rollbackStrategy: `UPDATE Expense.amount de volta para ${m.matchedDevAmount} (id=${m.matchedDevExpenseId})`,
        status: "APPROVED_CANDIDATE",
        _accountEffects: [{ accountId: vaAccount?.id, delta: subtractMoney(money(m.matchedDevAmount), money(m.amount)).toString() }],
      });
    } else if (m.classification === "AMBIGUOUS_MATCH") {
      push({
        operation: "NEEDS_EVIDENCE",
        model: "Expense (conta restrita)",
        existingRecordId: null,
        naturalKey: `date=${m.date}, counterparty="${m.counterparty}", amount=${m.amount}`,
        before: `múltiplos candidatos no dev: ${(m.candidateDevExpenseIds || []).join(", ")}`,
        after: "N/A — não sabemos QUAL row corrigir sem evidência adicional",
        amountEffectOnAccount: null,
        amountEffectOnLiability: null,
        source: canonicalSource?.confidence ?? "N/A",
        confidence: "UNCERTAIN",
        reason: `Match ${m.matchType} — múltiplos candidatos, diferente do caso de candidato único (que a política de 'canônico vence' já resolve). Escolher um dos ${(m.candidateDevExpenseIds || []).length} arbitrariamente seria inventar qual é o certo.`,
        dependency: [seqPreflight],
        idempotencyCheck: "N/A",
        rollbackStrategy: "N/A",
        status: "BLOCKED",
      });
    }
  }

  return entries;
}

// ============================================================================
// Fase 5.1A, item 26 — ordem segura de mutação, baseada em dependências REAIS
// (não a lista conceitual de exemplo do pedido). Pura, documental — não executa nada.
// ============================================================================
function buildMutationOrdering() {
  return {
    rule: "A ordem abaixo é derivada das dependências REAIS observadas no manifesto (buildFullApplyManifest), não de uma lista genérica fixa.",
    order: [
      "1. PREFLIGHT — todas as assertions de buildPreflightAssertions() devem passar antes de qualquer write.",
      "2. Card.closingDay — não depende de nada além do preflight; muda o comportamento de cálculo de closesAt/dueAt usado pelas próximas materializações (não recalcula rows já persistidas).",
      "3. CardBill UPDATE por id (Set/Out/Nov/Fev) — depende de (2) só pra coerência conceitual (mesma mudança de fechamento real do cartão); tecnicamente pode rodar em paralelo, mas rodar depois evita confusão se (2) falhar no meio.",
      "4. Reclassificação R$22 (Income.accountId VA->Itaú) — independente, só depende do preflight.",
      "5. CREATEs de movimentos já datados (férias Income, CNPJ Transfer, R$50 Expense) — independentes entre si, dependem só do preflight + seus próprios dedup checks.",
      "6. RecurringRule de salário (CREATE) — independente, depende só do preflight.",
      "7. LINK do Income de 24/08 à RecurringRule de (6) — depende explicitamente de (6) ter sido criada com sucesso (precisa do id gerado).",
      "8. Contingency (Tiger) — independente, depende só do preflight.",
      "9. Itens BLOCKED/DEFER (VA opening anchor, Itaú opening anchor, +0,03 delta, ExternalInstallmentPlans, Tattoo, Phone, pagamento da fatura de setembro) — NÃO executados nesta rodada; permanecem como pendências explícitas pro usuário resolver antes de uma futura Fase 5.1B-2.",
    ],
    rationale: "A maioria das mutações desta fase é independente entre si (contas/modelos diferentes, sem FK compartilhada) — a única dependência FORTE real é (7) precisar do id gerado por (6). Isso permite rodar (2)-(6)+(8) em qualquer ordem entre si, com (7) estritamente depois de (6).",
  };
}

// ============================================================================
// Fase 5.1A, item 27 — estratégia de atomicidade. Documental, não executa nada.
// ============================================================================
function buildAtomicityStrategy() {
  return {
    recommendation: "Transação única do Prisma (o agrupador atômico de múltiplas queries, ver docs de Prisma sobre transações interativas) envolvendo TODOS os itens com status=APPROVED_CANDIDATE, com um preflight fora da transação (as assertions de leitura não precisam de lock) e um fingerprint antes/depois também fora da transação.",
    reasoning:
      "O conjunto de mutações aprovadas desta fase é pequeno (dezenas de rows, não milhares) e cabe confortavelmente numa única transação. Isso garante a invariante mais importante pedida pelo usuário: nunca deixar o banco pela metade se qualquer item falhar (ex: o LINK do Income à RecurringRule falhar depois da RecurringRule já ter sido criada) — com transação única, uma falha em qualquer passo desfaz TODOS os passos daquela rodada, sem precisar de lógica de compensação manual.",
    alternativeConsidered: "Script idempotente com checkpoints (aplicar item a item, registrar progresso, permitir retomar de onde parou) — mais apropriado se o volume fosse muito maior (centenas/milhares de rows) ou se cada passo fosse lento/custoso. Não é o caso aqui — a transação única é mais simples E mais segura pro volume atual.",
    itemsExcludedFromTransaction: "BLOCKED/DEFER/DELETE_ARTIFACT_CANDIDATE nunca entram na transação de apply — são explicitamente excluídos do apply-set (ver preflight assertion correspondente).",
  };
}

// ============================================================================
// Fase 5.1A, item 28 — preflight assertions que o FUTURO script de apply
// (Fase 5.1B) deve checar antes do primeiro write. Documental — lista as
// checagens, não as executa (a execução real é responsabilidade do script
// de apply, que ainda não existe).
// ============================================================================
function buildPreflightAssertions() {
  return [
    { assertion: "DATABASE_ENV !== 'development' -> ABORT", reason: "Nunca rodar apply fora do branch dev — mesma guarda de assertTestEnvironment() já usada por todo script de escrita do projeto." },
    { assertion: "host da connection string não é o branch dev esperado -> ABORT", reason: "Proteção contra apontar acidentalmente pro branch main/produção do Neon." },
    { assertion: "contagem/fingerprint das rows-alvo (CardBill por id, Income por id, etc.) mudou desde a geração deste manifesto -> ABORT", reason: "O manifesto foi gerado num instante específico; se o banco mudou entre a geração e a execução (ex: usuário lançou algo pelo bot nesse meio-tempo), os before/after registrados podem estar desatualizados." },
    { assertion: "CardBill.findUnique({cardId,cycleMonth}) já existe pra qualquer ciclo com operation=UPDATE proposto -> se NÃO existir, ABORT (nunca criar uma nova CardBill via um item classificado como UPDATE)", reason: "Constraint @@unique([cardId,cycleMonth]) — um UPDATE que na verdade precisaria de CREATE indica um manifesto desatualizado." },
    { assertion: "saldo observado atual (Itaú/VA) ou limite do cartão diverge do valor usado como `before` neste manifesto -> ABORT", reason: "As âncoras observadas podem ter mudado (novo extrato, novo lançamento) — aplicar mutações calculadas sobre um `before` que não é mais verdade produziria resultado incorreto." },
    { assertion: "qualquer naturalKey do apply-set colidiria com uma row já existente não prevista (ex: RecurringRule kind=income accountId=itau já existe quando o manifesto assumia que não existia) -> ABORT", reason: "Proteção contra duplicata silenciosa." },
    { assertion: "versão do schema.prisma (hash do arquivo, ou `npx prisma migrate status`) diverge da versão em que este manifesto foi gerado -> ABORT", reason: "Um schema mudado pode invalidar suposições de nullability/constraint usadas para classificar BLOCKED vs APPROVED_CANDIDATE." },
    { assertion: "qualquer item com status=BLOCKED, DEFER ou DELETE_ARTIFACT_CANDIDATE está presente no apply-set em execução -> ABORT", reason: "O apply-set desta fase é estritamente os itens status=APPROVED_CANDIDATE — nenhum BLOCKED/DEFER/DELETE_ARTIFACT_CANDIDATE deve ser executado sem uma nova aprovação explícita." },
  ];
}

// ============================================================================
// Fase 5.1A, item 30 — simulação do estado pós-apply, SEM ESCREVER NADA. Só
// aplica em memória os efeitos dos itens status=APPROVED_CANDIDATE (excluindo
// BLOCKED/DEFER/DELETE_ARTIFACT_CANDIDATE) sobre os valores JÁ CONHECIDOS
// (input do usuário), mostrando onde bloqueadores de centavo impedem
// fechamento exato.
// ============================================================================
function simulatePostApplyState(fullManifest, { input, cardRecon, itauOperationalLedger, centLevelScenarios }) {
  const approved = fullManifest.filter((m) => m.status === "APPROVED_CANDIDATE");
  const blocked = fullManifest.filter((m) => m.status !== "APPROVED_CANDIDATE");

  const cardUsedAfter = sumMoney((input.card?.bills || []).filter((b) => b.status !== "PAID").map((b) => money(b.amount)));
  const cardNextLiability = (input.card?.bills || []).filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth))[0] ?? null;
  const futureCardObligations = (input.card?.bills || []).filter((b) => b.status !== "PAID").slice(1);

  const externalInstallmentNextPackage = sumMoney((input.externalInstallmentPlans || []).map((p) => money(p.installmentValue)));

  const scenarioA = centLevelScenarios?.ambiguities?.[0]?.scenarioA_canonicalIsCorrect?.derivedOpeningBalanceVA ?? null;
  const scenarioB = centLevelScenarios?.ambiguities?.[0]?.scenarioB_devIsCorrect?.derivedOpeningBalanceVA ?? null;
  const scenarioDelta = scenarioA != null && scenarioB != null ? subtractMoney(money(scenarioA), money(scenarioB)).abs().toString() : null;
  const deferredMovementsDescriptions = (input.checkingAccount?.movementsAfterCheckpointA || []).map((m) => `${m.description} (${m.amount})`);

  return {
    itemsApplied: approved.length,
    itemsExcluded: blocked.length,
    itauComputedBalance: {
      value: "INDETERMINATE_UNTIL_OPENING_ANCHOR_RESOLVED",
      reason: `Depende do opening balance operacional (item BLOCKED/DEFER — ${itauOperationalLedger?.derivedOpeningBalanceItau ?? "?"} DERIVED_ONLY) mais os movimentos aprovados (${deferredMovementsDescriptions.join(", ") || "nenhum"}) e quaisquer pagamentos de fatura ainda em DEFER — sem o opening aprovado, não há um saldo computado final único.`,
      knownComponents: {
        derivedOperationalOpening: itauOperationalLedger?.derivedOpeningBalanceItau ?? null,
        checkpointA: itauOperationalLedger?.checkpointA ?? null,
        approvedMovementsAfterCheckpointA: (input.checkingAccount?.movementsAfterCheckpointA || []).map((m) => ({ description: m.description, amount: m.amount, type: m.type })),
      },
    },
    vaComputedBalance: {
      value: "INDETERMINATE_UNTIL_CENT_LEVEL_AMBIGUITY_RESOLVED",
      scenarioA,
      scenarioB,
      expectedDelta: scenarioDelta != null ? `${scenarioDelta} (exatamente a ambiguidade centavo-a-centavo identificada em M2 — nenhum outro fator diverge entre os dois cenários)` : "N/A — sem ambiguidade near-amount pendente",
    },
    cardUsed: cardUsedAfter.toString(),
    cardNextLiability: cardNextLiability ? { cycleMonth: cardNextLiability.cycleMonth, amount: money(cardNextLiability.amount).toString() } : null,
    futureCardObligations: { total: sumMoney(futureCardObligations.map((b) => money(b.amount))).toString(), items: futureCardObligations.map((b) => ({ cycleMonth: b.cycleMonth, amount: money(b.amount).toString() })) },
    externalInstallmentState: {
      status: fullManifest.some((m) => m.model.includes("ExternalInstallmentPlan") && m.status === "BLOCKED")
        ? "BLOCKED — nenhum plano pode ser criado nesta rodada (firstDueDate NOT NULL sem data confirmada)"
        : fullManifest.some((m) => m.model.includes("ExternalInstallmentPlan"))
          ? "parcialmente aprovado — ver manifesto completo pra detalhes por plano"
          : "N/A — nenhum plano de parcela externa neste input",
      nextPackageIfUnblocked: externalInstallmentNextPackage.toString(),
    },
    freeMoneyNote: "Recalcular freeMoney/safeToSpend/financialStatus reais requer os saldos de conta computados acima — como ambos (Itaú e VA) permanecem INDETERMINATE até os bloqueadores serem resolvidos pelo usuário, engineDryRun (seção W) já documenta a versão COM as estimativas atuais; este bloco não duplica esse cálculo, só isola o que MUDARIA se e somente se os itens BLOCKED/DEFER fossem resolvidos.",
    remainingBlockers: blocked.map((m) => ({ naturalKey: m.naturalKey, status: m.status, model: m.model })),
  };
}

// ============================================================================
// Correção pedida pelo usuário nesta rodada — a simulação anterior
// (simulatePostApplyState) partia do CANONICAL SNAPSHOT, não do estado
// PERSISTIDO real. Esta função monta uma cópia EM MEMÓRIA do estado
// persistido ATUAL (lido do banco, read-only) + aplica só os deltas dos
// itens APPROVED_CANDIDATE (via _accountEffects, nunca por string-parsing) +
// roda as MESMAS funções reais de classificação (resolveCurrentRelevantCardBillCycleMonth,
// classifyCardBill — importadas de lib/freeMoney.js e lib/obligationClassifier.js,
// não reimplementadas aqui) — nunca escreve no banco.
// ============================================================================
async function simulateApprovedOnlyPersistedState(fullManifest, { input, cardRow, itauAccount, vaAccount, now = new Date() }) {
  const approved = fullManifest.filter((m) => m.status === "APPROVED_CANDIDATE");

  const accountDelta = new Map();
  for (const m of approved) {
    for (const eff of m._accountEffects || []) {
      if (!eff.accountId) continue;
      accountDelta.set(eff.accountId, addMoney(accountDelta.get(eff.accountId) ?? ZERO, money(eff.delta)));
    }
  }

  let itau = null;
  let va = null;
  if (itauAccount) {
    const currentReal = await computeAccountBalance(itauAccount.id);
    const delta = accountDelta.get(itauAccount.id) ?? ZERO;
    itau = { currentReal: currentReal.toString(), delta: delta.toString(), simulatedAfterApprovedOnly: addMoney(currentReal, delta).toString() };
  }
  if (vaAccount) {
    const currentReal = await computeAccountBalance(vaAccount.id);
    const delta = accountDelta.get(vaAccount.id) ?? ZERO;
    va = { currentReal: currentReal.toString(), delta: delta.toString(), simulatedAfterApprovedOnly: addMoney(currentReal, delta).toString() };
  }

  let cardSimulation = null;
  if (cardRow) {
    const realBills = await listCardBillsView(cardRow.id, { now });
    const cardBillUpdates = new Map(
      approved.filter((m) => m.model === "CardBill" && m.operation === "UPDATE").map((m) => [m.existingRecordId, m.after])
    );
    const simulatedBills = realBills.map((b) => {
      const upd = cardBillUpdates.get(b.id);
      return upd ? { ...b, totalAmount: money(upd.totalAmount), paidAmount: money(upd.paidAmount) } : b;
    });
    const currentRelevantBefore = resolveCurrentRelevantCardBillCycleMonth(realBills);
    const currentRelevantAfterApprovedOnly = resolveCurrentRelevantCardBillCycleMonth(simulatedBills);

    let incurred = null;
    const future = [];
    for (const b of simulatedBills) {
      const remaining = subtractMoney(money(b.totalAmount), money(b.paidAmount ?? 0));
      if (remaining.lte(0)) continue;
      const cls = classifyCardBill(b, { isCurrentRelevant: b.cycleMonth === currentRelevantAfterApprovedOnly });
      if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) incurred = { cycleMonth: b.cycleMonth, amount: remaining.toString() };
      else if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) future.push({ cycleMonth: b.cycleMonth, amount: remaining.toString() });
    }

    const canonicalUnpaidSorted = (input.card?.bills || []).filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
    const canonicalIncurred = canonicalUnpaidSorted[0] ?? null;
    const canonicalFuture = canonicalUnpaidSorted.slice(1);

    const contaminationConfirmed = canonicalIncurred != null && incurred?.cycleMonth !== canonicalIncurred.cycleMonth;

    cardSimulation = {
      currentRelevantCycleMonth_beforeAnyApply: currentRelevantBefore,
      currentRelevantCycleMonth_afterApprovedOnlyApply: currentRelevantAfterApprovedOnly,
      incurredLiability_simulated: incurred,
      futureObligations_simulated: { total: sumMoney(future.map((f) => money(f.amount))).toString(), items: future },
      incurredLiability_canonicalTarget: canonicalIncurred ? { cycleMonth: canonicalIncurred.cycleMonth, amount: money(canonicalIncurred.amount).toString() } : null,
      futureObligations_canonicalTarget: { total: sumMoney(canonicalFuture.map((b) => money(b.amount))).toString(), items: canonicalFuture.map((b) => ({ cycleMonth: b.cycleMonth, amount: money(b.amount).toString() })) },
      divergesFromCanonicalTarget: contaminationConfirmed,
      divergenceCausedBy: contaminationConfirmed
        ? [{ cycleMonth: incurred?.cycleMonth, reason: "Esta CardBill continua sem correção aprovada (status BLOCKED/DEFER) e seu closesAt é anterior ao da bill canônica esperada, então resolveCurrentRelevantCardBillCycleMonth (execução real) a elege como INCURRED_LIABILITY em vez da bill correta." }]
        : [],
    };
  }

  return {
    method: "Lê o saldo REAL atual via computeAccountBalance (real) + soma os deltas dos itens APPROVED_CANDIDATE (via _accountEffects estruturado, nunca parsing de texto) + roda listCardBillsView/resolveCurrentRelevantCardBillCycleMonth/classifyCardBill REAIS sobre uma cópia em memória — nunca escreve no banco.",
    itau,
    va,
    card: cardSimulation,
  };
}

// ============================================================================
// Y — Missing evidence / blockers agregados de todas as seções.
//
// Também 100% derivado do input — nenhuma referência a um fato específico do
// usuário pode ser hardcoded aqui.
// ============================================================================
function collectBlockers({ input, checkingRecon, vaRecon, engineResult, cardRecon, schemaAudit }) {
  const blockers = [];
  if (checkingRecon?.derivedOpeningBalance?.status === "MISSING_EVIDENCE") {
    blockers.push({ area: "Opening balance da conta irrestrita", description: checkingRecon.derivedOpeningBalance.note });
  }
  if (checkingRecon?.unexplainedDifference && checkingRecon.unexplainedDifference !== "0") {
    blockers.push({ area: "Delta não explicado na conta irrestrita", description: `unexplainedDifference=${checkingRecon.unexplainedDifference} — ver seção G.` });
  }
  if (vaRecon?.residualOpeningFromKnownLedger && vaRecon.residualOpeningFromKnownLedger !== "0") {
    blockers.push({
      area: "Residual não explicado na conta restrita",
      description: `residualOpeningFromKnownLedger=${vaRecon.residualOpeningFromKnownLedger} — ledger conhecido incompleto, não evidência de saldo negativo. Ver reviewCandidates.`,
    });
  }
  for (const rc of vaRecon?.reviewCandidates || []) {
    blockers.push({ area: `Conta restrita — ${rc.kind}`, description: rc.description, implication: rc.implication });
  }
  if (vaRecon?.externalSourceInvestigation?.classification === "MISSING_EXTERNAL_SOURCE_FILE") {
    blockers.push({ area: "Fonte externa (CSV/extrato do vale-refeição)", description: vaRecon.externalSourceInvestigation.note });
  }
  if (cardRecon?.usedLimitChecksum && !cardRecon.usedLimitChecksum.matches) {
    blockers.push({ area: "Cartão — checksum de limite usado", description: "Soma das faturas conhecidas não bate com o limite usado observado." });
  }
  for (const cb of cardRecon?.persistedCardBillsClassified || []) {
    if (cb.wouldContaminateEngineIfLeftAsIs) {
      blockers.push({
        area: `CardBill contaminando o engine: cycleMonth=${cb.cycleMonth}`,
        description: `id=${cb.id}, classification=${cb.classification} — remaining=${cb.remainingAmount} > 0, então esta row É USADA HOJE por incurredLiabilities/futureObligations com o valor ERRADO (${cb.totalAmount} em vez de ${cb.knownRealAmount ?? "valor real desconhecido"}).`,
      });
    }
  }
  for (const m of engineResult.missingEvidence) blockers.push({ area: `Engine: ${m.field}`, description: m.impact, evidenceNeeded: m.evidenceNeeded });
  for (const m of input.checkingAccount?.movementsAfterCheckpointA || []) {
    if (m.economicClassification === "UNKNOWN") {
      blockers.push({ area: `Classificação econômica pendente: ${m.description}`, description: "Precisa de decisão antes de persistir como Expense/Transfer/Receivable." });
    }
  }
  for (const e of input.otherEvidence || []) {
    blockers.push({ area: e.description, description: e.note || "Evidência incompleta." });
  }
  for (const c of input.confirmedCommitments || []) {
    if ((c.dateCandidates || []).length > 1) {
      blockers.push({ area: `Data exata pendente: ${c.description}`, description: `Candidatas: ${c.dateCandidates.join(" ou ")} — não afeta necessariamente a classificação de horizonte (ver seção W), mas precisa ser resolvida antes de persistir dueDate.` });
    }
  }
  if (schemaAudit?.conclusion?.startsWith("GAP_DE_MODELAGEM: NENHUM") === false) {
    blockers.push({ area: "Escopo de conta externa (schema)", description: schemaAudit?.conclusion ?? "Ver seção R." });
  }
  // Fase 5.0.3, item 23 — existência/posição atual de parcela externa NÃO é
  // mais blocker (evidência conversacional já confirma o estado atual); só a
  // incoerência temporal (se houver) continua sendo um blocker real.
  for (const c of engineResult.externalInstallments?.csvCoherenceCheck || []) {
    if (c.csvMatch === "FOUND" && c.coherentTemporalAdvance === false) {
      blockers.push({ area: `Parcela externa — incoerência temporal: ${c.description}`, description: `Posição atual confirmada (${c.currentConfirmedPosition}) é MENOR que a observada no CSV (${c.csvObservedPosition}, ${c.csvObservedDate}) — investigar.` });
    }
  }
  for (const b of engineResult.householdBills?.pendingEstimated || []) {
    blockers.push({ area: `Bill doméstica pendente/estimada: ${b.name}`, description: `amount=${b.amount}${b.amountConfidence ? ` (${b.amountConfidence})` : ""}, dueDateKnown=${b.dueDateKnown ?? "N/A"} — impede freeMoneyCompleteness=COMPLETE até resolver se pertence ao horizonte atual.` });
  }
  return blockers;
}

// ============================================================================
// main
// ============================================================================
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = loadSnapshotInput(args.input);

  const settings = await getAppSettings();
  const inventory = await buildInventory();

  const checkingRecon = reconcileCheckingLedger(input.checkingAccount, { operationalHistoryStart: settings.operationalHistoryStart });
  const vaRecon = await reconcileRestrictedLedger(input.restrictedAccount, { reclassifiedIncomes: input.reclassifiedIncomes || [] });
  const schemaAudit = auditTransferSchemaForExternalScope();

  const nextIncomeFromDbRaw = await resolveNextExpectedIncomeFromDb({ now: d(input.asOf) });
  const nextIncomeFromDb = { ...nextIncomeFromDbRaw, expectedDate: nextIncomeFromDbRaw.expectedDate?.toISOString() ?? null };

  let nextIncomeProposed = { expectedDate: null, status: "MISSING_EVIDENCE", isFallback: null };
  if (input.mainIncome) {
    const syntheticRule = { id: "proposed-salario", kind: "income", isActive: true, dayOfMonth: input.mainIncome.dayOfMonth, accountId: null, amount: money(input.mainIncome.amount) };
    nextIncomeProposed = resolveNextExpectedIncome({ now: d(input.asOf), recurringRules: [syntheticRule], realizedIncomes: [], accounts: [], settings });
  }

  const csvAudit = auditLegacyCsv(input, {
    asOf: d(input.asOf),
    nextIncomeDate: nextIncomeProposed.expectedDate,
    operationalHistoryStart: settings.operationalHistoryStart,
    vaHistoryStart: settings.vaHistoryStart,
  });

  const cardRecon = await reconcileCard(input.card, csvAudit);

  // Fase 5.1A, itens 2-3 e 6-9 — cenários de ambiguidade centavo-a-centavo (VA)
  // e reconstrução do ledger operacional do Itaú (24/08 -> checkpointA 04/09).
  const centLevelScenarios = input.restrictedAccount
    ? buildCentLevelScenarios(input.restrictedAccount.canonicalExpenses || [], vaRecon?.canonicalLedger?.expenseMatching, {
        recharge: input.restrictedAccount.recharge?.amount,
        observedClosing: input.restrictedAccount.observedClosing?.amount,
      })
    : { status: "MISSING_EVIDENCE" };
  const itauOperationalLedger = input.checkingAccount?.operationalHistoryEvidence
    ? reconcileItauOperationalLedger(input.checkingAccount.operationalHistoryEvidence, {
        checkpointA: input.checkingAccount.checkpointA?.amount,
        operationalHistoryStart: settings.operationalHistoryStart,
      })
    : { status: "NOT_PROVIDED" };
  const externalInstallmentSettlementSemantics = auditExternalInstallmentSettlementSemantics();

  const engineResult = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb, appSettings: settings, asOf: d(input.asOf), csvAudit });
  const confidenceMatrix = buildConfidenceMatrix(input);
  const proposedCanonicalSnapshot = buildProposedCanonicalSnapshot(input, cardRecon);
  const proposedMutations = buildProposedMutations(input, inventory, checkingRecon, vaRecon, cardRecon);
  const potentialLastResortMutations = buildPotentialLastResortMutations(checkingRecon, vaRecon);
  const blockers = collectBlockers({ input, checkingRecon, vaRecon, engineResult, cardRecon, schemaAudit });

  const fullApplyManifest = await buildFullApplyManifest(input, { cardRecon, itauOperationalLedger, centLevelScenarios, vaExpenseMatching: vaRecon?.canonicalLedger?.expenseMatching });
  const mutationOrdering = buildMutationOrdering();
  const atomicityStrategy = buildAtomicityStrategy();
  const preflightAssertions = buildPreflightAssertions();
  const postApplySimulation = simulatePostApplyState(fullApplyManifest, { input, cardRecon, itauOperationalLedger, centLevelScenarios });
  const itauAccountForSimulation = input.checkingAccount?.slug ? await prisma.account.findUnique({ where: { slug: input.checkingAccount.slug } }) : null;
  const vaAccountForSimulation = input.restrictedAccount?.slug ? await prisma.account.findUnique({ where: { slug: input.restrictedAccount.slug } }) : null;
  const cardRowForSimulation = input.card?.slug ? await prisma.card.findUnique({ where: { slug: input.card.slug } }) : null;
  const approvedOnlyPersistedSimulation = await simulateApprovedOnlyPersistedState(fullApplyManifest, {
    input,
    cardRow: cardRowForSimulation,
    itauAccount: itauAccountForSimulation,
    vaAccount: vaAccountForSimulation,
  });

  const report = {
    meta: { generatedAt: new Date().toISOString(), asOf: input.asOf, tool: "scripts/snapshot-dry-run.mjs", writesToDb: false },
    A_anchorsObserved: {
      checkingAccountCheckpointA: input.checkingAccount?.checkpointA ?? null,
      checkingAccountCheckpointB: input.checkingAccount?.checkpointB ?? null,
      restrictedAccountRecharge: input.restrictedAccount?.recharge ?? null,
      restrictedAccountObservedClosing: input.restrictedAccount?.observedClosing ?? null,
      mainIncome: input.mainIncome ?? null,
      card: input.card ?? null,
    },
    B_currentDevState: inventory,
    C_checkingLedgerCandidate: checkingRecon,
    D_checkpointA: checkingRecon.checkpointA,
    E_movements: checkingRecon.movements,
    F_checkpointB: checkingRecon.checkpointB,
    G_deltaInvestigation: { unexplainedDifference: checkingRecon.unexplainedDifference, investigation: checkingRecon.unexplainedDifferenceInvestigation },
    H_checkingReconciliationComplete: checkingRecon.finalChecksum,
    I_derivedOpeningBalanceCheckingAccount: checkingRecon.derivedOpeningBalance,
    J_evidencedOpeningBalanceCheckingAccount: checkingRecon.derivedOpeningBalance.openingBalanceEvidence === "EVIDENCED" ? checkingRecon.derivedOpeningBalance : { status: "NONE", reason: "Sem evidência independente (extrato completo do período) fornecida a este dry-run." },
    // Item 1 — K/L/M corrigidos: derivedOpeningBalance NUNCA é a recarga.
    // Item 1A/1B — rawPersistedLedger é o cenário PRINCIPAL,
    // hypotheticalReclassifiedLedger só é adotado se a investigação do R$
    // não-recarga confirmar má-classificação com evidência suficiente.
    K_restrictedAccountLedgerCandidate: vaRecon,
    L_restrictedAccountReconciliation: {
      canonicalLedger: vaRecon.canonicalLedger,
      reclassifiedIncomes: vaRecon.reclassifiedIncomes,
      rawPersistedLedger: vaRecon.rawPersistedLedger,
      hypotheticalReclassifiedLedger: vaRecon.hypotheticalReclassifiedLedger,
      nonRechargeIncomeInvestigation: vaRecon.nonRechargeIncomeInvestigation,
      knownNetMovements: vaRecon.knownNetMovements,
      residualOpeningFromKnownLedger: vaRecon.residualOpeningFromKnownLedger,
      derivedOpeningBalance: vaRecon.derivedOpeningBalance,
      unexplainedOutflowsOrMissingEvidence: vaRecon.unexplainedOutflowsOrMissingEvidence,
      openingBalanceEvidence: vaRecon.openingBalanceEvidence,
      investigation: vaRecon.investigationNote,
      reviewCandidates: vaRecon.reviewCandidates,
      externalSourceInvestigation: vaRecon.externalSourceInvestigation,
    },
    M_derivedOpeningBalanceRestrictedAccount: { value: "INDETERMINATE", basis: "recharge NÃO é opening balance — ver seção L", openingBalanceEvidence: "MISSING" },
    M2_centLevelScenarios_VA_OPENING_ANCHOR: centLevelScenarios,
    N_cardReconciliation: cardRecon,
    N2_itauOperationalLedgerReconstruction: itauOperationalLedger,
    O_persistedVsCanonicalCardBills: {
      persistedInDb: cardRecon.persistedCardBillsInDb,
      classified: cardRecon.persistedCardBillsClassified,
      cardBillUniqueConstraint: cardRecon.cardBillUniqueConstraint,
      observedVsUnderlyingPurchasesExplained: cardRecon.observedVsUnderlyingPurchasesExplained,
      manifestById: cardRecon.cardBillManifestById,
    },
    P_externalInstallments:
      (csvAudit.externalInstallmentCandidates || []).length > 0
        ? { source: "csv_staging_evidence", candidates: csvAudit.externalInstallmentCandidates, materialActiveCandidates: csvAudit.materialActiveExternalInstallmentCandidates }
        : (input.externalInstallmentPlans || []).length > 0
          ? input.externalInstallmentPlans
          : { status: "MISSING_EVIDENCE", note: "Nenhum plano com evidência suficiente informado neste snapshot." },
    P3_externalInstallmentSettlementSemantics: externalInstallmentSettlementSemantics,
    Z_legacyCsvStagingAudit: csvAudit,
    P2_purchaseAudit: cardRecon.purchaseAudit,
    Q_recurringIncomeProposal: {
      currentDbState: nextIncomeFromDb,
      proposedScheduleOnly: input.mainIncome
        ? { kind: "income", dayOfMonth: input.mainIncome.dayOfMonth, scheduleConfidence: engineResult.nextIncome.proposedIfScheduleRuleExisted.scheduleConfidence, occurrenceToLink: input.mainIncome.date, occurrenceAmount: money(input.mainIncome.amount).toString(), occurrenceAmountConfidence: input.mainIncome.confidence }
        : { status: "MISSING_EVIDENCE" },
      standardRecurringAmount: engineResult.nextIncome.proposedIfScheduleRuleExisted.standardRecurringAmount,
      standardRecurringAmountConfidence: engineResult.nextIncome.proposedIfScheduleRuleExisted.standardRecurringAmountConfidence,
      variablePayExpected: engineResult.nextIncome.proposedIfScheduleRuleExisted.variablePayExpected,
      nextOccurrenceActualAmount: "UNKNOWN",
      note: "Schedule (dayOfMonth), o valor de UMA ocorrência histórica (occurrenceAmount) e o valor PADRÃO/BASE confirmado (standardRecurringAmount) são evidências SEPARADAS do valor REAL da próxima ocorrência (nextOccurrenceActualAmount), que permanece desconhecido até acontecer — especialmente quando variablePayExpected=true (ex: horas extras).",
      nextIncomeIfProposedRuleExisted: { expectedDate: nextIncomeProposed.expectedDate?.toISOString?.() ?? nextIncomeProposed.expectedDate, status: nextIncomeProposed.status },
    },
    R_externalTransfers: { facts: input.externalTransfers || [], schemaAudit },
    S_confirmedCommitments: input.confirmedCommitments || [],
    T_contingencies: input.contingencies || [],
    U_confidenceSourceMatrix: confidenceMatrix,
    V_proposedCanonicalSnapshot: proposedCanonicalSnapshot,
    W_financialEngineDryRun: engineResult,
    X_proposedMutationsForFase51: proposedMutations,
    X2_potentialLastResortMutations_NOT_APPROVED: potentialLastResortMutations,
    Y_missingEvidenceBlockers: blockers,
    Z2_fullApplyManifest_Fase51A: fullApplyManifest,
    Z3_mutationOrdering: mutationOrdering,
    Z4_atomicityStrategy: atomicityStrategy,
    Z5_preflightAssertionsForFase51B: preflightAssertions,
    Z6_postApplySimulation_APPROVED_CANDIDATE_ONLY: postApplySimulation,
    Z7_approvedOnlyPersistedStateSimulation_REAL_EXECUTION: approvedOnlyPersistedSimulation,
  };

  console.log(JSON.stringify(report, null, 2));

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.error(`\n[snapshot-dry-run] Relatório salvo em: ${args.out} (confirme que este caminho está gitignored antes de considerar isso "seguro")`);
  }

  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((err) => {
      console.error("💥 Erro no dry-run:", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

export {
  main,
  buildInventory,
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
  buildCentLevelScenarios,
  reconcileItauOperationalLedger,
  auditExternalInstallmentSettlementSemantics,
  buildCardBillManifestById,
  buildFullApplyManifest,
  buildMutationOrdering,
  buildAtomicityStrategy,
  buildPreflightAssertions,
  simulatePostApplyState,
  simulateApprovedOnlyPersistedState,
};
