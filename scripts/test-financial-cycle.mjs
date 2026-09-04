// Fase 4.0, item 16 — testes puros (sem banco) de datas/ciclo/classificação.
// Mesmo estilo de scripts/test-money.mjs: node + assert puro, roda em qualquer
// ambiente (não precisa de assertTestEnvironment() — não toca banco nenhum).
import assert from "node:assert/strict";
import { getFinancialCycleForDate, getCurrentFinancialCycle, getNextCycleStart, getNextIncomeDate } from "../lib/financialCycle.js";
import { getCardBillPeriod, getCardBillClosesAt, getCardBillDueDate, getCardCycleForDate } from "../lib/cardCycle.js";
import {
  OBLIGATION_CLASS,
  INFLOW_CLASS,
  classifyCardBill,
  classifyBill,
  classifyExternalInstallment,
  classifyConfirmedCommitment,
  classifyContingency,
  classifyReceivable,
} from "../lib/obligationClassifier.js";
import { money } from "../lib/money.js";

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
function iso(d) {
  return d.toISOString().slice(0, 10);
}
function d(s) {
  return new Date(`${s}T00:00:00.000Z`);
}

const SETTINGS = { cycleStartDay: 24 };

console.log("--- Testes puros: financialCycle / cardCycle / obligationClassifier ---\n");

// ============================================================================
// FINANCIAL CYCLE
// ============================================================================
{
  const cycle = getFinancialCycleForDate(d("2026-09-23"), SETTINGS);
  check("23/09/2026 pertence ao ciclo 24/08→23/09", iso(cycle.start) === "2026-08-24" && iso(cycle.end) === "2026-09-23", `${iso(cycle.start)}..${iso(cycle.end)}`);
}
{
  const cycle = getFinancialCycleForDate(d("2026-09-24"), SETTINGS);
  check("24/09/2026 inicia novo ciclo (24/09→23/10)", iso(cycle.start) === "2026-09-24" && iso(cycle.end) === "2026-10-23", `${iso(cycle.start)}..${iso(cycle.end)}`);
}
{
  const next = getNextIncomeDate(SETTINGS, d("2026-09-04"));
  check("04/09/2026 nextIncomeDate = 24/09/2026", iso(next) === "2026-09-24", iso(next));
}
{
  // Decisão de boundary documentada em lib/financialCycle.js: no próprio
  // cycleStartDay, a renda já é "agora" (início do ciclo atual) — a PRÓXIMA
  // (posterior) só vem no mês seguinte.
  const next = getNextIncomeDate(SETTINGS, d("2026-09-24"));
  check("24/09/2026 (exatamente no cycleStartDay) → nextIncomeDate = 24/10/2026 (não o próprio dia)", iso(next) === "2026-10-24", iso(next));
}
{
  const cycle = getCurrentFinancialCycle(SETTINGS, d("2026-12-28"));
  check("virada dezembro/janeiro: 28/12 → ciclo 24/12→23/01", iso(cycle.start) === "2026-12-24" && iso(cycle.end) === "2027-01-23", `${iso(cycle.start)}..${iso(cycle.end)}`);
  const next = getNextIncomeDate(SETTINGS, d("2026-12-28"));
  check("virada dezembro/janeiro: nextIncomeDate = 24/01/2027", iso(next) === "2027-01-24", iso(next));
}
{
  const cycle = getFinancialCycleForDate(d("2026-02-10"), SETTINGS);
  check("fevereiro: 10/02 → ciclo 24/01→23/02", iso(cycle.start) === "2026-01-24" && iso(cycle.end) === "2026-02-23", `${iso(cycle.start)}..${iso(cycle.end)}`);
}
{
  const nextStart = getNextCycleStart(SETTINGS, d("2026-09-04"));
  check("getNextCycleStart === getNextIncomeDate em v1", iso(nextStart) === iso(getNextIncomeDate(SETTINGS, d("2026-09-04"))));
}

