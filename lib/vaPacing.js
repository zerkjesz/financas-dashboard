// ============================================================================
// Fase 10 — CAJU (VA): cálculos PUROS de ritmo, ciclo de recarga e fim de semana. Sem Prisma, sem relógio
// implícito: recebe datas como "meia-noite UTC do dia LOCAL" (ms). Compartilhado pelo backend (read-model) e
// pelo frontend (slider do fim de semana recalcula instantaneamente com a MESMA regra testada).
//
// Regras:
//  * Dias até a recarga = dias de HOJE (inclusive) até o dia ANTERIOR à recarga: de 26/09 a 21/10 são 25.
//  * Ritmo (R$/dia) = saldo / dias até a recarga. Matemática de ritmo, sem tom moral e SEM safeToSpend
//    pessoal (o VA é um domínio restrito próprio).
//  * Recarga é do dia em que cai. Se hoje é o dia e ela ainda não caiu → DUE_TODAY (sem ritmo, sem chute);
//    se a data já passou e não caiu → LATE.
//  * "Guardar sobra" é uma SIMULAÇÃO explícita: reserva = RESERVE_PERCENT do saldo (não é configuração do
//    usuário, não é gravada).
// ============================================================================
export const DAY_MS = 86400000;
export const RESERVE_PERCENT = 10;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const daysBetweenMs = (fromMs, toMs) => Math.round((toMs - fromMs) / DAY_MS);

// occurrenceMs: datas (ms UTC-meia-noite) das ocorrências da regra ao redor de hoje, em ordem crescente.
// realizedMs: ocorrências já realizadas (recarga que de fato caiu). Retorna o ciclo corrente.
export function resolveRechargeCycle({ occurrenceMs, realizedMs = [], todayMs }) {
  const occ = [...occurrenceMs].sort((a, b) => a - b);
  const realizedPast = realizedMs.filter((m) => m <= todayMs).sort((a, b) => a - b);
  let last = null;
  let next = null;
  if (realizedPast.length) {
    last = realizedPast[realizedPast.length - 1];
    next = occ.find((m) => m > last) ?? null;
  } else {
    next = occ.find((m) => m >= todayMs) ?? null;
    last = next != null ? [...occ].reverse().find((m) => m < next) ?? null : null;
  }
  if (next == null) return { state: "UNKNOWN", lastRechargeMs: last, nextRechargeMs: null, daysLeft: null, elapsed: null, cycleLength: null };
  const daysLeft = daysBetweenMs(todayMs, next);
  const state = daysLeft > 0 ? "NORMAL" : daysLeft === 0 ? "DUE_TODAY" : "LATE";
  return {
    state,
    lastRechargeMs: last,
    nextRechargeMs: next,
    daysLeft,
    elapsed: last != null ? Math.max(0, daysBetweenMs(last, todayMs)) : null,
    cycleLength: last != null ? daysBetweenMs(last, next) : null,
  };
}

// Ritmo por modo. balance/reserve em reais. weekendDays = dias de fim de semana DENTRO do período.
export function computePacing({ balance, daysLeft, mode = "eq", weekendReserve = 0, weekendDays = 0 }) {
  if (!(daysLeft > 0)) return { status: "NO_PERIOD", daily: null, days: 0 };
  const bal = Math.max(0, Number(balance) || 0);
  if (bal <= 0) return { status: "NO_BALANCE", daily: 0, days: daysLeft };
  if (mode === "save") {
    const reserve = r2((bal * RESERVE_PERCENT) / 100);
    return { status: "OK", daily: r2((bal - reserve) / daysLeft), days: daysLeft, reserve };
  }
  if (mode === "wk") {
    const wk = Math.min(bal, Math.max(0, weekendReserve));
    const rest = daysLeft - weekendDays;
    if (rest <= 0) return { status: "NO_REST_DAYS", daily: null, days: daysLeft, weekendReserve: wk, restDays: 0 };
    return { status: "OK", daily: r2((bal - wk) / rest), days: daysLeft, weekendReserve: wk, restDays: rest };
  }
  return { status: "OK", daily: r2(bal / daysLeft), days: daysLeft };
}

// Próximo fim de semana (sábado e domingo) ESTRITAMENTE depois de hoje, no dia local. `weekendDays` conta
// só os dias que caem antes da próxima recarga (o dia da recarga não entra no período).
export function nextWeekend({ todayMs, nextRechargeMs }) {
  const dow = new Date(todayMs).getUTCDay(); // 0 dom … 6 sáb
  const toSat = ((6 - dow + 7) % 7) || 7; // primeiro sábado > hoje
  const satMs = todayMs + toSat * DAY_MS;
  const sunMs = satMs + DAY_MS;
  const inPeriod = (ms) => nextRechargeMs == null || ms < nextRechargeMs;
  const weekendDays = (inPeriod(satMs) ? 1 : 0) + (inPeriod(sunMs) ? 1 : 0);
  return { satMs, sunMs, weekendDays, available: weekendDays > 0 };
}

// Faixa do slider derivada do saldo e do ritmo (nunca constante): até 4x um fim de semana "normal", nunca acima
// do saldo. Padrão = um fim de semana no ritmo (2 dias), arredondado ao passo.
export function weekendSliderRange({ balance, dailyEq, weekendDays = 2, step = 10 }) {
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  const normal = Math.max(0, (Number(dailyEq) || 0) * weekendDays);
  const max = Math.min(bal, Math.max(step, Math.ceil((normal * 4) / step) * step));
  const min = 0;
  const def = Math.min(max, Math.round(normal / step) * step);
  return { min, max: Math.floor(max / step) * step, step, default: def, normalWeekend: r2(normal) };
}

export function weekendPlan({ balance, daysLeft, weekendDays, reserve }) {
  const bal = Math.max(0, Number(balance) || 0);
  const wk = Math.min(bal, Math.max(0, Number(reserve) || 0));
  const restDays = Math.max(0, daysLeft - weekendDays);
  return {
    reserve: wk,
    remainingBalance: r2(bal - wk),
    restDays,
    restDaily: restDays > 0 ? r2((bal - wk) / restDays) : null,
    shareOfBalance: bal > 0 ? Math.round((wk / bal) * 100) : 0,
  };
}
