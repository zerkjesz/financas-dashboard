import { prisma } from "../prisma.js";
import { money, addMoney, subtractMoney, multiplyMoney, divideMoney, roundMoney, compareMoney, isPositive, isZeroMoney, ZERO } from "../money.js";
import { buildFinancialEngineSummary } from "../financialEngine.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend, resolveCurrentRelevantCardBillCycleMonth, isWithinNextIncomeCommitmentWindow } from "../freeMoney.js";
import { computeFinancialStatus } from "../financialStatus.js";
import { classifyCardBill, OBLIGATION_CLASS } from "../obligationClassifier.js";
import { computeCardTotalLimit, computeCardUsedLimit } from "../cards.js";
import { listCardBillsView } from "../cardBillCalculator.js";
import { getCardCycleForDate, getCardBillClosesAt, getCardBillDueDate } from "../cardCycle.js";
import { computeInstallmentScheduleRows } from "../installments.js";
import { buildBaseProjection, buildExpectedProjection, buildStressProjection } from "../financialProjection.js";
import { listAccountsWithBalances } from "../accounts.js";

// ============================================================================
// Fase 5.3E — CANONICAL FINANCIAL SIMULATOR.
//
// PRINCÍPIO CENTRAL (não negociável, repetido no pedido): overlay, não
// mutação. Nenhuma linha deste arquivo escreve no banco. Nenhuma fórmula
// financeira é reimplementada aqui — toda conta de freeMoney/safeToSpend/
// status/parcela/ciclo/limite reaproveita a MESMA função pura/canônica já
// usada pelo produto real (financialEngine/freeMoney/financialStatus/
// obligationClassifier/cards/cardCycle/installments/financialProjection).
// Este módulo só COMPÕE um "e se" em cima do snapshot real: pega a verdade
// canônica de agora (baseline), sobrepõe o efeito hipotético em memória
// (nunca lido de volta do banco), e recomputa as MESMAS funções sobre o
// resultado sobreposto (simulated). Nunca usa transaction+rollback como
// mecanismo — DB é somente leitura do início ao fim.
// ============================================================================

export const SIMULATION_SCENARIO_TYPE = Object.freeze({
  CASH_EXPENSE_NOW: "CASH_EXPENSE_NOW",
  CARD_PURCHASE_SINGLE: "CARD_PURCHASE_SINGLE",
  CARD_PURCHASE_INSTALLMENTS: "CARD_PURCHASE_INSTALLMENTS",
  CONTINGENCY_REALIZATION: "CONTINGENCY_REALIZATION",
});

// Erro de validação de entrada — nunca uma AssertionError genérica, pra quem
// consome (API/Telegram) poder devolver uma mensagem clara sem adivinhar.
export class SimulationInputError extends Error {
  constructor(message, code = "SIMULATION_INVALID_INPUT") {
    super(message);
    this.name = "SimulationInputError";
    this.code = code;
  }
}

const DEFAULT_HORIZON_DAYS = 90;
const MAX_INSTALLMENT_COUNT = 60; // mesma ordem de grandeza de qualquer parcelamento real do produto — bloqueia entradas absurdas (999999x).

function assertMoneyInput(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) {
    throw new SimulationInputError(`${fieldName} inválido: precisa ser um número finito maior que zero (recebido: ${JSON.stringify(value)})`);
  }
}

function assertInstallmentCount(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INSTALLMENT_COUNT) {
    throw new SimulationInputError(`installmentCount inválido: precisa ser um inteiro entre 1 e ${MAX_INSTALLMENT_COUNT} (recebido: ${JSON.stringify(value)})`);
  }
}

function assertDate(value, fieldName) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SimulationInputError(`${fieldName} inválido: precisa resultar numa data válida`);
  }
}

