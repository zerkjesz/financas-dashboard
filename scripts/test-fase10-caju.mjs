// Fase 10 — CAJU (VA): saldo do ledger, recarga (regra real), ritmo diário, ciclo, carry-over derivável, fim de
// semana (simulação), últimas movimentações e ZERO escrita. Fixtures MARK (conta VA, regra, incomes, expenses
// próprios); relógios controlados. Parte pura (lib/vaPacing.js) + parte com banco (lib/cardsCaju.js).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { resolveRechargeCycle, computePacing, nextWeekend, weekendSliderRange, weekendPlan, DAY_MS, RESERVE_PERCENT } from "../lib/vaPacing.js";
import { buildCajuModel } from "../lib/cardsCaju.js";
import { buildCardsAreaModel } from "../lib/cardsArea.js";

const MARK = "TESTE_F10C";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const near = (a, b, e = 0.006) => Math.abs(Number(a) - Number(b)) <= e;
const D = (s) => Date.UTC(...s.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
const created = { accounts: [], rules: [] };

async function counts() {
  return JSON.stringify(await Promise.all(["income", "expense", "transfer", "balanceAdjustment", "recurringRule", "bill", "telegramCorrectionAudit", "cardBill"].map((m) => prisma[m].count())));
}

async function cleanup() {
  await prisma.income.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.recurringRule.deleteMany({ where: { id: { in: created.rules } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: created.accounts } } }).catch(() => {});
  const left = await Promise.all([prisma.account.count({ where: { slug: { contains: "teste-f10c" } } }), prisma.recurringRule.count({ where: { name: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((c) => c === 0), JSON.stringify(left));
}

async function main() {
  // ================= PUROS: ciclo de recarga =================
  const occ = [D("2026-08-21"), D("2026-09-21"), D("2026-10-21"), D("2026-11-21")];
  const c1 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [D("2026-08-21"), D("2026-09-21")], todayMs: D("2026-09-26") });
  check("[CICLO] hoje 26/09 com a recarga de 21/09 realizada: próxima 21/10, faltam 25 dias, dia 5 de 30", c1.state === "NORMAL" && c1.nextRechargeMs === D("2026-10-21") && c1.daysLeft === 25 && c1.elapsed === 5 && c1.cycleLength === 30 && c1.lastRechargeMs === D("2026-09-21"));
  const c2 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [D("2026-08-21")], todayMs: D("2026-09-15") });
  check("[CICLO] hoje ANTES do dia 21 (15/09): próxima recarga = 21/09 (6 dias), ciclo desde 21/08", c2.state === "NORMAL" && c2.nextRechargeMs === D("2026-09-21") && c2.daysLeft === 6 && c2.lastRechargeMs === D("2026-08-21"));
  const c3 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [D("2026-08-21"), D("2026-09-21")], todayMs: D("2026-09-21") });
  check("[CICLO] hoje NO dia 21 com a recarga JÁ realizada: próxima é 21/10 (30 dias); a de hoje não é 'próxima'", c3.state === "NORMAL" && c3.nextRechargeMs === D("2026-10-21") && c3.daysLeft === 30 && c3.elapsed === 0);
  const c4 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [D("2026-08-21")], todayMs: D("2026-09-21") });
  check("[CICLO] hoje NO dia 21 com a recarga AINDA NÃO realizada: DUE_TODAY (sem chute de ritmo)", c4.state === "DUE_TODAY" && c4.daysLeft === 0);
  const c5 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [D("2026-08-21")], todayMs: D("2026-09-23") });
  check("[CICLO] DEPOIS do dia 21 sem recarga lançada: LATE (2 dias de atraso), próxima continua sendo a de 21/09", c5.state === "LATE" && c5.daysLeft === -2 && c5.nextRechargeMs === D("2026-09-21"));
  const c6 = resolveRechargeCycle({ occurrenceMs: occ, realizedMs: [], todayMs: D("2026-09-26") });
  check("[CICLO] sem nenhuma recarga realizada: usa a regra (próxima ocorrência ≥ hoje) — nada é inventado", c6.nextRechargeMs === D("2026-10-21") && c6.lastRechargeMs === D("2026-09-21"));
  check("[CICLO] sem ocorrências da regra: UNKNOWN", resolveRechargeCycle({ occurrenceMs: [], realizedMs: [], todayMs: D("2026-09-26") }).state === "UNKNOWN");

  // ================= PUROS: ritmo =================
  const eq = computePacing({ balance: 1400, daysLeft: 25, mode: "eq" });
  check("[RITMO] equilibrado = saldo / dias até a recarga (1.400 / 25 = 56)", eq.status === "OK" && eq.daily === 56 && eq.days === 25);
  const sv = computePacing({ balance: 1000, daysLeft: 20, mode: "save" });
  check(`[RITMO] guardar sobra = simulação explícita de ${RESERVE_PERCENT}% de reserva: (1.000 − 100) / 20 = 45`, sv.daily === 45 && sv.reserve === 100);
  const wk = computePacing({ balance: 1400, daysLeft: 25, mode: "wk", weekendReserve: 200, weekendDays: 2 });
  check("[RITMO] modo fim de semana: (1.400 − 200) / 23 = 52,17", wk.daily === 52.17 && wk.restDays === 23);
  check("[RITMO] sem período (recarga hoje/atrasada): NO_PERIOD, sem número", computePacing({ balance: 500, daysLeft: 0 }).status === "NO_PERIOD" && computePacing({ balance: 500, daysLeft: -3 }).daily === null);
  check("[RITMO] saldo zero ou negativo: NO_BALANCE, ritmo 0 (nunca negativo/impossível)", computePacing({ balance: 0, daysLeft: 10 }).daily === 0 && computePacing({ balance: -50, daysLeft: 10 }).status === "NO_BALANCE");
  check("[RITMO] reserva do FDS acima do saldo é limitada ao saldo (nunca ritmo negativo)", computePacing({ balance: 300, daysLeft: 10, mode: "wk", weekendReserve: 900, weekendDays: 2 }).daily === 0);

  // ================= PUROS: fim de semana =================
  const sat = (s) => new Date(D(s)).getUTCDay();
  const w1 = nextWeekend({ todayMs: D("2026-09-26"), nextRechargeMs: D("2026-10-21") }); // hoje é sábado
  check("[FDS] hoje sábado (26/09): o próximo fim de semana é 03 e 04/10 (estritamente futuro)", w1.satMs === D("2026-10-03") && w1.sunMs === D("2026-10-04") && w1.weekendDays === 2 && sat("2026-10-03") === 6);
  const w2 = nextWeekend({ todayMs: D("2026-09-25"), nextRechargeMs: D("2026-10-21") }); // sexta
  check("[FDS] hoje sexta (25/09): sábado é amanhã (26/09) e domingo 27/09", w2.satMs === D("2026-09-26") && w2.sunMs === D("2026-09-27"));
  const w3 = nextWeekend({ todayMs: D("2026-09-27"), nextRechargeMs: D("2026-10-21") }); // domingo
  check("[FDS] hoje domingo (27/09): o próximo é 03 e 04/10", w3.satMs === D("2026-10-03"));
  const w4 = nextWeekend({ todayMs: D("2026-09-28"), nextRechargeMs: D("2026-10-21") }); // segunda
  check("[FDS] hoje segunda (28/09): sábado é 03/10", w4.satMs === D("2026-10-03"));
  const w5 = nextWeekend({ todayMs: D("2026-10-17"), nextRechargeMs: D("2026-10-21") });
  check("[FDS] fim de semana DEPOIS da recarga não entra no período (weekendDays 0, indisponível)", w5.weekendDays === 0 && w5.available === false);
  const w6 = nextWeekend({ todayMs: D("2026-10-14"), nextRechargeMs: D("2026-10-17") });
  check("[FDS] recarga num sábado: só o dia anterior à recarga conta (sábado 17/10 é o dia da recarga → 0 dias)", w6.satMs === D("2026-10-17") && w6.weekendDays === 0);
  const r = weekendSliderRange({ balance: 1400, dailyEq: 56, weekendDays: 2 });
  check("[FDS] faixa do slider derivada (nunca constante): até 4 fins de semana normais, nunca acima do saldo; padrão = 1 fim de semana no ritmo", r.min === 0 && r.max === 450 && r.default === 110 && r.normalWeekend === 112 && r.max <= 1400);
  check("[FDS] saldo baixo limita o máximo ao saldo (impossível reservar mais do que existe)", weekendSliderRange({ balance: 60, dailyEq: 56, weekendDays: 2 }).max <= 60);
  const p0 = weekendPlan({ balance: 1400, daysLeft: 25, weekendDays: 2, reserve: 0 });
  check("[FDS] reserva = 0: saldo inteiro, 23 dias, ritmo 60,87, peso 0%", p0.remainingBalance === 1400 && p0.restDays === 23 && p0.restDaily === 60.87 && p0.shareOfBalance === 0);
  const pAll = weekendPlan({ balance: 1400, daysLeft: 25, weekendDays: 2, reserve: 1400 });
  check("[FDS] reserva = saldo total: sobra 0, ritmo dos outros dias 0, peso 100%", pAll.remainingBalance === 0 && pAll.restDaily === 0 && pAll.shareOfBalance === 100);
  const pOver = weekendPlan({ balance: 500, daysLeft: 10, weekendDays: 2, reserve: 9999 });
  check("[FDS] reserva acima do saldo é limitada ao saldo (estado matematicamente impossível não existe)", pOver.reserve === 500 && pOver.remainingBalance === 0);
  check("[FDS] ao mexer no slider recalcula saldo restante, ritmo e peso (mesma regra testada do backend/frontend)", weekendPlan({ balance: 1400, daysLeft: 25, weekendDays: 2, reserve: 200 }).restDaily === 52.17 && weekendPlan({ balance: 1400, daysLeft: 25, weekendDays: 2, reserve: 200 }).shareOfBalance === 14);

  // ================= COM BANCO =================
  const acc = await prisma.account.create({ data: { slug: "teste-f10c-va", name: `${MARK} Caju`, type: "food_voucher" } });
  created.accounts.push(acc.id);
  const rule = await prisma.recurringRule.create({ data: { name: `${MARK} Recarga`, kind: "income", amount: 1300, dayOfMonth: 21, accountId: acc.id, isActive: true, category: "Vale Alimentação" } });
  created.rules.push(rule.id);
  await prisma.balanceAdjustment.create({ data: { accountId: acc.id, newBalance: 100, note: `${MARK} abertura (DERIVED_ONLY)`, source: "manual", occurredAt: new Date("2026-08-21T02:59:59.999Z") } });
  const inc = (over) => prisma.income.create({ data: { accountId: acc.id, source: "manual", category: "Vale Alimentação", ...over } });
  const exp = (over) => prisma.expense.create({ data: { accountId: acc.id, source: "manual", category: "Alimentação", ...over } });
  await inc({ amount: 1300, description: `${MARK} Recarga mensal`, recurringRuleId: rule.id, isRecurring: true, recurringOccurrenceDate: new Date("2026-09-21T00:00:00Z"), occurredAt: new Date("2026-09-23T00:00:00Z") });
  await inc({ amount: 30, description: `${MARK} Crédito extra`, occurredAt: new Date("2026-09-25T00:00:00Z") });
  await exp({ amount: 50, description: `${MARK} Lanche (ciclo anterior)`, occurredAt: new Date("2026-09-10T00:00:00Z") });
  await exp({ amount: 55, description: `${MARK} Pizza`, occurredAt: new Date("2026-09-23T00:00:00Z") });
  await exp({ amount: 64, description: `${MARK} Pastel`, occurredAt: new Date("2026-09-25T00:00:00Z") });

  const NOW = new Date("2026-09-26T15:00:00.000Z");
  const m = await buildCajuModel({ accountId: acc.id, now: NOW });
  check("[SALDO] saldo real do ledger = 100 + 1.300 + 30 − (50 + 55 + 64) = 1.261 (recarga FUTURA de 21/10 não entra)", m.balance === 1261 && m.balanceSource === "LEDGER" && m.cycleSummary.nextRechargeAmount === 1300 && m.cycleSummary.balanceNow === 1261);
  check("[RECARGA] regra real: dia 21, R$1.300; última 21/09 (ocorrência realizada), próxima 21/10, faltam 25 dias — nada hardcoded", m.recharge.dayOfMonth === 21 && m.recharge.amount === 1300 && m.recharge.lastDate === "2026-09-21" && m.recharge.nextDate === "2026-10-21" && m.recharge.daysLeft === 25 && m.recharge.state === "NORMAL");
  check("[RITMO] 1.261 / 25 = R$ 50,44/dia; nota do modo sem tom moral", m.pacing.daily === 50.44 && m.pacing.status === "OK" && m.pacing.daysLeft === 25);
  check("[CICLO] dia 5 de 30, faltam 25; 83% do tempo pela frente", m.cycle.elapsed === 5 && m.cycle.length === 30 && m.cycle.daysLeft === 25 && m.cycle.timePctAhead === 83);
  check("[CICLO] movimentos do ciclo: recargas 1.300, outros créditos 30, gasto 119 (o lanche de 10/09 é do ciclo anterior)", m.cycleSummary.recharges === 1300 && m.cycleSummary.otherCredits === 30 && m.cycleSummary.spent === 119);
  check("[CARRY-OVER] sobra do ciclo anterior DERIVADA do ledger: 1.261 − 1.300 − 30 + 119 = 50 (= 100 de abertura − 50 do lanche)", m.cycleSummary.carryOver === 50 && /DERIVED_ONLY/.test(m.cycleSummary.carryOverNote));
  check("[CARRY-OVER] identidade: sobra + recargas + créditos − gasto = saldo agora (não afirma 'saldo = recarga − gasto')", near(m.cycleSummary.carryOver + m.cycleSummary.recharges + m.cycleSummary.otherCredits - m.cycleSummary.spent, m.balance));
  check("[RITMO ATÉ AGORA] gasto até ontem / dias decorridos = 119 / 5 = 23,80; projeção de sobra = 1.261 − 23,80 × 25 = 666", m.pace.soFar === 23.8 && m.pace.projectedLeftover === 666 && m.pace.runsOutInDays === null);
  check("[FDS] próximo fim de semana 03 e 04/10 (2 dias no período); padrão = 1 fim de semana no ritmo (100); máx ≤ saldo", m.weekend.satDate === "2026-10-03" && m.weekend.sunDate === "2026-10-04" && m.weekend.weekendDays === 2 && m.weekend.slider.default === 100 && m.weekend.slider.max <= m.balance);
  check("[FDS] plano padrão: sobram 1.161 em 23 dias = 50,48/dia; nenhuma despesa escrita", m.weekend.plan.remainingBalance === 1161 && m.weekend.plan.restDays === 23 && m.weekend.plan.restDaily === 50.48);
  check("[MODOS] Guardar sobra (simulação de 10%): (1.261 − 126,10) / 25 = 45,40", m.pacing.modes.save.reserve === 126.1 && m.pacing.modes.save.daily === 45.4 && m.pacing.modes.save.reservePercent === 10);
  check("[MOVIMENTAÇÕES] últimas compras REAIS por data local (convenção de data de calendário), mais recente primeiro; sem merchant inventado", m.recentMoves.length === 5 && m.recentMoves.map((x) => x.date).join() === "25/09,25/09,23/09,23/09,10/09" && m.recentMoves[0].name === `${MARK} Pastel`, JSON.stringify(m.recentMoves.map((x) => [x.date, x.name])));
  check("[MOVIMENTAÇÕES] saídas negativas, entradas positivas; recarga rotulada 'Recarga'", m.recentMoves.some((x) => x.amount === -64) && m.recentMoves.some((x) => x.sub === "Recarga" && x.amount === 1300));
  check("[INSIGHTS] textos reais (ritmo 24, gasto 119 com maior compra 'Pizza'/'Pastel', sobra ~666), sem valores mockados", m.insights.length === 3 && /R\$ 24\/dia/.test(m.insights[0].big) && /R\$ 119/.test(m.insights[1].big) && /666/.test(m.insights[2].big));

  // relógios
  const before21 = await buildCajuModel({ accountId: acc.id, now: new Date("2026-09-15T15:00:00Z") });
  check("[RELÓGIO] antes do dia 21 (15/09): próxima recarga 21/09, 6 dias, ritmo sobre 6 dias", before21.recharge.nextDate === "2026-09-21" && before21.recharge.daysLeft === 6 && before21.pacing.daysLeft === 6);
  const on21 = await buildCajuModel({ accountId: acc.id, now: new Date("2026-10-21T15:00:00Z") });
  check("[RELÓGIO] em 21/10 sem a recarga lançada: DUE_TODAY, sem ritmo (não chuta), sem fim de semana", on21.recharge.state === "DUE_TODAY" && on21.pacing.daily === null && on21.pacing.status === "NO_PERIOD" && on21.weekend === null);
  const late = await buildCajuModel({ accountId: acc.id, now: new Date("2026-10-23T15:00:00Z") });
  check("[RELÓGIO] em 23/10 sem recarga: LATE (2 dias), sem ritmo", late.recharge.state === "LATE" && late.recharge.daysLeft === -2 && late.pacing.daily === null);
  const tz = await buildCajuModel({ accountId: acc.id, now: new Date("2026-09-26T02:30:00Z") });
  check("[FUSO] 26/09 02:30Z = 25/09 23:30 no Brasil: hoje é 25/09 e faltam 26 dias (data LOCAL, não UTC)", tz.today === "2026-09-25" && tz.recharge.daysLeft === 26);
  const nearNext = await buildCajuModel({ accountId: acc.id, now: new Date("2026-10-17T15:00:00Z") });
  check("[FDS] a 4 dias da recarga o próximo fim de semana (24/10) cai depois dela: indisponível", nearNext.weekend.available === false);

  // sem movimentos / sem regra / carry-over não derivável
  const empty = await prisma.account.create({ data: { slug: "teste-f10c-vazio", name: `${MARK} Vazio`, type: "food_voucher" } });
  created.accounts.push(empty.id);
  const rule2 = await prisma.recurringRule.create({ data: { name: `${MARK} Recarga 2`, kind: "income", amount: 500, dayOfMonth: 5, accountId: empty.id, isActive: true, category: "VA" } });
  created.rules.push(rule2.id);
  const me = await buildCajuModel({ accountId: empty.id, now: NOW });
  check("[SEM MOVIMENTOS] saldo 0, listas vazias, sem NaN e sem inventar 'sobrou do ciclo anterior'", me.balance === 0 && me.recentMoves.length === 0 && me.insights.length === 0 && me.cycleSummary.carryOver === null && me.cycleSummary.spent === 0 && me.pacing.daily === 0 && !/NaN|undefined/.test(JSON.stringify(me)));
  const noRule = await prisma.account.create({ data: { slug: "teste-f10c-sem-regra", name: `${MARK} SemRegra`, type: "food_voucher" } });
  created.accounts.push(noRule.id);
  const mn = await buildCajuModel({ accountId: noRule.id, now: NOW });
  check("[SEM REGRA] sem recarga configurada: recharge null, ritmo indisponível — a UI continua funcionando", mn.recharge === null && mn.pacing.status === "NO_PERIOD" && mn.weekend === null);
  await prisma.balanceAdjustment.create({ data: { accountId: empty.id, newBalance: 10, note: MARK, source: "manual", occurredAt: new Date("2026-09-22T12:00:00Z") } });
  const late2 = await buildCajuModel({ accountId: empty.id, now: NOW });
  check("[CARRY-OVER] âncora DEPOIS do início do ciclo: sobra não é derivável => campo ausente (nunca copiado de mock)", late2.cycleSummary.carryOver === null && late2.cycleSummary.carryOverNote === null);

  const area = await buildCardsAreaModel({ now: NOW });
  check("[ÁREA] Caju não tem fatura, dívida, parcelamento nem limite de crédito no modelo", area.caju && !("bill" in area.caju) && !("limit" in area.caju) && !("installments" in area.caju));
  const b2 = await counts();
  await buildCajuModel({ accountId: acc.id, now: NOW });
  await buildCajuModel({ accountId: empty.id, now: NOW });
  check("[ZERO ESCRITA] leituras repetidas do Caju: contagens IDÊNTICAS", (await counts()) === b2);
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
