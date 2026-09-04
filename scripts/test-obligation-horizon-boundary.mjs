// Fase 4.1.1 — testes puros (sem banco) das duas correções de boundary:
//   1. intervalo do nextIncomeCommitment: [nextIncomeDate, followingIncomeDate).
//   2. currentObligationHorizonEnd para renda OVERDUE (separado de expectedDate).
import { isWithinNextIncomeCommitmentWindow } from "../lib/freeMoney.js";
import { computeCurrentObligationHorizonEnd } from "../lib/financialEngine.js";
import { classifyBill, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";

let passed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
    process.exitCode = 1;
  }
}
function d(s) {
  return new Date(`${s}T00:00:00.000Z`);
}
function iso(date) {
  return date.toISOString().slice(0, 10);
}

console.log("--- Testes puros: boundaries de horizonte (Fase 4.1.1) ---\n");

// ============================================================================
// Item 1 — [nextIncomeDate, followingIncomeDate): next=24/09, following=24/10.
// ============================================================================
{
  const start = d("2026-09-24");
  const end = d("2026-10-24");

  check("23/09 → NÃO entra (antes do início)", !isWithinNextIncomeCommitmentWindow(d("2026-09-23"), start, end));
  check("24/09 → entra (início inclusive)", isWithinNextIncomeCommitmentWindow(d("2026-09-24"), start, end));
  check("25/09 → entra", isWithinNextIncomeCommitmentWindow(d("2026-09-25"), start, end));
  check("23/10 → entra (último dia antes do fim)", isWithinNextIncomeCommitmentWindow(d("2026-10-23"), start, end));
  check("24/10 → NÃO entra (fim exclusive — pertence ao ciclo seguinte)", !isWithinNextIncomeCommitmentWindow(d("2026-10-24"), start, end));
  check("25/10 → NÃO entra", !isWithinNextIncomeCommitmentWindow(d("2026-10-25"), start, end));
}

// ============================================================================
// Item 2 — computeCurrentObligationHorizonEnd: separa expectedDate de
// currentObligationHorizonEnd. expectedDate NUNCA é alterada.
// ============================================================================
{
  const upcoming = { status: "UPCOMING", expectedDate: d("2026-09-24") };
  const horizon = computeCurrentObligationHorizonEnd(upcoming, d("2026-09-04"));
  check("status != OVERDUE → currentObligationHorizonEnd = expectedDate (sem mudança)", iso(horizon) === "2026-09-24", iso(horizon));
}
{
  const dueToday = { status: "DUE_TODAY", expectedDate: d("2026-09-24") };
  const horizon = computeCurrentObligationHorizonEnd(dueToday, d("2026-09-24"));
  check("DUE_TODAY → currentObligationHorizonEnd = expectedDate", iso(horizon) === "2026-09-24", iso(horizon));
}
{
  // Renda esperada 24/09, hoje 25/09, ainda OVERDUE.
  const overdue = { status: "OVERDUE", expectedDate: d("2026-09-24") };
  const now = d("2026-09-25");
  const horizon = computeCurrentObligationHorizonEnd(overdue, now);
  check("OVERDUE (hoje=25/09, esperado=24/09) → currentObligationHorizonEnd = hoje (25/09), NUNCA 24/09", iso(horizon) === "2026-09-25", iso(horizon));
  check("OVERDUE: expectedDate do input NÃO é mutada (continua 24/09)", iso(overdue.expectedDate) === "2026-09-24");
}
{
  // No dia seguinte, ainda sem Income — o horizonte acompanha o tempo.
  const overdue = { status: "OVERDUE", expectedDate: d("2026-09-24") };
  const horizon26 = computeCurrentObligationHorizonEnd(overdue, d("2026-09-26"));
  check("OVERDUE no dia 26/09 (ainda sem Income) → horizonte acompanha, vira 26/09", iso(horizon26) === "2026-09-26", iso(horizon26));
}

// ============================================================================
// Item 4 — cenário completo do pedido: obligation classifier usando o
// horizonte EFETIVO (não a data crua) enquanto a renda está OVERDUE.
// Hoje = 25/09, income esperado = 24/09 (OVERDUE).
// ============================================================================
{
  const overdue = { status: "OVERDUE", expectedDate: d("2026-09-24") };
  const now25 = d("2026-09-25");
  const horizon25 = computeCurrentObligationHorizonEnd(overdue, now25); // = 25/09

  const bill23 = { status: "pending", dueDate: d("2026-09-23") };
  const bill24 = { status: "pending", dueDate: d("2026-09-24") };
  const bill25 = { status: "pending", dueDate: d("2026-09-25") };
  const bill26 = { status: "pending", dueDate: d("2026-09-26") };

  check("OVERDUE, hoje=25/09: obrigação 23/09 → CURRENT_HORIZON", classifyBill(bill23, { nextIncomeDate: horizon25 }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
  check("OVERDUE, hoje=25/09: obrigação 24/09 → CURRENT_HORIZON", classifyBill(bill24, { nextIncomeDate: horizon25 }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
  check("OVERDUE, hoje=25/09: obrigação 25/09 → CURRENT_HORIZON", classifyBill(bill25, { nextIncomeDate: horizon25 }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
  check(
    "OVERDUE, hoje=25/09: obrigação 26/09 → FUTURE_OBLIGATION neste instante (ainda não chegou)",
    classifyBill(bill26, { nextIncomeDate: horizon25 }) === OBLIGATION_CLASS.FUTURE_OBLIGATION
  );

  // Um dia depois, ainda sem Income — o MESMO bill26 vira CURRENT_HORIZON
  // porque o horizonte efetivo acompanhou o tempo (26/09), sem inventar
  // nenhuma nova data de renda.
  const now26 = d("2026-09-26");
  const horizon26 = computeCurrentObligationHorizonEnd(overdue, now26);
  check(
    "no dia 26/09, ainda sem Income: obrigação 26/09 → agora CURRENT_HORIZON (horizonte acompanhou o tempo)",
    classifyBill(bill26, { nextIncomeDate: horizon26 }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION
  );

  // E a data esperada da renda (pra relatório/metadata) continua 24/09 — nunca
  // "avançada" silenciosamente pro dia de hoje.
  check("expectedDate reportada continua 24/09 mesmo depois de dias OVERDUE", iso(overdue.expectedDate) === "2026-09-24");
}

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.log("Alguns testes falharam — ver ❌ acima.");
