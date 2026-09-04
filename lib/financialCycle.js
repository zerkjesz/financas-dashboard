import { clampToMonth, startOfDay } from "./recurringCycles.js";

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
