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
import { classifyCardBill, classifyConfirmedCommitment, classifyContingency, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend, isWithinNextIncomeCommitmentWindow } from "../lib/freeMoney.js";
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
    purchaseAudit,
    currentCardCreditBalanceAssumption: "R$0,00 — nenhuma evidência de saldo credor atual informada neste snapshot.",
  };
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

  const engineResult = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb, appSettings: settings, asOf: d(input.asOf), csvAudit });
  const confidenceMatrix = buildConfidenceMatrix(input);
  const proposedCanonicalSnapshot = buildProposedCanonicalSnapshot(input, cardRecon);
  const proposedMutations = buildProposedMutations(input, inventory, checkingRecon, vaRecon, cardRecon);
  const potentialLastResortMutations = buildPotentialLastResortMutations(checkingRecon, vaRecon);
  const blockers = collectBlockers({ input, checkingRecon, vaRecon, engineResult, cardRecon, schemaAudit });

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
    N_cardReconciliation: cardRecon,
    O_persistedVsCanonicalCardBills: {
      persistedInDb: cardRecon.persistedCardBillsInDb,
      classified: cardRecon.persistedCardBillsClassified,
      cardBillUniqueConstraint: cardRecon.cardBillUniqueConstraint,
      observedVsUnderlyingPurchasesExplained: cardRecon.observedVsUnderlyingPurchasesExplained,
    },
    P_externalInstallments:
      (csvAudit.externalInstallmentCandidates || []).length > 0
        ? { source: "csv_staging_evidence", candidates: csvAudit.externalInstallmentCandidates, materialActiveCandidates: csvAudit.materialActiveExternalInstallmentCandidates }
        : (input.externalInstallmentPlans || []).length > 0
          ? input.externalInstallmentPlans
          : { status: "MISSING_EVIDENCE", note: "Nenhum plano com evidência suficiente informado neste snapshot." },
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
};