// ============================================================================
// CARD CYCLE — closing=4, due=11
// ============================================================================
const CARD = { closingDay: 4, dueDay: 11 };
{
  check("03/09 pertence ao ciclo que fecha em setembro (2026-09)", getCardCycleForDate(CARD, d("2026-09-03")) === "2026-09");
  check("04/09 (o próprio closingDay) ainda pertence ao ciclo de setembro (inclusive)", getCardCycleForDate(CARD, d("2026-09-04")) === "2026-09");
  check("05/09 já pertence ao ciclo que fecha em outubro (2026-10)", getCardCycleForDate(CARD, d("2026-09-05")) === "2026-10");
}
{
  const closesAt = getCardBillClosesAt(CARD, "2026-09");
  const dueAt = getCardBillDueDate(CARD, "2026-09");
  check("cycleReference 2026-09: closesAt = 04/09/2026", iso(closesAt) === "2026-09-04", iso(closesAt));
  check("cycleReference 2026-09: dueAt = 11/09/2026 (MESMO mês — fix do bug original)", iso(dueAt) === "2026-09-11", iso(dueAt));
  const period = getCardBillPeriod(CARD, "2026-09");
  check("período do ciclo 2026-09 = [05/08, 05/09) (05/08 a 04/09 inclusive)", iso(period.start) === "2026-08-05" && iso(period.end) === "2026-09-05", `${iso(period.start)}..${iso(period.end)}`);
}
{
  // virada de mês: dia 1 pertence sempre ao ciclo que fecha no mês corrente (1 <= 4).
  check("virada de mês: 01/09 pertence ao ciclo 2026-09", getCardCycleForDate(CARD, d("2026-09-01")) === "2026-09");
}
{
  // dezembro/janeiro
  check("dezembro/janeiro: 03/01 pertence ao ciclo 2027-01", getCardCycleForDate(CARD, d("2027-01-03")) === "2027-01");
  const dueAt = getCardBillDueDate(CARD, "2026-12");
  check("cycleReference 2026-12: dueAt = 11/12/2026 (sem virar ano indevidamente)", iso(dueAt) === "2026-12-11", iso(dueAt));
}
{
  // mês curto: closingDay=31 clampa pro último dia de fevereiro.
  const shortMonthCard = { closingDay: 31, dueDay: 5 };
  const closesAt = getCardBillClosesAt(shortMonthCard, "2026-02");
  check("closingDay=31 em fevereiro (não-bissexto) clampa pra 28/02", iso(closesAt) === "2026-02-28", iso(closesAt));
  // dueDay(5) < closingDay(31) => vencimento cai no mês SEGUINTE.
  const dueAt = getCardBillDueDate(shortMonthCard, "2026-02");
  check("closingDay=31/dueDay=5: vencimento cai no mês seguinte (05/03)", iso(dueAt) === "2026-03-05", iso(dueAt));
}
{
  // Card sem closingDay (convenção legada, mês calendário) continua intacta.
  const legacyCard = { closingDay: null, dueDay: 11 };
  check("closingDay=null: cycleReference é o mês calendário direto", getCardCycleForDate(legacyCard, d("2026-09-15")) === "2026-09");
  const dueAt = getCardBillDueDate(legacyCard, "2026-08");
  check("closingDay=null: dueAt continua no mês SEGUINTE ao cycleReference (comportamento antigo intacto)", iso(dueAt) === "2026-09-11", iso(dueAt));
}

// ============================================================================
// OBLIGATION CLASSIFIER
// ============================================================================
const NEXT_INCOME = d("2026-09-24");
const NOW = d("2026-09-04");

