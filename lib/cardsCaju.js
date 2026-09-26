// ============================================================================
// Fase 10 — READ-MODEL do CAJU (VA). SOMENTE LEITURA. Caju NÃO é cartão de crédito: é o saldo restrito do
// vale-alimentação (Account type "food_voucher"). Não tem fatura, dívida, parcelamento nem limite de crédito.
//
// PROCEDÊNCIA: saldo = ledger real (âncora + Income − Expense ± Transfer) — a âncora de abertura é DERIVED_ONLY;
// recarga = RecurringRule real (dia/valor) + ocorrências realizadas; gastos/ciclo = Expense/Income reais.
// "Sobrou do ciclo anterior" só é calculado quando o ledger permite (âncora anterior ao início do ciclo).
// ============================================================================
import { prisma } from "./prisma.js";
import { serializeMoney } from "./money.js";
import { computeAccountBalance } from "./accounts.js";
import { clampToMonth } from "./recurringCycles.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { resolveRechargeCycle, computePacing, nextWeekend, weekendSliderRange, weekendPlan, RESERVE_PERCENT, DAY_MS } from "./vaPacing.js";

const num = (x) => (x == null ? 0 : Number(serializeMoney(x)));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
const dm = (ms) => `${String(new Date(ms).getUTCDate()).padStart(2, "0")}/${String(new Date(ms).getUTCMonth() + 1).padStart(2, "0")}`;
// Convenção do app: data de calendário = meia-noite UTC (lançamento "de um dia"); qualquer outro instante
// (ex.: pagamento registrado com `now`, âncora de fim de dia) vale pelo dia LOCAL. Hoje sempre pelo dia local.
const localDayMs = (instant, tz) => {
  const d = new Date(instant);
  const isCalendarDate = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return isCalendarDate ? d.getTime() : localCalendarDateAsUtcMidnight(d, tz).getTime();
};

function occurrencesAround(day, todayMs, backDays = 75, fwdDays = 75) {
  const out = [];
  const t = new Date(todayMs);
  for (let m = -3; m <= 3; m++) out.push(clampToMonth(t.getUTCFullYear(), t.getUTCMonth() + m, day).getTime());
  return out.filter((ms) => ms >= todayMs - backDays * DAY_MS && ms <= todayMs + fwdDays * DAY_MS).sort((a, b) => a - b);
}

