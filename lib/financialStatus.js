import { isNegative } from "./money.js";
import { minProjectedCashBefore } from "./financialProjection.js";

// Fase 4.1, item 19 — sem score arbitrário. 4 estados determinísticos, cada um
// com regra explícita e testável. `reasons` são CÓDIGOS estruturados (+
// metadata), nunca só uma frase hardcoded — quem consome decide como
// apresentar.
export const FINANCIAL_STATUS = Object.freeze({
  TRANQUILO: "TRANQUILO",
  ATENCAO: "ATENCAO",
  APERTADO: "APERTADO",
  CRITICO: "CRITICO",
});

export const STATUS_REASON = Object.freeze({
  BASE_CASH_NEGATIVE_BEFORE_INCOME: "BASE_CASH_NEGATIVE_BEFORE_INCOME",
  FREE_MONEY_NEGATIVE: "FREE_MONEY_NEGATIVE",
  EXPECTED_SCENARIO_NEGATIVE: "EXPECTED_SCENARIO_NEGATIVE",
  STRESS_SCENARIO_NEGATIVE: "STRESS_SCENARIO_NEGATIVE",
  EXPECTED_INCOME_OVERDUE: "EXPECTED_INCOME_OVERDUE",
  UNFUNDED_CONFIRMED_COMMITMENT: "UNFUNDED_CONFIRMED_COMMITMENT",
});

// computeFinancialStatus({ freeMoney, nextIncomeDate, currentObligationHorizonEnd,
//   nextIncomeStatus, baseProjection, expectedProjection, stressProjection,
//   unfundedConfirmedCommitments })
//
// Fase 4.1.1 — `nextIncomeDate` (a data REAL/esperada, nunca alterada) e
// `currentObligationHorizonEnd` (o horizonte EFETIVO de classificação — igual a
// nextIncomeDate exceto quando a renda está OVERDUE, caso em que vira
// max(hoje, nextIncomeDate); ver lib/financialEngine.js:
// computeCurrentObligationHorizonEnd) são conceitos DIFERENTES e usados em
// lugares diferentes aqui:
//   - o corte de CRITICO (minProjectedCashBefore) usa o horizonte EFETIVO —
//     senão, com a renda atrasada, o corte ficaria travado numa data já
//     passada e o CRITICO deixaria de pegar obrigações que já venceram depois
//     dela.
//   - o motivo EXPECTED_INCOME_OVERDUE reporta a data REAL esperada
//     (nextIncomeDate) na metadata — nunca a data efetiva, que esconderia o
//     atraso (item 5, explícito: "Não esconder o atraso usando a data efetiva
//     do horizonte").
//
// IMPORTANTE (item 19, explícito): nextIncome.committedPercent NÃO é usado
// aqui — não existe threshold configurado em AppSettings pra isso ainda, e a
// instrução é clara: não introduzir um limiar arbitrário nesta primeira
// versão. Quando existir um threshold real em AppSettings, isso pode virar
// mais uma condição de ATENCAO.
export function computeFinancialStatus({
  freeMoney,
  nextIncomeDate,
  currentObligationHorizonEnd = nextIncomeDate,
  nextIncomeStatus,
  baseProjection,
  expectedProjection,
  stressProjection,
  unfundedConfirmedCommitments,
}) {
  const reasons = [];

  // CRITICO — cenário BASE fica negativo em algum ponto antes do horizonte
  // EFETIVO (não a data crua — ver comentário acima).
  const minBaseCashBeforeIncome = minProjectedCashBefore(baseProjection, currentObligationHorizonEnd);
  if (isNegative(minBaseCashBeforeIncome)) {
    return {
      status: FINANCIAL_STATUS.CRITICO,
      reasons: [
        {
          code: STATUS_REASON.BASE_CASH_NEGATIVE_BEFORE_INCOME,
          message: "O caixa físico projetado (cenário base) fica negativo antes da próxima renda esperada.",
          metadata: { minProjectedCash: minBaseCashBeforeIncome, nextIncomeDate, currentObligationHorizonEnd },
        },
      ],
    };
  }

  // APERTADO — freeMoney negativo, mas o caixa físico não fica negativo antes
  // da renda (as obrigações cabem fisicamente, mas consumiriam dinheiro
  // protegido/reservado pra cobrir).
  if (isNegative(freeMoney)) {
    return {
      status: FINANCIAL_STATUS.APERTADO,
      reasons: [
        {
          code: STATUS_REASON.FREE_MONEY_NEGATIVE,
          message: "freeMoney está negativo — as obrigações cabem no caixa físico, mas exigiriam consumir dinheiro protegido/reservado.",
          metadata: { freeMoney },
        },
      ],
    };
  }

  // ATENCAO — freeMoney >= 0, mas existe condição concreta de atenção.
  if (expectedProjection && isNegative(expectedProjection.checkpoints.day90.projectedCash)) {
    reasons.push({
      code: STATUS_REASON.EXPECTED_SCENARIO_NEGATIVE,
      message: "O cenário esperado (com contingências prováveis) fica negativo dentro do horizonte projetado.",
      metadata: { projectedCash: expectedProjection.checkpoints.day90.projectedCash },
    });
  }
  if (stressProjection && isNegative(stressProjection.checkpoints.day90.projectedCash)) {
    reasons.push({
      code: STATUS_REASON.STRESS_SCENARIO_NEGATIVE,
      message: "O cenário de stress (pior caso das contingências) fica negativo dentro do horizonte projetado.",
      metadata: { projectedCash: stressProjection.checkpoints.day90.projectedCash },
    });
  }
  if (nextIncomeStatus === "OVERDUE") {
    reasons.push({
      code: STATUS_REASON.EXPECTED_INCOME_OVERDUE,
      message: "A renda esperada já deveria ter chegado e ainda não foi registrada.",
      metadata: { nextIncomeDate },
    });
  }
  if (unfundedConfirmedCommitments && unfundedConfirmedCommitments.count > 0) {
    reasons.push({
      code: STATUS_REASON.UNFUNDED_CONFIRMED_COMMITMENT,
      message: "Existe(m) compromisso(s) confirmado(s) dentro do horizonte atual sem origem de funding definida.",
      metadata: { count: unfundedConfirmedCommitments.count, amount: unfundedConfirmedCommitments.amount },
    });
  }

  if (reasons.length > 0) {
    return { status: FINANCIAL_STATUS.ATENCAO, reasons };
  }

  return { status: FINANCIAL_STATUS.TRANQUILO, reasons: [] };
}