// Reproduz a MESMA passada de agregação que lib/freeMoney.js:classifyAllObligations
// já faz por cartão (resolveCurrentRelevantCardBillCycleMonth + classifyCardBill),
// só que isolada pra UM cartão de cada vez (real ou com overlay em memória) —
// nenhuma regra de classificação nova, só reaproveita as duas funções puras
// existentes numa lista de bills fornecida por quem chama.
function summarizeCardBills(bills) {
  const currentRelevantCycleMonth = resolveCurrentRelevantCardBillCycleMonth(bills);
  let incurred = ZERO;
  let future = ZERO;
  for (const bill of bills) {
    const cls = classifyCardBill(bill, { isCurrentRelevant: bill.cycleMonth === currentRelevantCycleMonth });
    const remaining = subtractMoney(money(bill.totalAmount), money(bill.paidAmount ?? 0));
    if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) incurred = addMoney(incurred, remaining);
    if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) future = addMoney(future, remaining);
  }
  return { incurred, future, currentRelevantCycleMonth };
}

// Sobrepõe as parcelas HIPOTÉTICAS (nunca persistidas) na visão REAL de
// faturas do cartão (listCardBillsView — read-only, já combina persisted +
// projected, exatamente a mesma leitura que o dashboard/projeção usam). Cria
// uma entrada sintética só em memória pra qualquer cycleMonth fora da janela
// padrão de listCardBillsView (ex: parcelamento longo ultrapassando os 12
// meses futuros padrão) — nunca grava nada, nunca reconsulta o banco por ela.
async function buildCardOverlay({ client, now, card, installmentRows }) {
  const realBills = await listCardBillsView(card.id, { now, client });
  const baselineSummary = summarizeCardBills(realBills);

  const byCycle = new Map(realBills.map((b) => [b.cycleMonth, { ...b }]));
  for (const row of installmentRows) {
    const existing = byCycle.get(row.billMonth);
    if (existing) {
      byCycle.set(row.billMonth, { ...existing, totalAmount: addMoney(money(existing.totalAmount), row.amount) });
    } else {
      byCycle.set(row.billMonth, {
        id: null,
        cardId: card.id,
        cycleMonth: row.billMonth,
        closesAt: getCardBillClosesAt(card, row.billMonth),
        dueAt: getCardBillDueDate(card, row.billMonth),
        totalAmount: row.amount,
        paidAmount: null,
        status: "open",
        paidAt: null,
        createdAt: null,
        updatedAt: null,
        isPersisted: false,
      });
    }
  }
  const overlayBills = Array.from(byCycle.values());
  const overlaySummary = summarizeCardBills(overlayBills);

  return {
    realBills,
    overlayBills,
    incurredDelta: subtractMoney(overlaySummary.incurred, baselineSummary.incurred),
    futureDelta: subtractMoney(overlaySummary.future, baselineSummary.future),
  };
}

// Mesma fórmula de lib/freeMoney.js:getNextIncomeCommitment (committedAmount /
// expectedIncomeAmount * 100, nunca inventa denominador) — replicada aqui só
// porque o overlay hipotético não pode chamar getNextIncomeCommitment de novo
// (ele lê CardBill do banco; a parcela simulada nunca está lá). Não é uma
// regra financeira nova — é a mesma razão simples, com a mesma proteção
// contra denominador ausente/zero.
function computeCommittedPercent(committedAmount, expectedIncomeAmount) {
  if (expectedIncomeAmount == null || !isPositive(money(expectedIncomeAmount))) return null;
  return multiplyMoney(divideMoney(committedAmount, expectedIncomeAmount), 100);
}

function projectionCheckpointDelta(baselineProjection, simulatedProjection) {
  const out = {};
  for (const key of ["today", "day30", "day60", "day90"]) {
    out[key] = subtractMoney(simulatedProjection.checkpoints[key].projectedCash, baselineProjection.checkpoints[key].projectedCash);
  }
  return out;
}

