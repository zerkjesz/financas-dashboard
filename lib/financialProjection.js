import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney, multiplyMoney } from "./money.js";
import { listAccountsWithBalances } from "./accounts.js";
import { computeUnrestrictedCash, unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { getProtectedMoney, getContingencyExposure } from "./freeMoney.js";
import { getRealizedOccurrences } from "./incomeHorizon.js";
import { occurrencesBetween, startOfDay } from "./recurringCycles.js";
import { listCardBillsView } from "./cardBillCalculator.js";
import { listExternalInstallmentPlans, computeExternalInstallmentRunoff } from "./externalInstallments.js";

// ============================================================================
// Fase 4.1, itens 12-16 — motor de projeção V2 (base/expected/stress). Coexiste
// com lib/cashFlowProjection.js (V1, ainda usado pelo dashboard ao vivo — Fase
// 4.1 explicitamente NÃO liga isto na Home ainda, ver item 23).
//
// Princípio inegociável (item 12): STARTING CASH = unrestrictedCash REAL atual.
// NUNCA freeMoney, NUNCA safeToSpend, NUNCA "unrestrictedCash - obligations"
// antecipadamente — cada evento é aplicado na sua própria data, uma única vez.
// Reserve NUNCA reduz a projeção física de caixa (é alocação virtual) — por
// isso protectedMoney é calculado UMA vez e fica CONSTANTE no cenário inteiro
// (item 16) — não inventamos nenhum ReserveMovement futuro que não exista.
// ============================================================================

export const PROJECTION_SCENARIO = Object.freeze({ BASE: "BASE", EXPECTED: "EXPECTED", STRESS: "STRESS" });

const DEFAULT_HORIZON_DAYS = 90;
const CHECKPOINTS = [
  { key: "today", days: 0 },
  { key: "day30", days: 30 },
  { key: "day60", days: 60 },
  { key: "day90", days: 90 },
];

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// ---- Inflows: renda recorrente irrestrita, não realizada -------------------
//
// Busca ocorrências desde ~35 dias antes de `now` (o suficiente pra pegar uma
// ocorrência do mês anterior ainda não realizada) até horizonEnd. Ocorrências
// JÁ realizadas (via Income.recurringOccurrenceDate, Fase 4.0.2) nunca entram
// de novo (item 17). Ocorrências com data < hoje e NÃO realizadas são OVERDUE —
// aparecem separadamente (`overdueExpectedIncome`), NUNCA injetadas na
// timeline com uma data passada (isso deixaria a trajetória de caixa
// retroativamente diferente do que já aconteceu de verdade).
async function collectIncomeEvents({ now, horizonEnd, accounts }) {
  const today = startOfDay(now);
  const rules = await prisma.recurringRule.findMany({ where: { kind: "income", isActive: true } });
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const unrestrictedRules = rules.filter((r) => {
    if (r.accountId == null) return true; // sem sinal de restrição conhecido — mesma política de lib/incomeHorizon.js
    const account = accountsById.get(r.accountId);
    return !account || account.type !== "food_voucher";
  });

  const realized = await getRealizedOccurrences(unrestrictedRules.map((r) => r.id));
  const realizedSet = new Set(realized.map((r) => `${r.recurringRuleId}:${startOfDay(new Date(r.recurringOccurrenceDate)).toISOString().slice(0, 10)}`));

  const events = [];
  const overdueExpectedIncome = [];
  const lookbackStart = addDays(today, -35);

  for (const rule of unrestrictedRules) {
    if (rule.amount == null) continue; // sem valor conhecido, não dá pra projetar uma quantia — omitido de propósito, não um zero inventado.
    const occurrences = occurrencesBetween(rule.dayOfMonth, lookbackStart, horizonEnd);
    for (const occurrenceDate of occurrences) {
      const key = `${rule.id}:${occurrenceDate.toISOString().slice(0, 10)}`;
      if (realizedSet.has(key)) continue;
      if (occurrenceDate < today) {
        overdueExpectedIncome.push({ recurringRuleId: rule.id, name: rule.name, date: occurrenceDate, amount: money(rule.amount) });
        continue;
      }
      events.push({ date: occurrenceDate, label: rule.name, kind: "recurring_income", amount: money(rule.amount) });
    }
  }
  return { events, overdueExpectedIncome };
}

// ---- Outflows confirmados: CardBill/Bill/ExternalInstallment/ConfirmedCommitment
//
// CardBill via listCardBillsView (Fase 4.1.3) — não prisma.cardBill.findMany
// direto: combina persisted + PROJECTED em memória, então a projeção mostra
// faturas futuras (Out/Nov/Dez...) mesmo que NENHUMA delas tenha sido
// materializada ainda (item 8/10) — nunca escreve nada aqui.
async function collectOutflowEvents({ now, horizonEnd }) {
  const events = [];

  const cards = await prisma.card.findMany();
  for (const card of cards) {
    const bills = await listCardBillsView(card.id);
    for (const bill of bills) {
      if (bill.dueAt < now || bill.dueAt > horizonEnd) continue;
      const remaining = subtractMoney(money(bill.totalAmount), money(bill.paidAmount ?? 0));
      if (!remaining.gt(0)) continue; // já quitada — não entra na projeção de saída.
      events.push({ date: bill.dueAt, label: `Fatura ${card.name} (${bill.cycleMonth})`, kind: "card_bill", amount: multiplyMoney(remaining, -1) });
    }
  }

  const bills = await prisma.bill.findMany({ where: { status: { in: ["pending", "overdue"] }, dueDate: { gte: now, lte: horizonEnd } } });
  for (const bill of bills) {
    events.push({ date: bill.dueDate, label: bill.description, kind: "bill", amount: multiplyMoney(money(bill.amount), -1) });
  }

  const externalInstallments = await prisma.externalInstallment.findMany({
    where: { status: "PENDING", dueDate: { gte: now, lte: horizonEnd } },
    include: { plan: true },
  });
  for (const installment of externalInstallments) {
    events.push({
      date: installment.dueDate,
      label: `${installment.plan.description} (${installment.number}/${installment.plan.installmentCount})`,
      kind: "external_installment",
      amount: multiplyMoney(money(installment.amount), -1),
    });
  }

  const commitments = await prisma.confirmedCommitment.findMany({
    where: { status: { in: ["CONFIRMED", "FUNDED"] }, dueDate: { gte: now, lte: horizonEnd } },
  });
  for (const commitment of commitments) {
    events.push({ date: commitment.dueDate, label: commitment.description, kind: "confirmed_commitment", amount: multiplyMoney(money(commitment.amount), -1) });
  }

  return events;
}

// ---- ExternalInstallment com dueTiming=AFTER_NEXT_INCOME (Fase 5.3B, item 16)
//
// A query em collectOutflowEvents acima só pega ExternalInstallment com
// dueDate PREENCHIDA (CALENDAR_DATE) — uma parcela AFTER_NEXT_INCOME tem
// dueDate=null e por isso NUNCA batia no filtro `gte/lte`, então simplesmente
// desaparecia da projeção inteira (achado da Fase 5.3A §17, opção B:
// "ignora essas obligations"). Corrigido aqui SEM inventar nenhuma data:
// reaproveita a MESMA sequência de runoff canônica que /parcelas exibe
// (lib/externalInstallments.js:computeExternalInstallmentRunoff — offset 0 =
// pacote da próxima renda, offset 1 = da seguinte, etc.) e mapeia cada offset
// contra a ocorrência de renda REAL já projetada nesta mesma timeline
// (`incomeOccurrenceDates`, vinda de collectIncomeEvents — nunca uma data
// inventada). Uma parcela de cada plano por ocorrência, nunca todas na mesma
// janela — a mesma garantia que classifyExternalInstallment já dá pro
// NEXT_INCOME_WINDOW_COMMITMENT (Fase 5.2B), só estendida pra várias
// ocorrências futuras em vez de só a próxima. Se o horizonte da projeção
// acabar antes de todos os offsets serem cobertos, os que sobram só ficam
// FORA da janela desta projeção (nunca desaparecem do domínio — o runoff
// completo continua em /parcelas).
async function collectAfterNextIncomeInstallmentEvents({ incomeOccurrenceDates }) {
  const activePlans = await listExternalInstallmentPlans({ status: "ACTIVE" });
  const plans = activePlans.filter((p) => p.dueTiming === "AFTER_NEXT_INCOME");
  if (plans.length === 0) return [];

  const runoff = computeExternalInstallmentRunoff(plans);
  const events = [];
  for (const row of runoff) {
    if (row.activePlanCount === 0) break; // linha terminal (0) não é um evento de saída.
    const occurrenceDate = incomeOccurrenceDates[row.offset];
    if (!occurrenceDate) break; // sem ocorrência de renda projetada pra este offset dentro do horizonte desta projeção.
    events.push({
      date: occurrenceDate,
      label: row.offset === 0 ? "Parcelas externas (próxima renda)" : `Parcelas externas (+${row.offset} renda(s))`,
      kind: "external_installment_window",
      amount: multiplyMoney(row.monthTotal, -1),
    });
  }
  return events;
}

// ---- Contingency (só EXPECTED/STRESS — item 14/15) --------------------------
//
// Se expectedDate for NULL: comportamento conservador e documentado (item 14)
// — NUNCA inventa uma data. A exposição é reportada separadamente
// (`contingencyUndated`) e sempre entra no total de riskExposure, mas nunca é
// inserida na timeline de datas.
async function collectContingencyEvents({ now, horizonEnd, amountField }) {
  const contingencies = await prisma.contingency.findMany({ where: { status: { not: "DISMISSED" } } });
  const events = [];
  const undated = [];
  for (const contingency of contingencies) {
    const rawAmount = amountField === "expectedAmount" ? contingency.expectedAmount : contingency.maxAmount;
    if (rawAmount == null) continue; // EXPECTED: contingência sem expectedAmount não entra nesse cenário.
    const amount = money(rawAmount);
    if (contingency.expectedDate == null) {
      undated.push({ id: contingency.id, description: contingency.description, amount });
      continue;
    }
    if (contingency.expectedDate < now || contingency.expectedDate > horizonEnd) continue; // fora da janela desta projeção.
    events.push({ date: contingency.expectedDate, label: contingency.description, kind: "contingency", amount: multiplyMoney(amount, -1) });
  }
  return { events, undated };
}

function buildTimeline({ startingCash, events }) {
  const sorted = [...events].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = startingCash;
  return sorted.map((event) => {
    running = addMoney(running, event.amount);
    return { ...event, balanceAfter: running };
  });
}

function cashAtCheckpoint(timeline, startingCash, checkpointDate) {
  let result = startingCash;
  for (const event of timeline) {
    if (event.date > checkpointDate) break;
    result = event.balanceAfter;
  }
  return result;
}

// buildProjectionScenario("BASE" | "EXPECTED" | "STRESS", { horizonDays, now, accounts })
export async function buildProjectionScenario(scenario, { horizonDays = DEFAULT_HORIZON_DAYS, now = new Date(), accounts: accountsIn } = {}) {
  if (!PROJECTION_SCENARIO[scenario]) throw new Error(`scenario inválido: ${JSON.stringify(scenario)}`);

  const accounts = accountsIn || (await listAccountsWithBalances());
  const unrestrictedIds = unrestrictedCashAccountIds(accounts);
  const startingCash = computeUnrestrictedCash(accounts);
  // Constante no cenário inteiro — nenhum ReserveMovement futuro é inventado
  // (item 16); só o que já está persistido HOJE.
  const protectedMoney = await getProtectedMoney({ unrestrictedAccountIds: unrestrictedIds });

  const horizonEnd = addDays(now, horizonDays);

  const [{ events: incomeEvents, overdueExpectedIncome }, outflowEvents] = await Promise.all([
    collectIncomeEvents({ now, horizonEnd, accounts }),
    collectOutflowEvents({ now, horizonEnd }),
  ]);

  // Item 16 — datas REAIS de ocorrência de renda já projetadas acima (nunca
  // inventadas aqui), ordenadas cronologicamente (pode vir de mais de uma
  // regra de renda irrestrita, então precisa ordenar de novo por segurança).
  const incomeOccurrenceDates = incomeEvents.map((e) => e.date).sort((a, b) => a.getTime() - b.getTime());
  const afterNextIncomeInstallmentEvents = await collectAfterNextIncomeInstallmentEvents({ incomeOccurrenceDates });

  let events = [...incomeEvents, ...outflowEvents, ...afterNextIncomeInstallmentEvents];
  let contingencyUndated = [];
  let riskExposure = null;

  if (scenario !== PROJECTION_SCENARIO.BASE) {
    const amountField = scenario === PROJECTION_SCENARIO.EXPECTED ? "expectedAmount" : "maxAmount";
    const { events: contingencyEvents, undated } = await collectContingencyEvents({ now, horizonEnd, amountField });
    events = [...events, ...contingencyEvents];
    contingencyUndated = undated;
    // Mesma fonte central de lib/freeMoney.js:getContingencyExposure() — nunca
    // recomputa a mesma soma de outro jeito (item 15: expectedRiskExposure/
    // maxRiskExposure).
    const exposure = await getContingencyExposure();
    riskExposure = { expectedRiskExposure: exposure.expected, maxRiskExposure: exposure.maximum };
  }

  const timeline = buildTimeline({ startingCash, events });

  const checkpoints = {};
  for (const { key, days } of CHECKPOINTS) {
    const checkpointDate = addDays(now, days);
    const projectedCash = cashAtCheckpoint(timeline, startingCash, checkpointDate);
    checkpoints[key] = {
      date: checkpointDate,
      projectedCash,
      protectedMoney,
      projectedAvailableAfterProtected: subtractMoney(projectedCash, protectedMoney),
    };
  }

  return {
    scenario,
    horizonDays,
    startingCash,
    protectedMoney,
    timeline,
    checkpoints,
    overdueExpectedIncome,
    ...(scenario !== PROJECTION_SCENARIO.BASE ? { contingencyUndated, ...riskExposure } : {}),
  };
}

export async function buildBaseProjection(opts) {
  return buildProjectionScenario(PROJECTION_SCENARIO.BASE, opts);
}
export async function buildExpectedProjection(opts) {
  return buildProjectionScenario(PROJECTION_SCENARIO.EXPECTED, opts);
}
export async function buildStressProjection(opts) {
  return buildProjectionScenario(PROJECTION_SCENARIO.STRESS, opts);
}

// Menor projectedCash que a timeline BASE atinge estritamente ANTES de
// `cutoffDate` (usado por lib/financialStatus.js pra decidir CRITICO — item 19).
// Considera o startingCash como piso inicial (se já nasce negativo, conta).
export function minProjectedCashBefore(baseProjection, cutoffDate) {
  let min = baseProjection.startingCash;
  for (const event of baseProjection.timeline) {
    if (event.date >= cutoffDate) break;
    if (event.balanceAfter.lt(min)) min = event.balanceAfter;
  }
  return min;
}
