// ============================================================================
// Fase 10.3 — PERÍODO do Data Hub (export / preview / escopo do REPLACE).
//
// Presets (todos resolvidos no fuso oficial do app, nunca no UTC cru):
//   current_cycle      ciclo financeiro atual 24→23 (reutiliza lib/financialCycle.js — nenhuma regra nova)
//   previous_cycle     ciclo imediatamente anterior
//   last_30_days       rolling: hoje−29 → hoje (30 dias corridos)
//   last_90_days       rolling: hoje−89 → hoje
//   this_year          01/01 do ano atual → hoje
//   since_norte_start  24/08/2026 → hoje (marco operacional; DIFERENTE de all_time)
//   all_time           SEM filtro cronológico: todo o universo exportável
//   custom             dateFrom + dateTo (dateFrom <= dateTo)
//
// DATA ECONÔMICA: o app guarda datas de calendário de duas formas — meia-noite UTC ("2026-10-05T00:00:00Z") e
// meia-noite local ("…T03:00:00Z"); pagamentos usam o instante real. `economicDayKey` aplica a MESMA convenção do
// resto do app: instante exatamente à meia-noite UTC = a data UTC; qualquer outro = o dia LOCAL.
// Intervalo é sempre INCLUSIVO nas duas pontas, em dias.
// ============================================================================
import { getAppTimezone } from "../appTimezone.js";
import { getFinancialCycleForDate, resolveCurrentCycle, describeCycle } from "../financialCycle.js";

export const RANGE_PRESETS = Object.freeze({
  CURRENT_CYCLE: "current_cycle",
  PREVIOUS_CYCLE: "previous_cycle",
  LAST_30_DAYS: "last_30_days",
  LAST_90_DAYS: "last_90_days",
  THIS_YEAR: "this_year",
  SINCE_NORTE_START: "since_norte_start",
  ALL_TIME: "all_time",
  CUSTOM: "custom",
});
export const PRESET_ORDER = Object.values(RANGE_PRESETS);
export const PRESET_LABEL = Object.freeze({
  current_cycle: "Ciclo atual",
  previous_cycle: "Ciclo anterior",
  last_30_days: "Últimos 30 dias",
  last_90_days: "Últimos 90 dias",
  this_year: "Este ano",
  since_norte_start: "Desde o início do Norte",
  all_time: "Período todo",
  custom: "Personalizado",
});
export const PRESET_SHORT = Object.freeze({ current_cycle: "Ciclo atual", previous_cycle: "Ciclo anterior", last_30_days: "30 dias", last_90_days: "90 dias", this_year: "Este ano", since_norte_start: "Desde o início", all_time: "Período todo", custom: "Personalizado" });
export const DEFAULT_PRESET = RANGE_PRESETS.CURRENT_CYCLE;
export const NORTE_START_DATE = "2026-08-24";
export const DAY_MS = 86400000;
const MIN_DATE = "2000-01-01";
const MAX_DATE = "2100-12-31";

export class DataRangeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DataRangeError";
    this.code = code;
  }
}

// ---------- datas ----------
const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcDay = (key) => new Date(`${key}T00:00:00.000Z`);

// "YYYY-MM-DD" ou "DD/MM/AAAA" -> "YYYY-MM-DD" válido (com checagem de calendário real: 31/02 é inválido).
export function normalizeDayInput(value) {
  const s = String(value ?? "").trim();
  let y, m, d;
  let mt = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mt) [y, m, d] = [mt[1], mt[2], mt[3]].map(Number);
  else if ((mt = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) [d, m, y] = [mt[1], mt[2], mt[3]].map(Number);
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dayKey(dt);
}
export const formatDayBR = (key) => (key ? `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}` : "");

const fmtCache = new Map();
function localDayFormatter(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return fmtCache.get(tz);
}
export function localDayKey(instant, tz = getAppTimezone()) {
  return localDayFormatter(tz).format(instant instanceof Date ? instant : new Date(instant));
}
export function economicDayKey(value, tz = getAppTimezone()) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) return dayKey(d);
  return localDayKey(d, tz);
}

