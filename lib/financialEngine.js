import { prisma } from "./prisma.js";
import { listAccountsWithBalances } from "./accounts.js";
import { computeUnrestrictedCash, unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { sumMoney } from "./money.js";
import { startOfDay } from "./recurringCycles.js";
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

// Fase 4.1.1, item 2 — separa expectedIncomeDate (a data REAL/esperada da
// próxima renda, informada por lib/incomeHorizon.js e NUNCA alterada por esta
// função) de currentObligationHorizonEnd (o horizonte EFETIVO usado só pra
// classificar obrigações como atuais vs futuras).
//
// Problema que isto resolve: se a renda esperada de 24/09 ainda não foi
// registrada e hoje já é 25/09 (status OVERDUE), classificar obrigações usando
// nextIncomeDate=24/09 faria uma obrigação de 25/09 cair em FUTURE_OBLIGATION —
// errado, porque 24/09 já passou e a obrigação de amanhã claramente precisa
// ser coberta ANTES da renda atrasada finalmente chegar. A correção NÃO é
// inventar uma nova data de renda (isso seria fingir que o salário já tem
// previsão pra depois de amanhã, o que não sabemos) — é só reconhecer que,
// enquanto a renda estiver atrasada, o horizonte de "o que é urgente agora"
// tem que acompanhar o tempo real, não ficar preso numa data que já passou.
//
//   status != OVERDUE -> currentObligationHorizonEnd = expectedDate (sem mudança)
//   status == OVERDUE -> currentObligationHorizonEnd = max(hoje, expectedDate)
//                         (na prática sempre = hoje, já que OVERDUE implica
//                         expectedDate < hoje por definição — ver
//                         lib/incomeHorizon.js)
//
// Responsabilidades (item 3): incomeHorizon só informa expectedDate/status/
// recurringRule/amount/isFallback — nunca deriva horizonte de classificação.
// obligationClassifier só recebe uma data de corte pronta — nunca consulta
// Income/RecurringRule sozinho. Esta derivação vive aqui, no financialEngine,
// que é quem conecta as duas pontas.
export function computeCurrentObligationHorizonEnd(nextIncome, now = new Date()) {
  if (nextIncome.status !== "OVERDUE") return nextIncome.expectedDate;
  const today = startOfDay(now);
  return nextIncome.expectedDate > today ? nextIncome.expectedDate : today;
}

// ============================================================================
// Fase 4.1, item 22 — fonte central única. Monta o resumo completo do motor
// financeiro V2. Decimal-first do início ao fim; NENHUMA serialização interna
// (isso é responsabilidade de quem consome — ex: uma futura rota de API
// chamaria deepSerializeMoney() no resultado, igual ao resto do app).
//
// Fase 5.3B — esta função agora É USADA pelo produto (lib/productFinancialSnapshot.js,
// consumido por app/api/dashboard/route.js). A ressalva antiga acima (Fase 4.1) foi
// resolvida pelas Fases 5.1D-5.2D: os dados reais foram reconciliados (snapshot
// observado do Itaú, obrigações reais aplicadas) — ver relatório da Fase 5.3A.
//
// `client`/`now` opcionais (mesmo padrão aditivo já usado nos helpers que esta
// função compõe) — permitem injeção de `{ client: tx }` numa transação futura
// e data determinística em teste. Nenhum call-site existente muda de
// comportamento.
export async function buildFinancialEngineSummary({ now = new Date(), horizonDays = 90, client = prisma } = {}) {
  const [accounts, settings] = await Promise.all([listAccountsWithBalances({ client }), getAppSettings({ client })]);
  const unrestrictedIds = unrestrictedCashAccountIds(accounts);

  const totalBalances = sumMoney(accounts.map((a) => a.balance));
  const unrestrictedCash = computeUnrestrictedCash(accounts);
  const restrictedBalance = sumMoney(accounts.filter((a) => !unrestrictedIds.has(a.id)).map((a) => a.balance));

  // Item 11 — SEMPRE resolveNextExpectedIncomeFromDb(), nunca getNextCycleStart
  // como substituto.
  const nextIncome = await getNextIncomeInfo({ now, client });
  const nextIncomeDate = nextIncome.expectedDate; // data REAL — nunca alterada, sempre reportada como está.
  // Horizonte EFETIVO de classificação (Fase 4.1.1, item 2) — só isto vai pro
  // obligationClassifier via getObligationsBreakdown. nextIncomeDate crua
  // continua sendo o que é reportado em `nextIncome`/no motivo OVERDUE.
  const currentObligationHorizonEnd = computeCurrentObligationHorizonEnd(nextIncome, now);

  const [protectedMoney, obligations, contingencyExposure] = await Promise.all([
    getProtectedMoney({ unrestrictedAccountIds: unrestrictedIds, client }),
    getObligationsBreakdown({ now, nextIncomeDate: currentObligationHorizonEnd, client }),
    getContingencyExposure({ client }),
  ]);

  const incurred = obligations[OBLIGATION_CLASS.INCURRED_LIABILITY];
  const currentHorizon = obligations[OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION];
  const nextIncomeWindow = obligations[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT];
  const future = obligations[OBLIGATION_CLASS.FUTURE_OBLIGATION];
  const unfundedConfirmedCommitments = getUnfundedConfirmedCommitments(currentHorizon.items);

  const freeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash,
    protectedMoney,
    incurredLiabilities: incurred.total,
    currentHorizonObligations: currentHorizon.total,
  });
  const safeToSpendInfo = computeSafeToSpend(freeMoney, settings.safetyMarginPercent);

  const nextIncomeCommitment = await getNextIncomeCommitment({ nextIncome, client });

  // financialProjection.js ainda não aceita `client` (só `now`/`accounts`) —
  // limitação conhecida e documentada, não escondida: ver nota em
  // lib/productFinancialSnapshot.js. Não é necessário pra esta fase (nenhuma
  // validação dentro de transação depende da projeção), então não foi
  // retrofitada aqui pra não ampliar o escopo desta mudança.
  const [base, expected, stress] = await Promise.all([
    buildBaseProjection({ horizonDays, now, accounts }),
    buildExpectedProjection({ horizonDays, now, accounts }),
    buildStressProjection({ horizonDays, now, accounts }),
  ]);

  const status = computeFinancialStatus({
    freeMoney,
    nextIncomeDate,
    currentObligationHorizonEnd,
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
      nextIncomeWindowCommitment: nextIncomeWindow.total,
      nextIncomeWindowCommitmentItems: nextIncomeWindow.items,
      future: future.total,
      futureItems: future.items,
      unfundedConfirmedCommitments,
    },

    freeMoney,
    safeToSpend: safeToSpendInfo.safeToSpend,
    safetyReserve: safeToSpendInfo.safetyReserve,
    safetyMarginPercent: settings.safetyMarginPercent,

    nextIncome,
    currentObligationHorizonEnd,
    nextIncomeCommitment,
    contingencyExposure,

    status,

    projections: { base, expected, stress },
  };
}
