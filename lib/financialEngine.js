import { listAccountsWithBalances } from "./accounts.js";
import { computeUnrestrictedCash, unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { sumMoney } from "./money.js";
import { getAppSettings } from "./settings.js";
import { getNextIncomeInfo } from "./incomeHorizon.js";
import {
  getProtectedMoney,
  getObligationsBreakdown,
  getUnfundedConfirmedCommitments,
  getContingencyExposure,
  computeFreeMoneyFromBreakdown,
  computeSafeToSpend,
  getNextIncomeCommitment,
} from "./freeMoney.js";
import { buildBaseProjection, buildExpectedProjection, buildStressProjection } from "./financialProjection.js";
import { computeFinancialStatus } from "./financialStatus.js";
import { OBLIGATION_CLASS } from "./obligationClassifier.js";

// ============================================================================
// Fase 4.1, item 22 — fonte central única. Monta o resumo completo do motor
// financeiro V2. Decimal-first do início ao fim; NENHUMA serialização interna
// (isso é responsabilidade de quem consome — ex: uma futura rota de API
// chamaria deepSerializeMoney() no resultado, igual ao resto do app).
//
// IMPORTANTE (item 23): esta função NÃO é usada pelo dashboard/Home ainda —
// isso é deliberado. Os dados reais não foram reconciliados; expor isto como
// se fosse correto pro usuário final é prematuro. Uso previsto nesta fase:
// scripts de teste/diagnóstico, nunca uma rota que o usuário visita.
export async function buildFinancialEngineSummary({ now = new Date(), horizonDays = 90 } = {}) {
  const [accounts, settings] = await Promise.all([listAccountsWithBalances(), getAppSettings()]);
  const unrestrictedIds = unrestrictedCashAccountIds(accounts);

  const totalBalances = sumMoney(accounts.map((a) => a.balance));
  const unrestrictedCash = computeUnrestrictedCash(accounts);
  const restrictedBalance = sumMoney(accounts.filter((a) => !unrestrictedIds.has(a.id)).map((a) => a.balance));

  // Item 11 — SEMPRE resolveNextExpectedIncomeFromDb(), nunca getNextCycleStart
  // como substituto.
  const nextIncome = await getNextIncomeInfo({ now });
  const nextIncomeDate = nextIncome.expectedDate;

  const [protectedMoney, obligations, contingencyExposure] = await Promise.all([
    getProtectedMoney({ unrestrictedAccountIds: unrestrictedIds }),
    getObligationsBreakdown({ now, nextIncomeDate }),
    getContingencyExposure(),
  ]);

  const incurred = obligations[OBLIGATION_CLASS.INCURRED_LIABILITY];
  const currentHorizon = obligations[OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION];
  const future = obligations[OBLIGATION_CLASS.FUTURE_OBLIGATION];
  const unfundedConfirmedCommitments = getUnfundedConfirmedCommitments(currentHorizon.items);

  const freeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash,
    protectedMoney,
    incurredLiabilities: incurred.total,
    currentHorizonObligations: currentHorizon.total,
  });
  const safeToSpendInfo = computeSafeToSpend(freeMoney, settings.safetyMarginPercent);

  const nextIncomeCommitment = await getNextIncomeCommitment({ nextIncome });

  const [base, expected, stress] = await Promise.all([
    buildBaseProjection({ horizonDays, now, accounts }),
    buildExpectedProjection({ horizonDays, now, accounts }),
    buildStressProjection({ horizonDays, now, accounts }),
  ]);

  const status = computeFinancialStatus({
    freeMoney,
    nextIncomeDate,
    nextIncomeStatus: nextIncome.status,
    baseProjection: base,
    expectedProjection: expected,
    stressProjection: stress,
    unfundedConfirmedCommitments,
  });

  return {
    asOf: now,

    balances: {
      totalBalances,
      unrestrictedCash,
      restrictedBalance,
      protectedMoney,
    },

    obligations: {
      incurredLiabilities: incurred.total,
      incurredLiabilitiesItems: incurred.items,
      currentHorizon: currentHorizon.total,
      currentHorizonItems: currentHorizon.items,
      future: future.total,
      futureItems: future.items,
      unfundedConfirmedCommitments,
    },

    freeMoney,
    safeToSpend: safeToSpendInfo.safeToSpend,
    safetyReserve: safeToSpendInfo.safetyReserve,
    safetyMarginPercent: settings.safetyMarginPercent,

    nextIncome,
    nextIncomeCommitment,
    contingencyExposure,

    status,

    projections: { base, expected, stress },
  };
}