export async function buildCajuModel({ now = new Date(), client = prisma, accountId } = {}) {
  const account = accountId ? await client.account.findUnique({ where: { id: accountId } }) : await client.account.findFirst({ where: { type: "food_voucher" }, orderBy: { createdAt: "asc" } });
  if (!account) return null;
  const tz = getAppTimezone();
  const todayMs = localCalendarDateAsUtcMidnight(now, tz).getTime();

  const [rule, anchor, balanceD] = await Promise.all([
    client.recurringRule.findFirst({ where: { accountId: account.id, kind: "income", isActive: true } }),
    client.balanceAdjustment.findFirst({ where: { accountId: account.id }, orderBy: { occurredAt: "desc" } }),
    computeAccountBalance(account.id, { client }),
  ]);
  const balance = r2(num(balanceD));
  const ruleAmount = rule?.amount != null ? num(rule.amount) : null;

  // ---- ciclo de recarga (regra real + ocorrências realizadas) ----
  const incomes = await client.income.findMany({ where: { accountId: account.id, occurredAt: { gte: new Date(todayMs - 120 * DAY_MS) } }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] });
  let cycle = { state: "UNKNOWN", lastRechargeMs: null, nextRechargeMs: null, daysLeft: null, elapsed: null, cycleLength: null };
  if (rule?.dayOfMonth != null) {
    const occ = occurrencesAround(rule.dayOfMonth, todayMs);
    const linked = incomes.filter((i) => i.recurringRuleId === rule.id && i.recurringOccurrenceDate).map((i) => new Date(i.recurringOccurrenceDate).getTime());
    // Recarga sem vínculo explícito (lançada à mão): conta como realizada se o valor bate com a regra e caiu até 7 dias após a ocorrência.
    const heuristic = ruleAmount == null ? [] : occ.filter((o) => o <= todayMs && incomes.some((i) => Math.abs(num(i.amount) - ruleAmount) < 0.01 && localDayMs(i.occurredAt, tz) >= o && localDayMs(i.occurredAt, tz) <= o + 7 * DAY_MS));
    cycle = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [...linked, ...heuristic], todayMs });
  }

  // ---- movimentos do ciclo (ledger real) ----
  const cycleStartMs = cycle.lastRechargeMs;
  const sinceInstant = new Date((cycleStartMs ?? todayMs - 30 * DAY_MS) - 2 * DAY_MS);
  const [expensesRaw, incomesCycleRaw, transfersRaw] = await Promise.all([
    client.expense.findMany({ where: { accountId: account.id, occurredAt: { gte: sinceInstant } }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] }),
    client.income.findMany({ where: { accountId: account.id, occurredAt: { gte: sinceInstant } }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] }),
    client.transfer.findMany({ where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }], occurredAt: { gte: sinceInstant } }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }] }),
  ]);
  const inCycle = (d) => cycleStartMs != null && localDayMs(d, tz) >= cycleStartMs;
  const spentEntries = [...expensesRaw.filter((e) => inCycle(e.occurredAt)).map((e) => ({ ms: localDayMs(e.occurredAt, tz), amount: num(e.amount), name: e.description, category: e.category })), ...transfersRaw.filter((t) => t.fromAccountId === account.id && inCycle(t.occurredAt)).map((t) => ({ ms: localDayMs(t.occurredAt, tz), amount: num(t.amount), name: t.description, category: "Transferência" }))];
  const rechargeIn = incomesCycleRaw.filter((i) => inCycle(i.occurredAt) && rule && i.recurringRuleId === rule.id);
  const otherCredits = [...incomesCycleRaw.filter((i) => inCycle(i.occurredAt) && !(rule && i.recurringRuleId === rule.id)).map((i) => num(i.amount)), ...transfersRaw.filter((t) => t.toAccountId === account.id && inCycle(t.occurredAt)).map((t) => num(t.amount))];
  // recarga lançada à mão com o valor da regra também é "recarga" (mesma heurística)
  const rechargeManual = ruleAmount == null ? [] : incomesCycleRaw.filter((i) => inCycle(i.occurredAt) && !(rule && i.recurringRuleId === rule.id) && Math.abs(num(i.amount) - ruleAmount) < 0.01);
  const rechargeTotal = r2([...rechargeIn, ...rechargeManual].reduce((a, i) => a + num(i.amount), 0));
  const otherCreditsTotal = r2(otherCredits.reduce((a, v) => a + v, 0) - rechargeManual.reduce((a, i) => a + num(i.amount), 0));
  const spentTotal = r2(spentEntries.reduce((a, e) => a + e.amount, 0));
  const spentBeforeToday = r2(spentEntries.filter((e) => e.ms < todayMs).reduce((a, e) => a + e.amount, 0));

  // carry-over derivável? (âncora do ledger anterior ao início do ciclo ⇒ o saldo de antes dos movimentos do ciclo é conhecido)
  const anchorOk = anchor && cycleStartMs != null && localDayMs(anchor.occurredAt, tz) < cycleStartMs;
  const opening = anchorOk ? r2(balance - rechargeTotal - otherCreditsTotal + spentTotal) : null;
  const carryOver = opening != null && opening >= 0 ? opening : null;

  // ---- ritmo, projeção e fim de semana ----
  const daysLeft = cycle.state === "NORMAL" ? cycle.daysLeft : 0;
  const eq = computePacing({ balance, daysLeft, mode: "eq" });
  const save = computePacing({ balance, daysLeft, mode: "save" });
  const weekend = cycle.nextRechargeMs != null && cycle.state === "NORMAL" ? nextWeekend({ todayMs, nextRechargeMs: cycle.nextRechargeMs }) : null;
  const slider = weekend?.available ? weekendSliderRange({ balance, dailyEq: eq.daily ?? 0, weekendDays: weekend.weekendDays }) : null;
  const wkDefault = slider ? weekendPlan({ balance, daysLeft, weekendDays: weekend.weekendDays, reserve: slider.default }) : null;
  const paceSoFar = cycle.elapsed > 0 ? r2(spentBeforeToday / cycle.elapsed) : null;
  const projectedLeftover = paceSoFar != null && daysLeft > 0 ? r2(balance - paceSoFar * daysLeft) : null;
  const runsOutInDays = paceSoFar > 0 && projectedLeftover != null && projectedLeftover < 0 ? Math.floor(balance / paceSoFar) : null;
  const biggest = [...spentEntries].sort((a, b) => b.amount - a.amount)[0] ?? null;

  // ---- últimas movimentações reais (até 5) — as MAIS RECENTES do ledger, mesmo fora do ciclo ----
  const [lastExp, lastInc, lastTrf] = await Promise.all([
    client.expense.findMany({ where: { accountId: account.id }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5 }),
    client.income.findMany({ where: { accountId: account.id }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5 }),
    client.transfer.findMany({ where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }] }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], take: 5 }),
  ]);
  const moves = [
    ...lastExp.map((e) => ({ at: e.occurredAt, created: e.createdAt, name: e.description, sub: e.category, amount: -num(e.amount), type: "expense" })),
    ...lastInc.map((i) => ({ at: i.occurredAt, created: i.createdAt, name: i.description, sub: rule && i.recurringRuleId === rule.id ? "Recarga" : "Crédito", amount: num(i.amount), type: "income" })),
    ...lastTrf.map((t) => ({ at: t.occurredAt, created: t.createdAt, name: t.description, sub: "Transferência", amount: t.toAccountId === account.id ? num(t.amount) : -num(t.amount), type: "transfer" })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at) || new Date(b.created) - new Date(a.created))
    .slice(0, 5)
    .map((m) => ({ date: dm(localDayMs(m.at, tz)), name: m.name, sub: m.sub, amount: r2(m.amount), type: m.type }));

  return {
    account: { id: account.id, name: account.name },
    balance,
    balanceSource: "LEDGER",
    balanceAnchor: anchor ? { asOf: anchor.occurredAt.toISOString(), note: anchor.note } : null,
    recharge: rule
      ? { amount: ruleAmount, dayOfMonth: rule.dayOfMonth, state: cycle.state, lastDate: iso(cycle.lastRechargeMs), nextDate: iso(cycle.nextRechargeMs), daysLeft: cycle.daysLeft, nextLabel: cycle.nextRechargeMs != null ? dm(cycle.nextRechargeMs) : null, lastLabel: cycle.lastRechargeMs != null ? dm(cycle.lastRechargeMs) : null }
      : null,
    cycle: cycle.cycleLength != null ? { elapsed: cycle.elapsed, length: cycle.cycleLength, daysLeft: cycle.daysLeft, todayLabel: dm(todayMs), timePctAhead: cycle.cycleLength > 0 ? Math.round(((cycle.cycleLength - cycle.elapsed) / cycle.cycleLength) * 100) : null } : null,
    today: iso(todayMs),
    pacing: {
      status: eq.status,
      daysLeft,
      daily: eq.daily,
      modes: {
        eq: { daily: eq.daily, note: "Divide o saldo por igual entre os dias até a recarga." },
        save: { daily: save.daily, reserve: save.reserve ?? null, reservePercent: RESERVE_PERCENT, note: save.reserve != null ? `Simulação: deixa ${RESERVE_PERCENT}% do saldo (R$ ${save.reserve.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}) de reserva para o próximo ciclo.` : "Sem saldo para reservar." },
        wk: { note: "Separa a reserva do fim de semana e divide o resto pelos outros dias." },
      },
    },
    weekend: weekend
      ? { available: weekend.available, satLabel: dm(weekend.satMs), sunLabel: dm(weekend.sunMs), satDate: iso(weekend.satMs), sunDate: iso(weekend.sunMs), weekendDays: weekend.weekendDays, slider, plan: wkDefault }
      : null,
    cycleSummary: {
      carryOver,
      carryOverNote: carryOver != null ? "Derivado do ledger (saldo de abertura DERIVED_ONLY)." : null,
      recharges: rechargeTotal,
      otherCredits: otherCreditsTotal,
      spent: spentTotal,
      balanceNow: balance,
      nextRechargeAmount: ruleAmount,
      nextRechargeLabel: cycle.nextRechargeMs != null ? dm(cycle.nextRechargeMs) : null,
    },
    pace: { soFar: paceSoFar, sustainable: eq.daily, projectedLeftover, runsOutInDays, spentBeforeToday },
    insights: buildInsights({ paceSoFar, sustainable: eq.daily, projectedLeftover, runsOutInDays, spentTotal, biggest, nextLabel: cycle.nextRechargeMs != null ? dm(cycle.nextRechargeMs) : null, available: r2((carryOver ?? 0) + rechargeTotal + otherCreditsTotal) }),
    recentMoves: moves,
    facts: rule ? { rechargeDay: rule.dayOfMonth, rechargeAmount: ruleAmount, daysLeft: cycle.daysLeft } : null,
  };
}

