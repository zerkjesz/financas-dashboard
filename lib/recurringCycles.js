// Exportada (Fase 4.0) — vira a base compartilhada de lib/financialCycle.js e
// lib/cardCycle.js, em vez de cada um reimplementar "dia X clampado dentro do
// mês" por conta própria. Sozinha, já resolve "mês curto quando o dia configurado
// excede os dias do mês" (ex: dia 31 em fevereiro vira 28/29).
export function clampToMonth(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
}

// Próxima ocorrência de `dayOfMonth` a partir de (e incluindo) `fromDate`.
export function nextOccurrence(dayOfMonth, fromDate = new Date()) {
  const year = fromDate.getUTCFullYear();
  const month = fromDate.getUTCMonth();
  const thisMonth = clampToMonth(year, month, dayOfMonth);
  if (thisMonth >= startOfDay(fromDate)) return thisMonth;
  return clampToMonth(year, month + 1, dayOfMonth);
}

// Todas as ocorrências de `dayOfMonth` estritamente depois de `sinceDate` e até (e incluindo) `untilDate`.
export function occurrencesBetween(dayOfMonth, sinceDate, untilDate) {
  const results = [];
  let cursor = clampToMonth(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth(), dayOfMonth);
  if (cursor <= sinceDate) {
    cursor = clampToMonth(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth() + 1, dayOfMonth);
  }
  while (cursor <= untilDate) {
    results.push(cursor);
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    cursor = clampToMonth(y, m + 1, dayOfMonth);
  }
  return results;
}

export function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function daysBetween(fromDate, toDate) {
  const ms = startOfDay(toDate) - startOfDay(fromDate);
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
