import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";
import { nextOccurrence, startOfDay } from "./recurringCycles.js";
import { localCalendarDateAsUtcMidnight } from "./appTimezone.js";

const WEEKDAYS = {
  domingo: 0,
  segunda: 1,
  "segunda-feira": 1,
  terca: 2,
  "terca-feira": 2,
  quarta: 3,
  "quarta-feira": 3,
  quinta: 4,
  "quinta-feira": 4,
  sexta: 5,
  "sexta-feira": 5,
  sabado: 6,
};

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function nextWeekday(targetDow, from) {
  let cursor = addDays(startOfDay(from), 1);
  while (cursor.getUTCDay() !== targetDow) {
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

function lastDayOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function sameDayNextMonth(date) {
  const day = date.getUTCDate();
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), Math.min(day, lastDay)));
}

// Datas relativas/literais, sem depender do banco. Retorna Date ou null se não reconhecer nada.
export function parseNaturalDate(rawMessage, now = new Date()) {
  const text = normalize(rawMessage);
  const today = startOfDay(now);

  if (/depois de amanha/.test(text)) return addDays(today, 2);
  if (/\bamanha\b/.test(text)) return addDays(today, 1);
  if (/\bhoje\b/.test(text)) return today;
  if (/fim do mes/.test(text)) return lastDayOfMonth(today);
  if (/mes que vem/.test(text) && !/dia\s*\d{1,2}/.test(text)) return sameDayNextMonth(today);

  const dayMatch = text.match(/\bdia\s*(\d{1,2})\b/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    if (day >= 1 && day <= 31) return nextOccurrence(day, today);
  }

  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (text.includes(name)) return nextWeekday(dow, today);
  }

  return null;
}

// Datas "ancoradas" em receitas recorrentes (próximo salário, próximo VA) — precisa do banco.
export async function parseAnchoredDate(rawMessage) {
  const text = normalize(rawMessage);
  const now = new Date();

  if (/(proximo |proxima )?sal[aá]rio/i.test(rawMessage) || /salario/.test(text)) {
    const rule = await prisma.recurringRule.findFirst({ where: { kind: "income", name: { contains: "sal" } } });
    if (rule) return nextOccurrence(rule.dayOfMonth, now);
  }

  if (/vale alimenta|\bva\b/.test(text)) {
    const rule = await prisma.recurringRule.findFirst({ where: { kind: "income", name: { contains: "Alimenta" } } });
    if (rule) return nextOccurrence(rule.dayOfMonth, now);
  }

  return null;
}

// Tenta primeiro data literal/relativa, depois ancorada em receita recorrente.
export async function resolveDate(rawMessage) {
  const literal = parseNaturalDate(rawMessage);
  if (literal) return literal;
  return parseAnchoredDate(rawMessage);
}

// ============================================================================
// Fase 5.3D — DATA ECONÔMICA (quando o FATO aconteceu), separada de propósito
// de parseNaturalDate/resolveDate acima (que resolvem DATA DE VENCIMENTO —
// sempre pra FRENTE: "vence sábado" = o próximo sábado). Um gasto/receita
// relatado como "ontem"/"sábado" é o OPOSTO: sempre pra TRÁS — item 20 do
// pedido, "não interpretar 'sábado' como o próximo sábado futuro pra uma
// Expense passada". As duas funções deliberadamente NÃO compartilham a
// resolução de weekday por isso.
// ============================================================================

