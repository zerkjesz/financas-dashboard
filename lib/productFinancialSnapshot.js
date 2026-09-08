import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney, sumMoney, ZERO } from "./money.js";
import { listAccountsWithBalances } from "./accounts.js";
import { unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { buildFinancialEngineSummary } from "./financialEngine.js";
import { getProtectedMoneyBreakdown } from "./freeMoney.js";
import { buildVaSnapshot } from "./vaPanel.js";
import { listExternalInstallmentPlans, computeExternalInstallmentRunoff } from "./externalInstallments.js";
import { OBLIGATION_CLASS } from "./obligationClassifier.js";

// ============================================================================
// Fase 5.3B — PRODUCT READ MODEL. Fonte única que toda superfície de produto
// (dashboard, futuras telas, futuro Telegram read) deve consumir pra exibir
// verdade financeira. Este arquivo NÃO reimplementa NENHUMA fórmula — ele só
// COMPÕE os helpers canônicos já existentes (financialEngine/freeMoney/
// obligationClassifier/incomeHorizon/vaPanel/externalInstallments) e organiza
// o resultado num formato pronto pra apresentação. Onde um número aqui é uma
// soma/combinação de dois campos canônicos (ex: nextIncomeCommitment.
// cardAmount + externalAmount), o total continua vindo do helper canônico
// (committedAmount) e a decomposição é só reconciliada contra ele — nunca
// recomputada por fora (ver `otherAmount` abaixo, que é a prova dessa
// reconciliação, não um número inventado).
//
// `client`/`now` opcionais (mesmo padrão aditivo do resto do projeto) —
// propagados a todo helper que já os suporta.
export async function buildProductFinancialSnapshot({ client = prisma, now = new Date() } = {}) {
  const [engine, va, accounts, activePlans] = await Promise.all([
    buildFinancialEngineSummary({ now, client }),
    buildVaSnapshot({ client, now }),
    listAccountsWithBalances({ client }),
    listExternalInstallmentPlans({ status: "ACTIVE", client }),
  ]);

  const unrestrictedIds = unrestrictedCashAccountIds(accounts);
  const reserveBreakdown = await getProtectedMoneyBreakdown({ unrestrictedAccountIds: unrestrictedIds, client });

  // ---- liquidity -----------------------------------------------------------
  const liquidity = {
    unrestrictedCash: engine.balances.unrestrictedCash,
    protectedMoney: engine.balances.protectedMoney,
    freeMoney: engine.freeMoney,
    safeToSpend: engine.safeToSpend,
    safetyMarginPercent: engine.safetyMarginPercent,
    status: engine.status.status,
    statusReasons: engine.status.reasons,
  };

  // ---- restricted (VA) ------------------------------------------------------
  const restricted = va
    ? {
        vaBalance: va.balance,
        vaReceived: va.recebido,
        vaSpent: va.gasto,
        vaNextRecharge: va.nextRecharge,
        vaDaysRemaining: va.diasRestantes,
      }
    : null;

  // ---- currentObligations ---------------------------------------------------
  // breakdown = os dois buckets que efetivamente sequestram freeMoney hoje
  // (INCURRED_LIABILITY + CURRENT_HORIZON_OBLIGATION) — cada item já vem
  // classificado pelo obligationClassifier, nunca reclassificado aqui.
  const currentObligations = {
    incurredLiabilities: engine.obligations.incurredLiabilities,
    dueBeforeNextIncome: engine.obligations.currentHorizon,
    breakdown: [
      ...engine.obligations.incurredLiabilitiesItems.map((i) => ({ ...i, class: OBLIGATION_CLASS.INCURRED_LIABILITY })),
      ...engine.obligations.currentHorizonItems.map((i) => ({ ...i, class: OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION })),
    ],
  };

  // ---- nextIncome -------------------------------------------------------
  // actualAmountKnown é SEMPRE false/actualAmount SEMPRE null por construção:
  // `nextIncome` (lib/incomeHorizon.js) só resolve a ocorrência que AINDA NÃO
  // foi realizada (ver resolveRuleOccurrence) — se já tivesse Income real
  // vinculado, essa ocorrência não seria mais "a próxima". `amount` é o valor
  // BASE configurado na RecurringRule, nunca o valor que efetivamente vai
  // cair (que só existe quando o Income real for lançado).
  const nextIncome = {
    expectedDate: engine.nextIncome.expectedDate,
    baseAmount: engine.nextIncome.amount,
    actualAmountKnown: false,
    actualAmount: null,
    status: engine.nextIncome.status,
    isFallback: engine.nextIncome.isFallback,
  };

  // ---- nextIncomeCommitment ------------------------------------------------
  // cardAmount/externalAmount são DECOMPOSIÇÃO de committedAmount (que
  // continua vindo 100% de getNextIncomeCommitment, o helper canônico) —
  // nunca uma soma alternativa. `otherAmount` é a prova dessa reconciliação:
  // se algum dia um Bill também cair dentro da janela de próxima renda,
  // otherAmount deixa de ser zero em vez de a UI mentir silenciosamente que
  // só existem 2 componentes.
  const cardAmount = engine.obligations.incurredLiabilities;
  const externalAmount = engine.obligations.nextIncomeWindowCommitment;
  const otherAmount = subtractMoney(engine.nextIncomeCommitment.committedAmount, addMoney(cardAmount, externalAmount));
  const nextIncomeCommitment = {
    cardAmount,
    externalAmount,
    otherAmount,
    committedAmount: engine.nextIncomeCommitment.committedAmount,
    baseCommittedPercent: engine.nextIncomeCommitment.committedPercent,
  };

  // ---- externalInstallments --------------------------------------------------
  const nextWindowItems = engine.obligations.nextIncomeWindowCommitmentItems;
  const futureExternalItems = engine.obligations.futureItems.filter((i) => i.type === "ExternalInstallment");
  const outstandingAmount = sumMoney([
    ...nextWindowItems.map((i) => i.amount),
    ...futureExternalItems.map((i) => i.amount),
  ]);
  const externalInstallments = {
    activePlanCount: activePlans.length,
    nextWindowCount: nextWindowItems.length,
    nextWindowAmount: engine.obligations.nextIncomeWindowCommitment,
    nextWindowItems,
    futureCount: futureExternalItems.length,
    futureAmount: sumMoney(futureExternalItems.map((i) => i.amount)),
    outstandingAmount,
    runoff: computeExternalInstallmentRunoff(activePlans),
  };

  // ---- futureObligations (decomposição por tipo, Fase 5.3A §13/5.3B §18) ----
  const futureByType = new Map();
  for (const item of engine.obligations.futureItems) {
    const bucket = futureByType.get(item.type) || { model: item.type, count: 0, amount: ZERO };
    bucket.count += 1;
    bucket.amount = addMoney(bucket.amount, item.amount);
    futureByType.set(item.type, bucket);
  }
  const futureObligations = {
    count: engine.obligations.futureItems.length,
    amount: engine.obligations.future,
    decomposition: Array.from(futureByType.values()),
  };

  // ---- contingency ------------------------------------------------------
  const contingency = {
    expectedExposure: engine.contingencyExposure.expected,
    maximumExposure: engine.contingencyExposure.maximum,
    items: engine.contingencyExposure.items,
  };

  // ---- receivables (Fase 5.3B §26 — só leitura, sem CRUD novo) ------------
  const receivableRows = await client.receivable.findMany({ where: { status: "PENDING" }, orderBy: { expectedDate: "asc" } });
  const receivables = {
    total: sumMoney(receivableRows.map((r) => money(r.amount))),
    items: receivableRows,
  };

  // ---- reserves (Fase 5.3B §26) -------------------------------------------
  const reserves = {
    protectedMoney: engine.balances.protectedMoney,
    items: reserveBreakdown,
  };

  // ---- historicalConfidence -------------------------------------------------
  // liveBalanceConfidence: derivado da `confidence` real da âncora
  // (BalanceAdjustment) mais recente de qualquer conta — nunca hardcoded.
  // historicalLedgerCompleteness: constante conceitual documentada nas Fases
  // 5.1D.1/5.1D.2 — o ledger ANTES do snapshot observado nunca foi
  // reconstruído dia-a-dia (decisão explícita: usar o snapshot como âncora em
  // vez de forçar uma reconstrução incompleta). Não é um valor pessoal
  // (nenhum saldo/data/nome), é um estado epistêmico do produto.
  const latestAnchor = await client.balanceAdjustment.findFirst({ orderBy: { occurredAt: "desc" } });
  const historicalConfidence = {
    liveBalanceConfidence: latestAnchor?.confidence ?? "UNKNOWN",
    historicalLedgerCompleteness: "PARTIAL",
  };

  return {
    asOf: now,
    liquidity,
    restricted,
    currentObligations,
    nextIncome,
    nextIncomeCommitment,
    externalInstallments,
    futureObligations,
    contingency,
    receivables,
    reserves,
    historicalConfidence,
  };
}
