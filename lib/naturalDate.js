import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";
import { nextOccurrence, startOfDay } from "./recurringCycles.js";

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