// ---------- resolução ----------
// settings: AppSettings (cycleStartDay). now: instante. Retorna o objeto "range" usado por tudo (serializável).
export function resolveRange({ preset = DEFAULT_PRESET, dateFrom, dateTo, now = new Date(), settings, timeZone = getAppTimezone() } = {}) {
  if (!PRESET_ORDER.includes(preset)) throw new DataRangeError(`Período desconhecido: ${preset}`, "RANGE_UNKNOWN_PRESET");
  const todayKey = localDayKey(now, timeZone);
  const today = utcDay(todayKey);
  const shift = (d, n) => new Date(d.getTime() + n * DAY_MS);
  let from = null;
  let to = null;
  let cycle = null;

  if (preset === RANGE_PRESETS.ALL_TIME) {
    // sem filtro: nenhum estado anterior (dateFrom/dateTo recebidos) é herdado
  } else if (preset === RANGE_PRESETS.CURRENT_CYCLE) {
    cycle = resolveCurrentCycle({ now, settings, timeZone });
    [from, to] = [cycle.start, cycle.end];
  } else if (preset === RANGE_PRESETS.PREVIOUS_CYCLE) {
    const cur = resolveCurrentCycle({ now, settings, timeZone });
    cycle = describeCycle(getFinancialCycleForDate(shift(cur.start, -1), { cycleStartDay: settings?.cycleStartDay ?? 24 }));
    [from, to] = [cycle.start, cycle.end];
  } else if (preset === RANGE_PRESETS.LAST_30_DAYS) [from, to] = [shift(today, -29), today];
  else if (preset === RANGE_PRESETS.LAST_90_DAYS) [from, to] = [shift(today, -89), today];
  else if (preset === RANGE_PRESETS.THIS_YEAR) [from, to] = [new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), today];
  else if (preset === RANGE_PRESETS.SINCE_NORTE_START) [from, to] = [utcDay(NORTE_START_DATE), today > utcDay(NORTE_START_DATE) ? today : utcDay(NORTE_START_DATE)];
  else {
    // custom
    if (!dateFrom || !dateTo) throw new DataRangeError("Informe a data inicial e a data final.", "RANGE_REQUIRED");
    const f = normalizeDayInput(dateFrom);
    const t = normalizeDayInput(dateTo);
    if (!f || !t) throw new DataRangeError("Data inválida. Use DD/MM/AAAA.", "RANGE_INVALID_DATE");
    if (f < MIN_DATE || t > MAX_DATE) throw new DataRangeError(`As datas precisam estar entre ${formatDayBR(MIN_DATE)} e ${formatDayBR(MAX_DATE)}.`, "RANGE_OUT_OF_BOUNDS");
    if (f > t) throw new DataRangeError("A data inicial não pode ser depois da data final.", "RANGE_ORDER");
    [from, to] = [utcDay(f), utcDay(t)];
  }

  const allTime = preset === RANGE_PRESETS.ALL_TIME;
  return {
    preset,
    label: PRESET_LABEL[preset],
    allTime,
    dateFrom: from ? dayKey(from) : null,
    dateTo: to ? dayKey(to) : null,
    financialCycleStart: cycle ? dayKey(cycle.start) : null,
    financialCycleEnd: cycle ? dayKey(cycle.end) : null,
    timezone: timeZone,
    today: todayKey,
  };
}

