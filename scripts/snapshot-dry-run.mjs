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
import { money, addMoney, subtractMoney, sumMoney, compareMoney, isPositive, ZERO } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { listCardBillsView } from "../lib/cardBillCalculator.js";
import { classifyCardBill, classifyConfirmedCommitment, classifyContingency, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend, isWithinNextIncomeCommitmentWindow } from "../lib/freeMoney.js";
import { resolveNextExpectedIncome, resolveNextExpectedIncomeFromDb } from "../lib/incomeHorizon.js";
import { getAppSettings } from "../lib/settings.js";
import { isValidConfidence } from "../lib/dataConfidence.js";

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
// K/L/M — ledger da conta restrita: recharge -> observedClosing, mesma disciplina.
// ============================================================================
async function reconcileRestrictedLedger(section) {
  if (!section) return { status: "MISSING_EVIDENCE", reason: "restrictedAccount não informado no input" };

  const recharge = money(section.recharge.amount);
  const observedClosing = money(section.observedClosing.amount);

  // Consumo real conhecido no banco (Expense na conta VA, se a conta existir e
  // tiver slug correspondente) — read-only, só pra tentar explicar a diferença
  // (item 13), nunca pra ajustar automaticamente.
  let knownConsumption = null;
  let account = null;
  if (section.slug) {
    account = await prisma.account.findUnique({ where: { slug: section.slug } });
    if (account) {
      const rechargeDate = d(section.recharge.date);
      const expenses = await prisma.expense.findMany({
        where: { accountId: account.id, occurredAt: { gte: rechargeDate } },
        orderBy: { occurredAt: "asc" },
      });
      knownConsumption = {
        count: expenses.length,
        total: sumMoney(expenses.map((e) => e.amount)).toString(),
        items: expenses.map((e) => ({ id: e.id, description: e.description, amount: e.amount.toString(), occurredAt: e.occurredAt.toISOString() })),
      };
    }
  }

  const knownConsumptionTotal = knownConsumption ? money(knownConsumption.total) : null;
  const mathematicalExpected = knownConsumptionTotal != null ? subtractMoney(recharge, knownConsumptionTotal) : null;
  const unexplainedDifferenceVA = mathematicalExpected != null ? subtractMoney(observedClosing, mathematicalExpected) : null;

  return {
    account: account ? { id: account.id, slug: account.slug } : { status: "NOT_FOUND_IN_DB", slugSearched: section.slug ?? null },
    recharge: { amount: recharge.toString(), date: section.recharge.date, confidence: section.recharge.confidence },
    observedClosing: { amount: observedClosing.toString(), date: section.observedClosing.date, confidence: section.observedClosing.confidence },
    knownConsumptionFoundInDb: knownConsumption,
    mathematicalExpected: mathematicalExpected?.toString() ?? null,
    unexplainedDifferenceVA: unexplainedDifferenceVA?.toString() ?? null,
    derivedOpeningBalanceVA: {
      value: recharge.toString(),
      basis: "recharge (única âncora informada no cutoff vaHistoryStart)",
      openingBalanceEvidence: section.recharge.confidence === "CONFIRMED" ? "EVIDENCED" : "DERIVED_ONLY",
    },
    investigationNote:
      unexplainedDifferenceVA != null && !unexplainedDifferenceVA.isZero()
        ? "Diferença não fechada só pelas Expense encontradas na conta VA no banco dev — candidatos a investigar: " +
          "gasto lançado na conta errada (irrestrita em vez de restrita), CSV legado não importado, data fora do cutoff, arredondamento, lançamento omitido. " +
          "NÃO convertida em ajuste automaticamente."
        : "N/A — sem base de comparação suficiente (nenhuma Expense encontrada na conta) ou diferença zero.",
  };
}