function lastWeekdayOnOrBefore(targetDow, today) {
  let cursor = today;
  while (cursor.getUTCDay() !== targetDow) {
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

// "dia DD"/"DD/MM"/"DD/MM/AAAA" pra trás no tempo: se o dia informado (no mês
// atual, sem ano explícito) ainda não chegou este mês, assume o mês anterior
// — nunca uma data futura pra um fato que já aconteceu.
function lastOccurrenceOfDayOfMonth(day, month, today) {
  const year = today.getUTCFullYear();
  const candidateMonth = month != null ? month - 1 : today.getUTCMonth();
  let candidate = new Date(Date.UTC(year, candidateMonth, day));
  if (month == null && candidate > today) {
    // só dia informado (sem mês): se ainda não chegou este mês, é do mês passado.
    candidate = new Date(Date.UTC(year, candidateMonth - 1, day));
  }
  return candidate;
}

// Marcadores deliberadamente vagos — NUNCA resolvidos numa data específica
// (item 21/24): "semana passada" pode ser qualquer um de 7 dias, "mês
// passado" qualquer um de ~30, e — crítico — podem cair antes OU depois do
// snapshot observado do Itaú (2026-09-04T23:20:26Z) sem informação
// suficiente pra saber qual. Adivinhar aqui seria inventar um fato.
const AMBIGUOUS_ECONOMIC_MARKERS = [
  "semana passada", "mes passado", "esses dias", "essa semana",
  "esse mes", "no comeco do mes", "esses tempos", "ha um tempo",
  "recentemente", "esses tempos atras", "uns dias atras", "uns tempos atras",
];

export const ECONOMIC_DATE_STATUS = Object.freeze({
  TODAY: "TODAY", // sem marcador nenhum — item 22: ausência de marcador = hoje.
  RESOLVED: "RESOLVED", // marcador claro e determinístico.
  AMBIGUOUS: "AMBIGUOUS", // marcador vago — NUNCA resolvido sozinho, precisa de clarification.
});

// resolveEconomicDate(rawMessage, now) -> { status, date?, marker? }
// PURA — não lê o banco (diferente de resolveDate/parseAnchoredDate acima,
// que são pra vencimento futuro e podem consultar RecurringRule).
//
// Fase 5.3D.1, itens 6-10 — "hoje" é a data-calendário LOCAL (timezone do
// app, lib/appTimezone.js), nunca a data UTC crua do servidor. Bug real
// corrigido: `startOfDay(now)` (usada aqui até a Fase 5.3D) trunca pelo
// getUTCDate() do instant — pra qualquer horário à noite num fuso negativo
// (Brasil, UTC-3), isso já pode ser o dia SEGUINTE em UTC, fazendo "ontem"
// resolver pro dia ERRADO bem na janela ~21h-23h59 local todo santo dia.
// `parseNaturalDate`/`resolveDate` (vencimento FUTURO, usadas por
// create_bill/wizard) continuam com o comportamento antigo de propósito —
// mesma classe de bug, mas fora do escopo desta fase (item 13 do pedido:
// STOP antes de mudança ampla; só a data ECONÔMICA do Telegram é corrigida
// aqui). Ver relatório da Fase 5.3D.1 pro carry-over documentado.
export function resolveEconomicDate(rawMessage, now = new Date(), timeZone = undefined) {
  const text = normalize(rawMessage);
  const today = timeZone ? localCalendarDateAsUtcMidnight(now, timeZone) : localCalendarDateAsUtcMidnight(now);

  for (const marker of AMBIGUOUS_ECONOMIC_MARKERS) {
    if (text.includes(marker)) return { status: ECONOMIC_DATE_STATUS.AMBIGUOUS, marker };
  }

  if (/anteontem/.test(text)) return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: addDays(today, -2), marker: "anteontem" };
  if (/\bontem\b/.test(text)) return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: addDays(today, -1), marker: "ontem" };
  if (/\bhoje\b/.test(text)) return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: today, marker: "hoje" };

  // DD/MM/AAAA ou DD/MM — sempre uma data EXATA e explícita, nunca ambígua.
  const fullDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (fullDateMatch) {
    const [, d, m, y] = fullDateMatch;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: new Date(Date.UTC(year, Number(m) - 1, Number(d))), marker: fullDateMatch[0] };
  }
  const shortDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (shortDateMatch) {
    const [, d, m] = shortDateMatch;
    return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: lastOccurrenceOfDayOfMonth(Number(d), Number(m), today), marker: shortDateMatch[0] };
  }

  const dayMatch = text.match(/\bdia\s*(\d{1,2})\b/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    if (day >= 1 && day <= 31) return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: lastOccurrenceOfDayOfMonth(day, null, today), marker: dayMatch[0] };
  }

  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (text.includes(name)) return { status: ECONOMIC_DATE_STATUS.RESOLVED, date: lastWeekdayOnOrBefore(dow, today), marker: name };
  }

  return { status: ECONOMIC_DATE_STATUS.TODAY, date: today };
}

// Marcadores de passado usados só pra detectar "isso parece um FATO
// histórico" em contextos onde não há uma data econômica de verdade a
// registrar (ex: balance_adjustment — item 27: "meu saldo é X" é uma
// observação DE AGORA por definição; "meu saldo ERA X ontem" é outra coisa,
// que o produto não suporta hoje — nunca vira um BalanceAdjustment retroativo
// inventado).
const PAST_TENSE_MARKERS = ["ontem", "anteontem", "semana passada", "mes passado", "era", "estava"];
export function mentionsPastTense(rawMessage) {
  const text = normalize(rawMessage);
  return PAST_TENSE_MARKERS.some((m) => text.includes(m));
}