// Reconstrói um range a partir de metadados já salvos (arquivo importado / plano guardado) — sem recalcular presets.
export function rangeFromBounds({ preset = RANGE_PRESETS.CUSTOM, dateFrom, dateTo, timeZone = getAppTimezone() } = {}) {
  if (preset === RANGE_PRESETS.ALL_TIME && !dateFrom && !dateTo) return { preset, label: PRESET_LABEL[preset], allTime: true, dateFrom: null, dateTo: null, financialCycleStart: null, financialCycleEnd: null, timezone: timeZone };
  const f = normalizeDayInput(dateFrom);
  const t = normalizeDayInput(dateTo);
  if (!f || !t || f > t) throw new DataRangeError("Período do arquivo inválido.", "RANGE_INVALID_DATE");
  return { preset, label: PRESET_LABEL[preset] ?? "Personalizado", allTime: false, dateFrom: f, dateTo: t, financialCycleStart: null, financialCycleEnd: null, timezone: timeZone };
}

export const describeRange = (range) => (range.allTime ? "Todo o histórico (sem filtro de datas)" : `${formatDayBR(range.dateFrom)} → ${formatDayBR(range.dateTo)}`);

export function dayInRange(range, key) {
  if (range.allTime) return true;
  if (!key) return false;
  return key >= range.dateFrom && key <= range.dateTo;
}
export function dateInRange(range, value, tz = range.timezone ?? getAppTimezone()) {
  if (range.allTime) return true;
  return dayInRange(range, economicDayKey(value, tz));
}

// Janela larga para PRÉ-FILTRO no banco (2 dias de folga em cada ponta cobrem as duas convenções de data + fuso);
// o corte exato é sempre feito depois por economicDayKey.
export function dbWindow(range) {
  if (range.allTime) return null;
  return { gte: new Date(utcDay(range.dateFrom).getTime() - 2 * DAY_MS), lt: new Date(utcDay(range.dateTo).getTime() + 3 * DAY_MS) };
}