// ============================================================================
// N/O — Card reconciliation + persisted vs projected CardBills (itens 17-19)
// ============================================================================
async function reconcileCard(cardInput) {
  if (!cardInput) return { status: "MISSING_EVIDENCE", reason: "card não informado no input" };

  const totalLimit = money(cardInput.totalLimit);
  const observedAvailable = money(cardInput.observedAvailable);
  const usedLimitObserved = subtractMoney(totalLimit, observedAvailable);

  const knownBills = (cardInput.bills || []).map((b) => ({ ...b, amountMoney: money(b.amount) }));
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
  let projectedVsKnown = [];
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

      // Cruza cada CardBill persistida contra o valor CONHECIDO real (input) pro
      // mesmo cycleMonth, se houver — flag explícito quando o valor persistido
      // não bate com a realidade conhecida (evidência de materialização
      // artificial do comportamento antigo, Fase 4.1.2 item 6/Fase 4.1.3).
      const knownByMonth = new Map(knownBills.map((b) => [b.cycleMonth, b.amountMoney]));
      projectedVsKnown = persistedBills.map((pb) => {
        const known = knownByMonth.get(pb.cycleMonth);
        return {
          cycleMonth: pb.cycleMonth,
          persistedTotalAmount: pb.totalAmount,
          knownRealAmount: known?.toString() ?? null,
          matchesKnownReality: known != null ? compareMoney(money(pb.totalAmount), known) === 0 : null,
          looksLikeMaterializationArtifact: known != null ? compareMoney(money(pb.totalAmount), known) !== 0 : known === undefined && money(pb.totalAmount).isZero(),
        };
      });
    }
  }

  return {
    totalLimit: totalLimit.toString(),
    observedAvailable: observedAvailable.toString(),
    usedLimitChecksum,
    closingDay: cardInput.closingDay,
    dueDay: cardInput.dueDay,
    knownBills: knownBills.map((b) => ({ cycleMonth: b.cycleMonth, amount: b.amountMoney.toString(), status: b.status })),
    liabilityClassification: {
      rule: "Fase 4.1.2 — primeira bill não liquidada (cronológica) = INCURRED_LIABILITY, demais = FUTURE_OBLIGATION",
      incurredLiability: incurred ? { cycleMonth: incurred.cycleMonth, amount: incurred.amountMoney.toString() } : null,
      futureObligations: { total: futureSum.toString(), items: future.map((b) => ({ cycleMonth: b.cycleMonth, amount: b.amountMoney.toString() })) },
    },
    cardFoundInDb: card ? { id: card.id, slug: card.slug } : { status: "NOT_FOUND_IN_DB", slugSearched: cardInput.slug ?? null },
    persistedCardBillsInDb: persistedBills,
    persistedVsKnownReality: projectedVsKnown,
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
// W — Financial Engine dry-run (item 24) — 100% em memória, sobre o ESTADO
// CANÔNICO PROPOSTO (não sobre o banco, que sabemos desatualizado — item 8).
// Reusa as funções PURAS de lib/obligationClassifier.js e lib/freeMoney.js —
// nenhuma chamada a prisma nesta função.
// ============================================================================
function engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb, appSettings }) {
  const missing = [];

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

  // --- obligations: CardBill (proposto, valores conhecidos reais) ---
  const cardBillsProposed = (input.card?.bills || []).sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const unsettledSorted = cardBillsProposed.filter((b) => b.status !== "PAID").sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
  const currentRelevantCycleMonth = unsettledSorted[0]?.cycleMonth ?? null;

  let incurredLiabilities = ZERO;
  let futureObligationsFromCard = ZERO;
  const incurredItems = [];
  const futureItems = [];
  for (const bill of cardBillsProposed) {
    const asFakeBill = { totalAmount: money(bill.amount), paidAmount: bill.status === "PAID" ? money(bill.amount) : money(0), cycleMonth: bill.cycleMonth };
    const cls = classifyCardBill(asFakeBill, { isCurrentRelevant: bill.cycleMonth === currentRelevantCycleMonth });
    const remaining = subtractMoney(asFakeBill.totalAmount, asFakeBill.paidAmount);
    if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) {
      incurredLiabilities = addMoney(incurredLiabilities, remaining);
      incurredItems.push({ cycleMonth: bill.cycleMonth, amount: remaining.toString() });
    } else if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) {
      futureObligationsFromCard = addMoney(futureObligationsFromCard, remaining);
      futureItems.push({ cycleMonth: bill.cycleMonth, amount: remaining.toString() });
    }
  }

  // --- obligations: ConfirmedCommitment (proposto, genérico — vem do input) ---
  let currentHorizonObligations = ZERO;
  const currentHorizonItems = [];
  const unfundedConfirmedCommitments = { count: 0, amount: ZERO, items: [] };
  for (const c of input.confirmedCommitments || []) {
    const candidates = c.dateCandidates || [];
    if (candidates.length === 0) {
      missing.push({ field: `confirmedCommitment(${c.description}).dueDate`, impact: "não é possível classificar horizonte sem nenhuma data candidata", evidenceNeeded: "data confirmada do compromisso" });
      continue;
    }
    // Classifica sob CADA data candidata — só inclui no cálculo se o resultado
    // for O MESMO independente de qual candidata for a real (item 24.4: "só
    // calcule isso se a data/horizonte puder ser determinada com segurança").
    const classifications = candidates.map((dateStr) => classifyConfirmedCommitment(
      { status: "CONFIRMED", dueDate: d(dateStr) },
      { nextIncomeDate: nextIncomeProposed.expectedDate }
    ));
    const allSame = classifications.every((cls) => cls === classifications[0]);
    if (!allSame) {
      missing.push({ field: `confirmedCommitment(${c.description}).dueDate`, impact: "classificação de horizonte MUDA dependendo de qual candidata for a data real — não seguro decidir", evidenceNeeded: `data exata entre ${candidates.join(" ou ")}` });
      continue;
    }
    const cls = classifications[0];
    const amount = money(c.amount);
    const item = { type: "ConfirmedCommitment", description: c.description, amount: amount.toString(), dateCandidates: candidates, dateConfidence: c.dateConfidence, funding: c.funding, status: "CONFIRMED" };
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
  }

  // --- contingencyExposure (proposto, genérico) — nunca entra em freeMoney ---
  const contingencies = input.contingencies || [];
  const contingencyExpected = sumMoney(contingencies.filter((c) => c.expectedAmount != null).map((c) => money(c.expectedAmount)));
  const contingencyMax = sumMoney(contingencies.map((c) => money(c.maxAmount)));
  const contingencyItems = contingencies.map((c) => ({
    description: c.description,
    expectedAmount: c.expectedAmount != null ? money(c.expectedAmount).toString() : null,
    expectedAmountConfidence: c.expectedAmountConfidence,
    maxAmount: money(c.maxAmount).toString(),
    maxAmountConfidence: c.maxAmountConfidence,
    classification: classifyContingency({ status: c.status }),
  }));

  const canComputeFreeMoney = unrestrictedCash != null;
  const freeMoney = canComputeFreeMoney
    ? computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney, incurredLiabilities, currentHorizonObligations })
    : null;
  if (!canComputeFreeMoney) missing.push({ field: "freeMoney", impact: "depende de unrestrictedCash", evidenceNeeded: "checkingAccount.checkpointB" });

  const safeToSpend = freeMoney != null ? computeSafeToSpend(freeMoney, appSettings.safetyMarginPercent) : null;

  // --- nextIncomeCommitment window (proposto, in-memory, sem prisma) ---
  let nextIncomeCommitmentWindow = null;
  if (nextIncomeProposed.expectedDate) {
    const periodStart = nextIncomeProposed.expectedDate;
    const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, periodStart.getUTCDate()));
    const inWindow = [...incurredItems, ...futureItems, ...currentHorizonItems].filter((item) => {
      const dueDate = item.dueAt ? new Date(item.dueAt) : item.dateCandidates ? d(item.dateCandidates[0]) : null;
      return dueDate && isWithinNextIncomeCommitmentWindow(dueDate, periodStart, periodEnd);
    });
    nextIncomeCommitmentWindow = { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), note: "Cálculo aproximado — ver limitação abaixo sobre CardBill.dueAt não vir do input estruturado por data." };
  }

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
    freeMoney: freeMoney?.toString() ?? "INCOMPLETE",
    safeToSpend: safeToSpend ? { safetyMarginPercent: safeToSpend.safetyMarginPercent, safetyReserve: safeToSpend.safetyReserve.toString(), safeToSpend: safeToSpend.safeToSpend.toString() } : "INCOMPLETE",
    nextIncome: {
      currentDbState: nextIncomeFromDb,
      proposedIfSalaryRuleExisted: {
        expectedDate: nextIncomeProposed.expectedDate?.toISOString() ?? null,
        status: nextIncomeProposed.status,
        isFallback: nextIncomeProposed.isFallback,
        note: "RecurringRule de salário AINDA NÃO existe no banco (só a de VA existe) — este valor é hipotético, calculado com resolveNextExpectedIncome() PURO sobre uma RecurringRule proposta (dayOfMonth=24), NÃO persistido.",
      },
    },
    nextIncomeCommitment: nextIncomeCommitmentWindow,
    contingencyExposure: { expected: contingencyExpected.toString(), maximum: contingencyMax.toString(), items: contingencyItems, entersFreeMoneyBase: false },
    projections: {
      status: "INCOMPLETE",
      reason:
        "base/expected/stress (lib/financialProjection.js) leem CardBill/Bill/ExternalInstallment/ConfirmedCommitment/Contingency " +
        "DIRETAMENTE do banco via Prisma — não aceitam obrigações em memória. Os ConfirmedCommitment/Contingency propostos " +
        "neste snapshot ainda não estão persistidos (Fase 5.0 é estritamente read-only), então a projeção de 90 dias não pode " +
        "incluí-los sem inventar dados. Rodar a projeção completa com estes fatos exige a persistência da Fase 5.1 primeiro.",
    },
    missingEvidence: missing,
    status: missing.length > 0 ? "INCOMPLETE" : "COMPLETE",
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
  const push = (m) => mutations.push(m);

  push({
    category: "KEEP",
    model: "Account/Card/Purchase/Installment/RecurringRule já existentes",
    reference: "todos os registros já existentes no banco dev",
    before: "estado atual do dev (ver seção B — inventário)",
    after: "sem mudança",
    reason: "Nada nesta fase indica que esses registros estruturais estejam errados — só desatualizados em VALOR (que é reconciliação de dado, não de estrutura).",
    source: "N/A",
    confidence: "N/A",
    risk: "nenhum",
    requiredToClose: false,
  });

  if (cardRecon?.persistedVsKnownReality?.some((r) => r.looksLikeMaterializationArtifact)) {
    const mismatched = cardRecon.persistedVsKnownReality.filter((r) => r.looksLikeMaterializationArtifact);
    push({
      category: "LEAVE_AS_LEGACY",
      model: "CardBill",
      reference: `${mismatched.length} CardBill(s) persistida(s) cujo valor não bate com a realidade conhecida informada no input (cycleMonths: ${mismatched.map((r) => r.cycleMonth).join(", ")})`,
      before: "valores computados a partir de Purchase/Expense do dev, divergentes da realidade bancária informada",
      after: "sem mudança nesta fase — não apagar (Fase 4.1.3 item 7 e item 36 desta fase)",
      reason: "Prováveis artefatos do comportamento antigo de materialização (corrigido na Fase 4.1.3) ou dados de teste/legado. Apagar destruiria histórico sem necessidade — reconciliação real deve SOBRESCREVER com evidência (ver CREATE abaixo), não deletar.",
      source: "achado desta auditoria (seção O)",
      confidence: "N/A",
      risk: "baixo (dados de teste/desenvolvimento, não dinheiro real)",
      requiredToClose: false,
    });
  }

  if (input.card?.bills?.length > 0) {
    push({
      category: "CREATE",
      model: "CardBill (ou correção via nova âncora)",
      reference: `${input.card.bills.length} ciclo(s) conhecido(s) do cartão informado no input (ver seção N)`,
      before: "valores computados divergentes (ver LEAVE_AS_LEGACY acima, se aplicável)",
      after: "CardBill com totalAmount/paidAmount/status refletindo a realidade bancária confirmada no input",
      reason: "É o núcleo da reconciliação do cartão — sem isso, incurredLiabilities/futureObligations do Financial Engine real continuam errados.",
      source: "input do usuário (checkpoint bancário direto)",
      confidence: "conforme confidence de cada bill no input",
      risk: "médio — precisa decidir COMO reescrever CardBill.closingDay no Card real (hoje possivelmente diferente) sem quebrar histórico já materializado com a fórmula anterior",
      requiredToClose: true,
    });
  }

  if (input.card?.closingDay != null) {
    const currentClosingDay = inventory.card?.rows?.[0]?.closingDay ?? null;
    push({
      category: currentClosingDay === input.card.closingDay ? "KEEP" : "UPDATE",
      model: "Card",
      reference: "closingDay do cartão informado no input",
      before: `closingDay=${currentClosingDay === undefined ? "desconhecido" : currentClosingDay}`,
      after: `closingDay=${input.card.closingDay}`,
      reason: "Sem o closingDay real, getCardBillClosesAt/getCardBillDueDate usam a fórmula de fallback (mês calendário), que pode divergir do fechamento real do cartão.",
      source: "input do usuário",
      confidence: "conforme input",
      risk: currentClosingDay === input.card.closingDay ? "nenhum — já está correto" : "médio — muda o resultado de getCardCycleForDate pra TODAS as CardBills futuras; rodar acompanhado da correção de valores acima, não isoladamente",
      requiredToClose: currentClosingDay !== input.card.closingDay,
    });
  }

  if (input.checkingAccount) {
    push({
      category: "CREATE",
      model: "BalanceAdjustment",
      reference: "Account irrestrita informada no input (checkingAccount)",
      before: "última âncora existente no banco (ver seção B — inventário)",
      after: `newBalance=${money(input.checkingAccount.checkpointB.amount).toString()} (checkpointB, ${input.checkingAccount.checkpointB.date})`,
      reason: "Forma canônica já suportada pelo schema de estabelecer um novo saldo-âncora real, sem inventar histórico de transações que não temos evidência completa (ver derivedOpeningBalance=DERIVED_ONLY).",
      source: "input do usuário (extrato/observação direta)",
      confidence: input.checkingAccount.checkpointB.confidence,
      risk: "baixo — mesmo mecanismo de âncora já usado pelo resto do app (mesmo padrão de CardLimitUpdate)",
      requiredToClose: true,
    });

    if (checkingRecon?.unexplainedDifference && checkingRecon.unexplainedDifference !== "0") {
      push({
        category: "UNRESOLVED",
        model: "BalanceAdjustment / delta não explicado",
        reference: `diferença entre saldo matemático esperado (${checkingRecon.mathematicalExpected}) e observado (${checkingRecon.checkpointB.amount})`,
        before: "N/A",
        after: "N/A — NENHUMA ação proposta",
        reason: "Delta não explicado por nenhuma evidência disponível. Regra explícita do usuário: NÃO criar RECONCILIATION_ADJUSTMENT só pra fechar um delta pequeno sem investigação completa.",
        source: "N/A",
        confidence: "UNCERTAIN",
        risk: "depende da magnitude do delta — fica registrado como não resolvido, nunca escondido",
        requiredToClose: false,
      });
    }

    for (const m of input.checkingAccount.movementsAfterCheckpointA || []) {
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
          requiredToClose: false,
        });
      }
    }
  }

  if (input.restrictedAccount) {
    push({
      category: "CREATE",
      model: "BalanceAdjustment",
      reference: "Account restrita informada no input (restrictedAccount)",
      before: "última âncora existente no banco (ver seção B — inventário)",
      after: `newBalance=${money(input.restrictedAccount.observedClosing.amount).toString()} (observado, ${input.restrictedAccount.observedClosing.date})`,
      reason: "Mesma lógica da conta irrestrita — âncora real substitui a anterior.",
      source: "input do usuário",
      confidence: input.restrictedAccount.observedClosing.confidence,
      risk: "baixo",
      requiredToClose: true,
    });
  }

  if (input.mainIncome) {
    push({
      category: "LINK",
      model: "RecurringRule (proposta) + Income.recurringOccurrenceDate",
      reference: `renda principal informada no input (dayOfMonth=${input.mainIncome.dayOfMonth})`,
      before: "Nenhuma RecurringRule cobrindo essa renda existe hoje no banco (ver seção Q)",
      after: `RecurringRule{ kind:'income', dayOfMonth:${input.mainIncome.dayOfMonth}, amount:${money(input.mainIncome.amount).toString()} } + Income vinculado via recurringOccurrenceDate=${input.mainIncome.date}`,
      reason: "Formaliza a renda principal, hoje invisível pro Financial Engine (que cai em FALLBACK sem ela).",
      source: "input do usuário",
      confidence: input.mainIncome.confidence,
      risk: "baixo",
      requiredToClose: false,
    });
  }

  for (const c of input.confirmedCommitments || []) {
    const dateNote = (c.dateCandidates || []).length > 1 ? `dueDate ainda ambígua entre: ${c.dateCandidates.join(" ou ")} — decidir antes de persistir` : c.dateCandidates?.[0] ?? "sem data";
    push({
      category: "CREATE",
      model: "ConfirmedCommitment",
      reference: c.description,
      before: "N/A",
      after: `ConfirmedCommitment{ description:'${c.description}', amount:${money(c.amount).toString()}, dueDate:<${dateNote}>, status:CONFIRMED, funding:${c.funding} }`,
      reason: "Compromisso confirmado, funding possivelmente indefinido — exatamente o caso de uso do model.",
      source: "input do usuário",
      confidence: `amount=${c.amountConfidence}, data=${c.dateConfidence}`,
      risk: (c.dateCandidates || []).length > 1 ? "médio — data precisa ser resolvida antes de persistir (pode não afetar a classificação de horizonte, ver seção W, mas afeta a projeção diária exata)" : "baixo",
      requiredToClose: false,
    });
  }

  for (const c of input.contingencies || []) {
    push({
      category: "CREATE",
      model: "Contingency",
      reference: c.description,
      before: "N/A",
      after: `Contingency{ description:'${c.description}', expectedAmount:${c.expectedAmount != null ? money(c.expectedAmount).toString() : "null"}, maxAmount:${money(c.maxAmount).toString()}, status:${c.status} }`,
      reason: "Risco aguardando confirmação — não é obrigação confirmada, não deve reduzir freeMoney base.",
      source: "input do usuário",
      confidence: `expectedAmount=${c.expectedAmountConfidence}, maxAmount=${c.maxAmountConfidence}`,
      risk: "baixo",
      requiredToClose: false,
    });
  }

  for (const e of input.otherEvidence || []) {
    push({
      category: "UNRESOLVED",
      model: "N/A — evidência incompleta",
      reference: e.description,
      before: "N/A",
      after: "N/A — sem data e/ou conta de destino confirmada",
      reason: e.note || "Evidência insuficiente pra propor uma mutação concreta sem inventar dado (data, conta, ou classificação).",
      source: "input do usuário (memória, incompleta)",
      confidence: e.confidence,
      risk: "a avaliar quando a evidência completa existir",
      requiredToClose: false,
    });
  }

  return mutations;
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
  if (vaRecon?.unexplainedDifferenceVA && vaRecon.unexplainedDifferenceVA !== "0") {
    blockers.push({ area: "Delta não explicado na conta restrita (VA)", description: `unexplainedDifferenceVA=${vaRecon.unexplainedDifferenceVA}` });
  }
  if (cardRecon?.usedLimitChecksum && !cardRecon.usedLimitChecksum.matches) {
    blockers.push({ area: "Cartão — checksum de limite usado", description: "Soma das faturas conhecidas não bate com o limite usado observado." });
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
  const vaRecon = await reconcileRestrictedLedger(input.restrictedAccount);
  const cardRecon = await reconcileCard(input.card);
  const schemaAudit = auditTransferSchemaForExternalScope();

  const nextIncomeFromDbRaw = await resolveNextExpectedIncomeFromDb({ now: d(input.asOf) });
  const nextIncomeFromDb = { ...nextIncomeFromDbRaw, expectedDate: nextIncomeFromDbRaw.expectedDate?.toISOString() ?? null };

  let nextIncomeProposed = { expectedDate: null, status: "MISSING_EVIDENCE", isFallback: null };
  if (input.mainIncome) {
    const syntheticRule = { id: "proposed-salario", kind: "income", isActive: true, dayOfMonth: input.mainIncome.dayOfMonth, accountId: null, amount: money(input.mainIncome.amount) };
    nextIncomeProposed = resolveNextExpectedIncome({ now: d(input.asOf), recurringRules: [syntheticRule], realizedIncomes: [], accounts: [], settings });
  }

  const engineResult = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb, appSettings: settings });
  const confidenceMatrix = buildConfidenceMatrix(input);
  const proposedCanonicalSnapshot = buildProposedCanonicalSnapshot(input, cardRecon);
  const proposedMutations = buildProposedMutations(input, inventory, checkingRecon, vaRecon, cardRecon);
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
    K_restrictedAccountLedgerCandidate: vaRecon,
    L_restrictedAccountReconciliation: { unexplainedDifference: vaRecon.unexplainedDifferenceVA, investigation: vaRecon.investigationNote },
    M_derivedOpeningBalanceRestrictedAccount: vaRecon.derivedOpeningBalanceVA,
    N_cardReconciliation: cardRecon,
    O_persistedVsProjectedCardBills: { persistedInDb: cardRecon.persistedCardBillsInDb, comparisonAgainstKnownReality: cardRecon.persistedVsKnownReality },
    P_externalInstallments: (input.externalInstallmentPlans || []).length > 0 ? input.externalInstallmentPlans : { status: "MISSING_EVIDENCE", note: "Nenhum plano com evidência suficiente informado neste snapshot." },
    Q_recurringIncomeProposal: {
      currentDbState: nextIncomeFromDb,
      proposed: input.mainIncome
        ? { kind: "income", dayOfMonth: input.mainIncome.dayOfMonth, amount: money(input.mainIncome.amount).toString(), occurrenceToLink: input.mainIncome.date }
        : { status: "MISSING_EVIDENCE" },
      nextIncomeIfProposedRuleExisted: { expectedDate: nextIncomeProposed.expectedDate?.toISOString?.() ?? nextIncomeProposed.expectedDate, status: nextIncomeProposed.status },
    },
    R_externalTransfers: { facts: input.externalTransfers || [], schemaAudit },
    S_confirmedCommitments: input.confirmedCommitments || [],
    T_contingencies: input.contingencies || [],
    U_confidenceSourceMatrix: confidenceMatrix,
    V_proposedCanonicalSnapshot: proposedCanonicalSnapshot,
    W_financialEngineDryRun: engineResult,
    X_proposedMutationsForFase51: proposedMutations,
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

export { main, buildInventory, reconcileCheckingLedger, reconcileRestrictedLedger, reconcileCard, engineDryRun, auditTransferSchemaForExternalScope };
