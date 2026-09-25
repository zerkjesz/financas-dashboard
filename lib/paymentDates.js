import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { DomainError } from "./domainErrors.js";

// Fase 9.1 — "Quando?" do sheet de pagamento: "hoje" | "ontem" | "AAAA-MM-DD" (Outra data).
// Sempre resolvido na timezone do app (nunca a data-calendário UTC crua do servidor) e devolvido
// como meia-noite UTC do dia local — a mesma convenção de todo Expense/Transfer do Norte.
// Data futura é recusada: pagamento é um fato já ocorrido.
export function resolvePaymentDate(when = "hoje", now = new Date(), timeZone = getAppTimezone()) {
  const today = localCalendarDateAsUtcMidnight(now, timeZone);
  const key = typeof when === "string" ? when.trim().toLowerCase() : "hoje";
  if (key === "hoje" || key === "") return today;
  if (key === "ontem") return new Date(today.getTime() - 86400000);
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new DomainError("INVALID", "Data inválida. Use hoje, ontem ou AAAA-MM-DD.");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new DomainError("INVALID", "Data inexistente.");
  if (date.getTime() > today.getTime()) throw new DomainError("INVALID", "A data do pagamento não pode ser no futuro.");
  return date;
}

// Instante gravado em Expense/Transfer.occurredAt. Pagamento de HOJE grava o instante real (`now`),
// não a meia-noite: o saldo de conta só conta movimento com occurredAt > última âncora
// (BalanceAdjustment), e uma âncora criada hoje ficaria DEPOIS de "hoje 00:00" — o pagamento não
// baixaria o saldo. Datas passadas seguem à meia-noite (já refletidas em âncora posterior).
export function resolvePaymentInstant(when = "hoje", now = new Date(), timeZone = getAppTimezone()) {
  const date = resolvePaymentDate(when, now, timeZone);
  const today = localCalendarDateAsUtcMidnight(now, timeZone);
  return date.getTime() === today.getTime() ? new Date(now) : date;
}

// "2026-09" da competência corrente no fuso do app.
export function currentMonthKey(now = new Date(), timeZone = getAppTimezone()) {
  const d = localCalendarDateAsUtcMidnight(now, timeZone);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthBounds(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function addMonthsToKey(monthKey, n) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const LONG = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const ABBR = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
export function monthLongName(monthKey) {
  return LONG[Number(monthKey.split("-")[1]) - 1];
}
export function monthLabelShort(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${ABBR[m - 1]}/${String(y).slice(2)}`;
}
export function monthLongWithYear(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${LONG[m - 1].toLowerCase()} de ${y}`;
}
