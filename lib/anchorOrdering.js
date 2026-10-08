// Fase 10.4 — ORDENAÇÃO TEMPORAL de âncoras (saldo de conta / limite do cartão) × lançamentos de data-calendário.
//
// O app guarda de dois jeitos: INSTANTES reais (pagamentos "marcar como pago") e DATAS-CALENDÁRIO como meia-noite UTC do DIA LOCAL
// (convenção de todo lançamento "de hoje" do Telegram/manual — ver lib/appTimezone.js:localCalendarDateAsUtcMidnight).
// Uma âncora é gravada como instante. Quando ela representa "fim do dia local" (ex.: 07/10 23:59:59 America/Sao_Paulo = 08/10 02:59:59Z),
// o instante já caiu no dia UTC seguinte: um lançamento-calendário do dia 08/10 local (00:00Z de 08/10) ficaria ANTES do instante da âncora
// e o filtro "occurredAt > âncora" o descartaria — um lançamento que, na realidade, aconteceu DEPOIS do saldo observado.
//
// Regra (retrocompatível): além de `occurredAt > âncora`, conta também o lançamento-calendário (exatamente 00:00:00.000Z) cujo DIA
// calendário é posterior ao dia LOCAL da âncora. A janela extra só existe quando a âncora está entre ~21h e 24h locais; para qualquer
// outra âncora (todas as existentes hoje) `anchorExtraWindow` devolve null e o comportamento anterior é idêntico.
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { money, addMoney } from "./money.js";

export const isCalendarDate = (d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

// { gte, lte } dentro do qual lançamentos-calendário contam como POSTERIORES à âncora — ou null (sem janela extra).
export function anchorExtraWindow(anchorAt, timeZone = getAppTimezone()) {
  if (!anchorAt) return null;
  const localDayStart = localCalendarDateAsUtcMidnight(anchorAt, timeZone); // meia-noite UTC do dia local da âncora
  const nextCalendarDay = new Date(localDayStart.getTime() + 86400000);
  return nextCalendarDay <= anchorAt ? { gte: nextCalendarDay, lte: anchorAt } : null;
}

// Soma `field` das linhas de `delegate` (ex.: client.expense) em `where` cujo `dateField` cai na janela extra E é data-calendário.
export async function sumCalendarExtras(delegate, where, win, { dateField = "occurredAt", field = "amount" } = {}) {
  if (!win) return money(0);
  const rows = await delegate.findMany({ where: { ...where, [dateField]: win }, select: { [field]: true, [dateField]: true } });
  return rows.filter((r) => isCalendarDate(r[dateField])).reduce((acc, r) => addMoney(acc, r[field]), money(0));
}

// Esta data/instante conta como POSTERIOR à âncora? (mesma regra aplicada pelas consultas de saldo/limite)
export function isAfterAnchor(occurredAt, anchorAt, timeZone = getAppTimezone()) {
  if (!anchorAt) return true;
  if (occurredAt > anchorAt) return true;
  const win = anchorExtraWindow(anchorAt, timeZone);
  return !!win && isCalendarDate(occurredAt) && occurredAt >= win.gte && occurredAt <= win.lte;
}