// Fase 5.4E — BUG REAL corrigido (achado ao vivo na UI): `.toFixed(2)` puro
// devolve separador decimal com PONTO ("2648.85"), inconsistente com
// formatMoney (usado em toda a UI) que usa vírgula/milhar brasileiro
// ("2.648,85") — nas frases de `explanation` isso aparecia como
// "R$2648.85" ao lado de números formatados certo no resto da tela. Só
// muda a REPRESENTAÇÃO EM STRING do valor já corretamente arredondado —
// nenhuma conta financeira muda (mesmo Decimal, mesmo roundMoney).
//
// Segundo achado ao vivo, mesma rodada: todo `R$${money2(...)}` nas frases de
// `explanation` concatenava sem espaço ("R$2.648,85"), enquanto formatMoney
// (usado no resto do ResultPanel, na mesma tela) produz "R$ 2.648,85" com
// espaço — inconsistência visível lado a lado dentro do mesmo disclosure.
// Corrigido nos 4 template literals que usam money2 (" R$ " em vez de "R$"),
// de novo só REPRESENTAÇÃO EM STRING — nenhum valor muda.
function money2(v) {
  return Number(roundMoney(money(v)).toFixed(2)).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================================
// simulateFinancialScenario — ponto de entrada único do simulador.
//
// scenario.type = CASH_EXPENSE_NOW        { amount, description? }
// scenario.type = CARD_PURCHASE_SINGLE    { cardId, amount, description?, purchasedAt? }
// scenario.type = CARD_PURCHASE_INSTALLMENTS { cardId, totalAmount, installmentCount, description?, purchasedAt? }
// scenario.type = CONTINGENCY_REALIZATION { contingencyId, amount? | amountField: "expected"|"max", timing: "NOW" | ISODateString, description? }
//
// 100% leitura: `client` default `prisma` (mesmo padrão aditivo do resto do
// projeto) — nunca abre transação, nunca chama create/update/delete.
// ============================================================================
export async function simulateFinancialScenario({ client = prisma, now = new Date(), horizonDays = DEFAULT_HORIZON_DAYS, scenario } = {}) {
  if (!scenario || !SIMULATION_SCENARIO_TYPE[scenario.type]) {
    throw new SimulationInputError(`scenario.type inválido: ${JSON.stringify(scenario?.type)}`);
  }
  const type = scenario.type;

  // ---- baseline: a MESMA verdade canônica do produto real, zero recomputo. -
  const [baselineEngine, accounts] = await Promise.all([
    buildFinancialEngineSummary({ now, horizonDays, client }),
    listAccountsWithBalances({ client }),
  ]);

  const baseline = {
    unrestrictedCash: baselineEngine.balances.unrestrictedCash,
    protectedMoney: baselineEngine.balances.protectedMoney,
    incurredLiabilities: baselineEngine.obligations.incurredLiabilities,
    currentHorizonObligations: baselineEngine.obligations.currentHorizon,
    freeMoney: baselineEngine.freeMoney,
    safeToSpend: baselineEngine.safeToSpend,
    safetyMarginPercent: baselineEngine.safetyMarginPercent,
    status: baselineEngine.status,
    nextIncomeCommitment: baselineEngine.nextIncomeCommitment,
    projections: baselineEngine.projections,
  };

  let simulatedUnrestrictedCash = baseline.unrestrictedCash;
  let simulatedIncurredLiabilities = baseline.incurredLiabilities;
  let simulatedCommittedAmount = baseline.nextIncomeCommitment.committedAmount;
  let extraEvents = [];
  let cardFeasibility = null;
  let installmentSchedule = null;
  const explanation = [];

  if (type === SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW) {
    assertMoneyInput(scenario.amount, "amount");
    const amountMoney = money(scenario.amount);
    simulatedUnrestrictedCash = subtractMoney(baseline.unrestrictedCash, amountMoney);
    extraEvents = [
      {
        date: now,
        label: scenario.description || "Simulação: gasto hipotético em dinheiro/débito",
        kind: "SIMULATED_CASH_EXPENSE",
        amount: multiplyMoney(amountMoney, -1),
      },
    ];
    explanation.push(`unrestrictedCash reduzido diretamente em R$ ${money2(amountMoney)} — gasto em dinheiro/débito não passa por cartão, nunca afeta limite.`);
  } else if (type === SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE || type === SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS) {
    if (!scenario.cardId) throw new SimulationInputError("cardId é obrigatório para simular compra no cartão");
    const card = await client.card.findUnique({ where: { id: scenario.cardId } });
    if (!card) throw new SimulationInputError(`Cartão não encontrado: ${scenario.cardId}`, "SIMULATION_CARD_NOT_FOUND");

    const purchasedAt = scenario.purchasedAt ? new Date(scenario.purchasedAt) : now;
    assertDate(purchasedAt, "purchasedAt");

    let totalAmount;
    let installmentCount;
    if (type === SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE) {
      assertMoneyInput(scenario.amount, "amount");
      totalAmount = money(scenario.amount);
      installmentCount = 1;
    } else {
      assertMoneyInput(scenario.totalAmount, "totalAmount");
      assertInstallmentCount(scenario.installmentCount);
      totalAmount = money(scenario.totalAmount);
      installmentCount = scenario.installmentCount;
    }

    // MESMA fórmula de installmentValue que app/api/purchases/route.js e
    // lib/commitBotIntent.js usam pra uma compra REAL — nenhum arredondamento
    // divergente entre "de verdade" e "simulado".
    const installmentValue = roundMoney(divideMoney(totalAmount, installmentCount));
    const firstInstallmentMonth = getCardCycleForDate(card, purchasedAt);
    const rows = computeInstallmentScheduleRows({ totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber: 1 });
    installmentSchedule = rows.map((row) => ({ ...row, dueAt: getCardBillDueDate(card, row.billMonth) }));

    // ---- CARD_FEASIBILITY — sempre reportado separado de BUDGET_SAFETY.
    const [totalLimit, usedLimit] = await Promise.all([computeCardTotalLimit(card.id, { client }), computeCardUsedLimit(card.id, { client })]);
    const availableLimitBefore = subtractMoney(totalLimit, usedLimit);
    const canAuthorize = compareMoney(totalAmount, availableLimitBefore) <= 0;
    cardFeasibility = {
      cardId: card.id,
      cardName: card.name,
      totalAmount,
      totalLimit,
      usedLimitBefore: usedLimit,
      availableLimitBefore,
      usedLimitAfter: addMoney(usedLimit, totalAmount),
      availableLimitAfter: subtractMoney(availableLimitBefore, totalAmount),
      verdict: canAuthorize ? "CAN_AUTHORIZE" : "CANNOT_AUTHORIZE",
      shortfall: canAuthorize ? ZERO : subtractMoney(totalAmount, availableLimitBefore),
    };
    explanation.push(
      canAuthorize
        ? `Limite disponível do cartão ${card.name} (R$ ${money2(availableLimitBefore)}) cobre a compra de R$ ${money2(totalAmount)}.`
        : `Limite disponível do cartão ${card.name} (R$ ${money2(availableLimitBefore)}) NÃO cobre a compra de R$ ${money2(totalAmount)} — faltam R$ ${money2(subtractMoney(totalAmount, availableLimitBefore))}.`
    );

    // ---- BUDGET_SAFETY — overlay de faturas; unrestrictedCash NUNCA muda aqui
    // (compra no cartão nunca debita conta diretamente — só quando a fatura é
    // paga de verdade, isso é o payBill real, fora do escopo do simulador).
    const overlay = await buildCardOverlay({ client, now, card, installmentRows: rows });
    simulatedIncurredLiabilities = addMoney(baseline.incurredLiabilities, overlay.incurredDelta);
    explanation.push(
      isZeroMoney(overlay.incurredDelta)
        ? `Nenhuma parcela desta compra cai na fatura atualmente relevante do cartão ${card.name} — incurredLiabilities não muda hoje.`
        : `R$ ${money2(overlay.incurredDelta)} desta compra entra na fatura atualmente relevante do cartão ${card.name} — soma a incurredLiabilities hoje.`
    );

    // ---- nextIncomeCommitment — parcelas com dueAt dentro da janela da próxima renda.
    const { periodStart, periodEnd } = baseline.nextIncomeCommitment;
    let windowDelta = ZERO;
    for (const row of installmentSchedule) {
      if (isWithinNextIncomeCommitmentWindow(row.dueAt, periodStart, periodEnd)) windowDelta = addMoney(windowDelta, row.amount);
    }
    simulatedCommittedAmount = addMoney(baseline.nextIncomeCommitment.committedAmount, windowDelta);

    // ---- projeção: cada parcela sai do caixa físico no dueAt real da fatura daquele ciclo.
    extraEvents = installmentSchedule.map((row) => ({
      date: row.dueAt,
      label: `${scenario.description || "Compra simulada"} — parcela ${row.number}/${installmentCount} (${card.name})`,
      kind: "SIMULATED_CARD_INSTALLMENT",
      amount: multiplyMoney(row.amount, -1),
    }));
  } else if (type === SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION) {
    if (!scenario.contingencyId) throw new SimulationInputError("contingencyId é obrigatório");
    const contingency = await client.contingency.findUnique({ where: { id: scenario.contingencyId } });
    if (!contingency) throw new SimulationInputError(`Contingência não encontrada: ${scenario.contingencyId}`, "SIMULATION_CONTINGENCY_NOT_FOUND");

    let amountMoney;
    if (scenario.amount != null) {
      assertMoneyInput(scenario.amount, "amount");
      amountMoney = money(scenario.amount);
    } else if (scenario.amountField === "expected" && contingency.expectedAmount != null) {
      amountMoney = money(contingency.expectedAmount);
    } else if (scenario.amountField === "max") {
      amountMoney = money(contingency.maxAmount);
    } else {
      throw new SimulationInputError(
        "Informe scenario.amount explícito, ou scenario.amountField ('expected'|'max') referenciando um valor real já cadastrado nesta contingência — nunca inventado.",
        "SIMULATION_AMOUNT_REQUIRED"
      );
    }

    // Timing NUNCA assumido silenciosamente (instrução explícita da Fase 5.3E).
    if (scenario.timing == null) {
      throw new SimulationInputError(
        "Timing da contingência não informado. Informe scenario.timing='NOW' explicitamente, ou uma data ISO — nunca assumido silenciosamente.",
        "SIMULATION_TIMING_REQUIRED"
      );
    }
    const timingDate = scenario.timing === "NOW" ? now : new Date(scenario.timing);
    assertDate(timingDate, "timing");

    // Só afeta o caixa físico HOJE se o timing for hoje/passado dentro da
    // janela — se for uma data futura, entra só na projeção (extraEvents),
    // igual a qualquer outra obrigação futura real.
    simulatedUnrestrictedCash = timingDate <= now ? subtractMoney(baseline.unrestrictedCash, amountMoney) : baseline.unrestrictedCash;
    extraEvents = [{ date: timingDate, label: `Contingência: ${contingency.description}`, kind: "SIMULATED_CONTINGENCY_REALIZATION", amount: multiplyMoney(amountMoney, -1) }];
    explanation.push(`Contingência real "${contingency.description}" tratada como saída de R$ ${money2(amountMoney)} em ${timingDate.toISOString().slice(0, 10)}.`);
  }

  // ---- freeMoney/safeToSpend simulados — mesma fórmula canônica, nunca reimplementada.
  const simulatedFreeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash: simulatedUnrestrictedCash,
    protectedMoney: baseline.protectedMoney,
    incurredLiabilities: simulatedIncurredLiabilities,
    currentHorizonObligations: baseline.currentHorizonObligations,
  });
  const simulatedSafeToSpendInfo = computeSafeToSpend(simulatedFreeMoney, baseline.safetyMarginPercent);
  const simulatedCommittedPercent = computeCommittedPercent(simulatedCommittedAmount, baseline.nextIncomeCommitment.expectedIncomeAmount);

  const [base, expected, stress] = await Promise.all([
    buildBaseProjection({ now, accounts, horizonDays, extraEvents }),
    buildExpectedProjection({ now, accounts, horizonDays, extraEvents }),
    buildStressProjection({ now, accounts, horizonDays, extraEvents }),
  ]);
  const simulatedStatus = computeFinancialStatus({
    freeMoney: simulatedFreeMoney,
    nextIncomeDate: baselineEngine.nextIncome.expectedDate,
    currentObligationHorizonEnd: baselineEngine.currentObligationHorizonEnd,
    nextIncomeStatus: baselineEngine.nextIncome.status,
    baseProjection: base,
    expectedProjection: expected,
    stressProjection: stress,
    unfundedConfirmedCommitments: baselineEngine.obligations.unfundedConfirmedCommitments,
  });

  const simulated = {
    unrestrictedCash: simulatedUnrestrictedCash,
    protectedMoney: baseline.protectedMoney,
    incurredLiabilities: simulatedIncurredLiabilities,
    currentHorizonObligations: baseline.currentHorizonObligations,
    freeMoney: simulatedFreeMoney,
    safeToSpend: simulatedSafeToSpendInfo.safeToSpend,
    safetyMarginPercent: baseline.safetyMarginPercent,
    status: simulatedStatus,
    nextIncomeCommitment: { ...baseline.nextIncomeCommitment, committedAmount: simulatedCommittedAmount, committedPercent: simulatedCommittedPercent },
    projections: { base, expected, stress },
  };

  // ---- BUDGET_SAFETY: reusa computeFinancialStatus (nunca reimplementa
  // threshold nenhum) — TRANQUILO/ATENCAO => SAFE; APERTADO/CRITICO => NOT_SAFE.
  const budgetSafetyVerdict = simulatedStatus.status === "TRANQUILO" || simulatedStatus.status === "ATENCAO" ? "SAFE" : "NOT_SAFE";
  const budgetSafety = { verdict: budgetSafetyVerdict, simulatedStatus: simulatedStatus.status, reasons: simulatedStatus.reasons };

  // ---- Invariante explícita e obrigatória da Fase 5.3E: cardFeasibility=
  // CAN_AUTHORIZE NUNCA basta sozinho — safeToSpend=0/freeMoney negativo
  // bloqueia o verdict geral mesmo com limite de cartão disponível.
  let verdict;
  if (cardFeasibility && cardFeasibility.verdict === "CANNOT_AUTHORIZE") {
    verdict = "CANNOT_AUTHORIZE";
  } else if (budgetSafetyVerdict === "NOT_SAFE") {
    verdict = "NOT_SAFE";
  } else {
    verdict = "SAFE";
  }

  return {
    scenarioType: type,
    asOf: now,
    horizonDays,
    baseline,
    simulated,
    delta: {
      freeMoney: subtractMoney(simulatedFreeMoney, baseline.freeMoney),
      safeToSpend: subtractMoney(simulatedSafeToSpendInfo.safeToSpend, baseline.safeToSpend),
      incurredLiabilities: subtractMoney(simulatedIncurredLiabilities, baseline.incurredLiabilities),
      nextIncomeCommitmentAmount: subtractMoney(simulatedCommittedAmount, baseline.nextIncomeCommitment.committedAmount),
      projectionCheckpoints: {
        base: projectionCheckpointDelta(baseline.projections.base, base),
        expected: projectionCheckpointDelta(baseline.projections.expected, expected),
        stress: projectionCheckpointDelta(baseline.projections.stress, stress),
      },
    },
    cardFeasibility,
    budgetSafety,
    verdict,
    installmentSchedule,
    explanation,
    // Precisão exigida pelo usuário (carry-over desde a Fase 5.3C): esta
    // função NUNCA cria/atualiza/apaga nenhuma row real — é 100% leitura +
    // aritmética em memória. Reportado aqui pra todo consumidor (API/
    // Telegram/testes) poder citar isso sem inventar a própria frase.
    zeroWriteProof: { ZERO_REAL_USER_FINANCIAL_WRITES: "YES", SIMULATION_IS_PURE_OVERLAY_NEVER_TX_ROLLBACK: "YES" },
  };
}
