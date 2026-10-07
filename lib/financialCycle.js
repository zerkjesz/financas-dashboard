import { clampToMonth, startOfDay } from "./recurringCycles.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";

// Fase 4.0 — ciclo financeiro pessoal, fonte de configuração: AppSettings.cycleStartDay
// (24 hoje). Puramente determinístico — todas as funções recebem `settings` e uma
// data, nunca leem o banco sozinhas. Trabalha em granularidade de DATA (UTC meia-
// noite), nunca hora exata — coerente com o resto do app (ver lib/recurringCycles.js)
// e evita timezone hardcoded desnecessário: tudo aqui é `Date.UTC(...)`, nunca
// `new Date(ano, mes, dia)` local nem strings sem fuso.
//
// Convenção de boundary (decisão explícita, Fase 4.0, item 1): um dia cujo
// dia-do-mês é EXATAMENTE cycleStartDay pertence ao ciclo que COMEÇA nesse dia (não
// ao ciclo anterior, que termina no dia anterior). Ex: cycleStartDay=24 →
// 23/09 pertence ao ciclo [24/08, 23/09]; 24/09 já pertence ao ciclo [24/09, 23/10].

// Ciclo (janela [start, end], ambos inclusive) que contém `date`.
export function getFinancialCycleForDate(date, settings) {
  const cycleStartDay = settings.cycleStartDay;
  const day = date.getUTCDate();
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  if (day < cycleStartDay) month -= 1; // ainda não chegou o início deste mês -> pertence ao ciclo do mês anterior

  const start = clampToMonth(year, month, cycleStartDay);
  const nextStart = clampToMonth(year, month + 1, cycleStartDay);
  const end = new Date(nextStart.getTime() - 24 * 60 * 60 * 1000); // um dia antes do próximo início
  return { start, end };
}

export function getCurrentFinancialCycle(settings, now = new Date()) {
  return getFinancialCycleForDate(startOfDay(now), settings);
}

// O dia logo depois que o ciclo ATUAL termina — sempre o início do PRÓXIMO ciclo
// de CALENDÁRIO relativo a `now`, nunca o início do ciclo que já contém `now`
// (mesmo se `now` for exatamente o cycleStartDay).
//
// Fase 4.0.1 — IMPORTANTE, correção de uma confusão conceitual da Fase 4.0: isto
// é só mecânica de CALENDÁRIO ("quando começa o próximo ciclo, pelo relógio").
// NÃO é "quando cai a próxima renda de verdade" — essas são perguntas diferentes.
// Um ciclo pode começar no dia certo (cycleStartDay) sem que o salário daquele
// dia tenha sido efetivamente registrado como Income real; nesse caso a renda
// esperada continua pendente/overdue, não "pula" pro ciclo seguinte só porque o
// calendário virou. Essa segunda pergunta (renda esperada de verdade, considerando
// se a ocorrência já foi realizada) é responsabilidade de lib/incomeHorizon.js —
// NUNCA desta função. financialCycle.js fica deliberadamente restrito a
// calendário/ciclo puro: getFinancialCycleForDate/getCurrentFinancialCycle/
// getNextCycleStart, nada de "próxima renda" aqui (a antiga getNextIncomeDate
// foi removida por isso — não existe mais um sinônimo tentador pra usar errado).
export function getNextCycleStart(settings, now = new Date()) {
  const current = getCurrentFinancialCycle(settings, now);
  return new Date(current.end.getTime() + 24 * 60 * 60 * 1000);
}

// ============================================================================
// Fase 10.2 — CICLO != COMPETÊNCIA.
//   * CICLO FINANCEIRO (24→23): a janela que UM salário financia. Ciclo 24/09→23/10 = salário de 24/09.
//   * COMPETÊNCIA (YYYY-MM): o mês DA CONTA. Aluguel de outubro = 2026-10, seja paga em 27/09 ou em 05/10.
// Ligação (só para LISTAR "o que o salário atual precisa cobrir"): a competência principal de um ciclo é o mês em
// que ele TERMINA (24/09→23/10 ⇒ 2026-10). Pagar antes do dia 1 NÃO muda a competência, e a virada do dia 01 NÃO
// muda o ciclo — por isso a conta de outubro paga em setembro continua PAGA em outubro (nada a recriar/reabrir).
// A identidade da ocorrência é sempre regra + competência + parte (lib/houseBills.js), nunca o mês do pagamento.
// ============================================================================
const mk = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const SHORT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export function competenceMonthOfCycle(cycle) {
  return mk(cycle.end);
}

export function describeCycle(cycle) {
  const d = (x) => `${String(x.getUTCDate()).padStart(2, "0")} ${SHORT[x.getUTCMonth()]}`;
  return { start: cycle.start, end: cycle.end, competence: competenceMonthOfCycle(cycle), label: `${d(cycle.start)} → ${d(cycle.end)}`, key: cycle.start.toISOString().slice(0, 10) };
}

// Ciclo "de hoje" no fuso do app (dia local, não UTC).
export function resolveCurrentCycle({ now = new Date(), settings, timeZone = getAppTimezone() } = {}) {
  const today = localCalendarDateAsUtcMidnight(now, timeZone);
  return describeCycle(getFinancialCycleForDate(today, { cycleStartDay: settings?.cycleStartDay ?? 24 }));
}

// Chave do ciclo a que UMA ocorrência de conta pertence: vencimento conhecido => ciclo que contém o vencimento
// (aluguel de outubro vence 05/10 => 24/09→23/10; o que vence 28/10 já é do ciclo seguinte); vencimento desconhecido =>
// ciclo que TERMINA no mês da competência (a conta de outubro sem data é paga com o salário de 24/09).
export function cycleKeyOfOccurrence({ dueDate, competence }, settings) {
  const startDay = settings?.cycleStartDay ?? 24;
  if (dueDate) return getFinancialCycleForDate(new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate())), { cycleStartDay: startDay }).start.toISOString().slice(0, 10);
  const [y, m] = competence.split("-").map(Number);
  return clampToMonth(y, m - 2, startDay).toISOString().slice(0, 10);
}