const money0 = (n) => `R$ ${Math.round(n).toLocaleString("pt-BR")}`;
function buildInsights({ paceSoFar, sustainable, projectedLeftover, runsOutInDays, spentTotal, biggest, nextLabel, available }) {
  const out = [];
  if (paceSoFar != null && paceSoFar > 0 && sustainable != null) {
    out.push({ big: `${money0(paceSoFar)}/dia`, txt: paceSoFar <= sustainable ? `é o seu ritmo neste ciclo, abaixo dos ${money0(sustainable)} que fariam o saldo durar até a recarga.` : `é o seu ritmo neste ciclo, acima dos ${money0(sustainable)} que fariam o saldo durar até a recarga.` });
  }
  if (spentTotal > 0) {
    const pct = available > 0 ? Math.round((spentTotal / available) * 100) : null;
    out.push({ big: money0(spentTotal), txt: `gastos neste ciclo${pct != null ? `, ${pct}% do que entrou e estava disponível` : ""}${biggest ? `. O maior foi ${biggest.name} (${money0(biggest.amount)}).` : "."}` });
  }
  if (projectedLeftover != null && paceSoFar > 0) {
    out.push(projectedLeftover >= 0 ? { big: `~${money0(projectedLeftover)}`, txt: `devem sobrar${nextLabel ? ` em ${nextLabel}` : ""} se o ritmo continuar igual.` } : { big: `~${runsOutInDays} dias`, txt: `é quanto o saldo dura se o ritmo continuar igual — antes da recarga${nextLabel ? ` de ${nextLabel}` : ""}.` });
  }
  return out;
}
