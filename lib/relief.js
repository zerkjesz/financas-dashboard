// ============================================================================
// Fase 9.1 — LINHA DO TEMPO DE ALÍVIO. Responde: "Quando minha renda fica menos comprometida?"
//
// Puro (recebe planos ACTIVE com installments + a competência corrente). Substitui o
// computeExternalInstallmentRunoff() por "posição de renda" (que não tinha datas reais) por
// COMPETÊNCIAS reais (mês do calendário no fuso do app): month[k] = quanto das parcelas sai da
// renda naquele mês. Um plano ativo cobra uma parcela por mês até acabar; monthsLeft =
// parcelas PENDING + (1 se a parcela DESTE mês já foi paga — ela ainda pertence ao mês corrente).
// Marco = mês em que o total mensal CAI (plano(s) que terminam), com quanto é liberado por mês.
// Nenhuma data/mês é hardcoded: tudo parte de `monthKey`.
// ============================================================================
import { money, sumMoney, subtractMoney, serializeMoney, ZERO } from "./money.js";
import { addMonthsToKey, monthLabelShort, monthLongName, monthLongWithYear } from "./paymentDates.js";

const MAX_MONTHS = 120;
const num = (x) => Number(serializeMoney(x));

export function planMonthsLeft(plan, { monthStart, monthEnd }) {
  const pending = plan.installments.filter((i) => i.status === "PENDING").length;
  const paidThisMonth = plan.installments.some((i) => i.status === "PAID" && i.paidAt && i.paidAt >= monthStart && i.paidAt < monthEnd);
  return pending + (paidThisMonth ? 1 : 0);
}

export function computeReliefTimeline(plans, { monthKey, monthStart, monthEnd }) {
  const active = plans
    .map((p) => ({ id: p.id, name: p.description, value: money(p.installmentValue), left: planMonthsLeft(p, { monthStart, monthEnd }) }))
    .filter((p) => p.left > 0);
  if (active.length === 0) return { monthKey, months: [], milestones: [], todayMonthly: 0, zeroMonth: null, totalRemaining: 0, next: null, activePlanCount: 0 };

  const span = Math.min(Math.max(...active.map((p) => p.left)), MAX_MONTHS);
  const loads = [];
  for (let k = 0; k <= span; k++) loads.push(active.reduce((acc, p) => (p.left > k ? acc.plus(p.value) : acc), ZERO));

  const months = loads.map((load, k) => {
    const key = addMonthsToKey(monthKey, k);
    return { monthKey: key, label: k === 0 ? "AGORA" : monthLabelShort(key), labelShort: monthLabelShort(key), monthLong: monthLongName(key), committed: num(load) };
  });
  const milestones = [];
  for (let k = 1; k < loads.length; k++) {
    const released = subtractMoney(loads[k - 1], loads[k]);
    if (!released.gt(0)) continue;
    const key = addMonthsToKey(monthKey, k);
    milestones.push({
      monthKey: key,
      label: monthLabelShort(key),
      monthLong: monthLongName(key),
      released: num(released),
      plans: active.filter((p) => p.left === k).map((p) => ({ id: p.id, name: p.name })),
      after: num(loads[k]),
    });
  }
  const zeroIdx = loads.findIndex((l) => !l.gt(0));
  const zeroKey = zeroIdx >= 0 ? addMonthsToKey(monthKey, zeroIdx) : null;
  const totalRemaining = num(sumMoney(active.map((p) => p.value.times(p.left))));
  return {
    monthKey,
    months,
    milestones,
    todayMonthly: num(loads[0]),
    zeroMonth: zeroKey ? { monthKey: zeroKey, label: monthLabelShort(zeroKey), longLabel: monthLongWithYear(zeroKey) } : null,
    totalRemaining,
    next: milestones[0] ?? null,
    activePlanCount: active.length,
  };
}