{
  // CardBill atual (ciclo já começou) com saldo > 0 = incurred.
  const currentBill = { totalAmount: money(500), paidAmount: money(0), cycleMonth: "2026-09" };
  check(
    "CardBill atual (ciclo já iniciado) com saldo > 0 = INCURRED_LIABILITY",
    classifyCardBill(currentBill, CARD, { now: NOW }) === OBLIGATION_CLASS.INCURRED_LIABILITY
  );
}
{
  // CardBill futura (ciclo ainda não começou) = future — não sequestra freeMoney de hoje.
  const futureBill = { totalAmount: money(300), paidAmount: money(0), cycleMonth: "2027-03" };
  check(
    "CardBill de ciclo futuro (ainda não iniciado) = FUTURE_OBLIGATION",
    classifyCardBill(futureBill, CARD, { now: NOW }) === OBLIGATION_CLASS.FUTURE_OBLIGATION
  );
}
{
  const paidBill = { totalAmount: money(500), paidAmount: money(500), cycleMonth: "2026-09" };
  check("CardBill com saldo restante = 0 = SETTLED", classifyCardBill(paidBill, CARD, { now: NOW }) === OBLIGATION_CLASS.SETTLED);
}
{
  const overdueBill = { status: "overdue", dueDate: d("2026-01-01") }; // bem no passado, mesmo assim "atual"
  check("Bill overdue = CURRENT_HORIZON_OBLIGATION sempre", classifyBill(overdueBill, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
}
{
  const billBeforeIncome = { status: "pending", dueDate: d("2026-09-15") };
  check("Bill pending antes da renda = CURRENT_HORIZON_OBLIGATION", classifyBill(billBeforeIncome, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
}
{
  const billAfterIncome = { status: "pending", dueDate: d("2026-10-15") };
  check("Bill pending depois da renda = FUTURE_OBLIGATION", classifyBill(billAfterIncome, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.FUTURE_OBLIGATION);
}
{
  const paidBill = { status: "paid", dueDate: d("2026-08-01") };
  check("Bill paid = SETTLED", classifyBill(paidBill, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.SETTLED);
  const cancelledBill = { status: "cancelled", dueDate: d("2026-08-01") };
  check("Bill cancelled = CANCELLED", classifyBill(cancelledBill, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CANCELLED);
}
{
  const before = { status: "PENDING", dueDate: d("2026-09-15") };
  const after = { status: "PENDING", dueDate: d("2026-10-15") };
  check("ExternalInstallment antes da renda = CURRENT_HORIZON_OBLIGATION", classifyExternalInstallment(before, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
  check("ExternalInstallment depois da renda = FUTURE_OBLIGATION", classifyExternalInstallment(after, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.FUTURE_OBLIGATION);
  const paid = { status: "PAID", dueDate: d("2026-08-01") };
  check("ExternalInstallment paid = SETTLED", classifyExternalInstallment(paid, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.SETTLED);
}
{
  // Commitment tattoo (exemplo do blueprint): dueDate antes da renda = current.
  const tattoo = { status: "CONFIRMED", dueDate: d("2026-09-15") };
  check("Commitment (tattoo) confirmed antes da renda = CURRENT_HORIZON_OBLIGATION", classifyConfirmedCommitment(tattoo, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
}
{
  const decemberUnfunded = { status: "CONFIRMED", dueDate: d("2026-12-01") };
  check("Commitment dezembro, unfunded, depois da renda = FUTURE_OBLIGATION", classifyConfirmedCommitment(decemberUnfunded, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.FUTURE_OBLIGATION);
}
{
  const decemberFunded = { status: "FUNDED", dueDate: d("2026-12-01") };
  check("Commitment dezembro, FUNDED, mesmo depois da renda = CURRENT_HORIZON_OBLIGATION (earmarked agora)", classifyConfirmedCommitment(decemberFunded, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
}
{
  const settled = { status: "SETTLED", dueDate: d("2026-09-01") };
  const cancelled = { status: "CANCELLED", dueDate: d("2026-09-01") };
  check("Commitment SETTLED = SETTLED", classifyConfirmedCommitment(settled, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.SETTLED);
  check("Commitment CANCELLED = CANCELLED", classifyConfirmedCommitment(cancelled, { nextIncomeDate: NEXT_INCOME }) === OBLIGATION_CLASS.CANCELLED);
}
{
  const active = { status: "AWAITING_INFORMATION" };
  const confirmed = { status: "CONFIRMED" };
  const dismissed = { status: "DISMISSED" };
  check("Contingency ativa (AWAITING_INFORMATION) = CONTINGENCY", classifyContingency(active) === OBLIGATION_CLASS.CONTINGENCY);
  check("Contingency ativa (CONFIRMED) = CONTINGENCY", classifyContingency(confirmed) === OBLIGATION_CLASS.CONTINGENCY);
  check("Contingency DISMISSED = CANCELLED", classifyContingency(dismissed) === OBLIGATION_CLASS.CANCELLED);
}
{
  const pending = { status: "PENDING" };
  check("Receivable pending não é caixa (classe própria, não obrigação)", classifyReceivable(pending) === INFLOW_CLASS.PENDING_RECEIVABLE);
  const received = { status: "RECEIVED" };
  check("Receivable received = RECEIVED", classifyReceivable(received) === INFLOW_CLASS.RECEIVED);
}

console.log(`\n${passed} teste(s) passaram.`);
if (process.exitCode) console.log("Alguns testes falharam — ver ❌ acima.");