// Competências (YYYY-MM) tocadas pelo período — para entidades por competência (parcelas).
export function monthsOfRange(range) {
  if (range.allTime) return null;
  const out = new Set();
  let [y, m] = range.dateFrom.split("-").map(Number);
  const [ty, tm] = range.dateTo.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.add(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// ============================================================================
// SEMÂNTICA DE DATA POR ENTIDADE (EXPORT_DATE_SEMANTICS_BY_ENTITY). Nunca createdAt por conveniência.
//   kind "date"   — filtra pelo campo `field` (e `fallback` se nulo); sem nenhuma data => NO_EVENT_DATE (incluída)
//   kind "month"  — competência (billMonth) dentro dos meses do período
//   kind "global" — estado/cadastro sem data de evento: sempre incluído (GLOBAL_STATE)
// ============================================================================
export const EXPORT_DATE_SEMANTICS = Object.freeze({
  incomes: { kind: "date", field: "occurredAt", note: "data da receita" },
  expenses: { kind: "date", field: "occurredAt", note: "data da despesa" },
  transfers: { kind: "date", field: "occurredAt", note: "data da transferência" },
  balanceAdjustments: { kind: "date", field: "occurredAt", note: "data do ajuste de saldo" },
  cardLimitUpdates: { kind: "date", field: "occurredAt", note: "data da observação do limite" },
  purchases: { kind: "date", field: "purchasedAt", note: "data da compra" },
  installments: { kind: "month", field: "billMonth", note: "competência (mês da fatura) da parcela" },
  cardBills: { kind: "date", field: "dueAt", note: "vencimento da fatura" },
  bills: { kind: "date", field: "dueDate", fallback: ["paidAt"], note: "vencimento; sem vencimento, data do pagamento; sem nenhuma, NO_EVENT_DATE" },
  reserveMovements: { kind: "date", field: "occurredAt", note: "data do movimento" },
  externalInstallments: { kind: "date", field: "dueDate", fallback: ["paidAt"], note: "vencimento; parcela 'após a próxima renda' (sem data) usa o pagamento, ou NO_EVENT_DATE" },
  confirmedCommitments: { kind: "date", field: "dueDate", note: "vencimento; compromisso sem prazo (ex.: dinheiro separado) é NO_EVENT_DATE e entra em qualquer recorte" },
  receivables: { kind: "date", field: "expectedDate", note: "data esperada; sem data, NO_EVENT_DATE" },
  categoryBudgets: { kind: "date", field: "cycleStart", note: "início do ciclo do orçamento" },
  cardCreditMovements: { kind: "date", field: "occurredAt", note: "data do movimento" },
  legacyTransactions: { kind: "date", field: "occurredAt", note: "data da transação legada" },
  accounts: { kind: "global", note: "cadastro (GLOBAL_STATE)" },
  cards: { kind: "global", note: "cadastro (GLOBAL_STATE)" },
  recurringRules: { kind: "global", note: "regra recorrente (GLOBAL_STATE)" },
  goals: { kind: "global", note: "meta (GLOBAL_STATE)" },
  reserves: { kind: "global", note: "reserva (GLOBAL_STATE)" },
  externalInstallmentPlans: { kind: "global", note: "plano de parcelamento externo (GLOBAL_STATE)" },
  contingencies: { kind: "global", note: "contingência (GLOBAL_STATE)" },
  appSettings: { kind: "global", note: "configuração (GLOBAL_STATE)" },
});

export const ROW_CLASS = Object.freeze({ IN_RANGE: "IN_RANGE", OUT: "OUT_OF_RANGE", GLOBAL_STATE: "GLOBAL_STATE", NO_EVENT_DATE: "NO_EVENT_DATE" });

export function classifyRow(sheetKey, row, range, months = monthsOfRange(range)) {
  const sem = EXPORT_DATE_SEMANTICS[sheetKey] ?? { kind: "global" };
  if (range.allTime) return sem.kind === "global" ? ROW_CLASS.GLOBAL_STATE : ROW_CLASS.IN_RANGE;
  if (sem.kind === "global") return ROW_CLASS.GLOBAL_STATE;
  if (sem.kind === "month") {
    const v = row[sem.field];
    if (!v) return ROW_CLASS.NO_EVENT_DATE;
    return months.has(String(v)) ? ROW_CLASS.IN_RANGE : ROW_CLASS.OUT;
  }
  for (const f of [sem.field, ...(sem.fallback ?? [])]) {
    const v = row[f];
    if (v != null) return dateInRange(range, v) ? ROW_CLASS.IN_RANGE : ROW_CLASS.OUT;
  }
  return ROW_CLASS.NO_EVENT_DATE;
}

// Filtra as linhas de UMA aba e devolve também a contagem por classe.
export function filterSheetRows(sheetKey, rows, range) {
  const months = monthsOfRange(range);
  const counts = { total: rows.length, included: 0, inRange: 0, globalState: 0, noEventDate: 0, excluded: 0 };
  const kept = [];
  for (const row of rows) {
    const c = classifyRow(sheetKey, row, range, months);
    if (c === ROW_CLASS.OUT) { counts.excluded++; continue; }
    kept.push(row);
    counts.included++;
    if (c === ROW_CLASS.IN_RANGE) counts.inRange++;
    else if (c === ROW_CLASS.GLOBAL_STATE) counts.globalState++;
    else counts.noEventDate++;
  }
  return { rows: kept, counts };
}

// nome de arquivo: norte-all-time-2026-10-07.xlsx | norte-cycle-2026-09-24_2026-10-23.xlsx | norte-custom-…
export function rangeFileName(range, now = new Date()) {
  const today = localDayKey(now, range.timezone ?? getAppTimezone());
  const slug = { current_cycle: "cycle", previous_cycle: "cycle", last_30_days: "last-30-days", last_90_days: "last-90-days", this_year: "this-year", since_norte_start: "since-norte-start", all_time: "all-time", custom: "custom" }[range.preset];
  if (range.allTime) return `norte-${slug}-${today}.xlsx`;
  if (range.preset === "last_30_days" || range.preset === "last_90_days" || range.preset === "this_year") return `norte-${slug}-${today}.xlsx`;
  return `norte-${slug}-${range.dateFrom}_${range.dateTo}.xlsx`;
}
