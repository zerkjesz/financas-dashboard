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
// relativo a `now`, nunca o início do ciclo que já contém `now` (mesmo se `now`
// for exatamente o cycleStartDay — ver decisão de boundary abaixo).
export function getNextCycleStart(settings, now = new Date()) {
  const current = getCurrentFinancialCycle(settings, now);
  return new Date(current.end.getTime() + 24 * 60 * 60 * 1000);
}

// nextIncomeDate = "próximo cycleStartDay POSTERIOR ao momento atual" (Fase 4.0,
// item 1 — texto literal do pedido). Decisão explícita de boundary: no dia exato
// do cycleStartDay, a renda desse dia já é tratada como "agora" (o ciclo atual
// COMEÇA nesse dia, ver getFinancialCycleForDate acima) — "posterior" nunca inclui
// o próprio dia. Por isso, em 24/09 (cycleStartDay=24), nextIncomeDate = 24/10, não
// 24/09: o dinheiro de hoje já "chegou" (é o início do ciclo atual), a PRÓXIMA
// renda futura é só no mês seguinte.
//
// v1: nextIncomeDate coincide exatamente com getNextCycleStart. Mantidas como
// funções separadas de propósito — nomes com papéis semânticos distintos (uma é
// "mecânica de ciclo genérica", a outra é "a pergunta de domínio: quando cai a
// próxima renda", usada pelo obligation classifier) — podem divergir numa fase
// futura sem precisar renomear nada.
export function getNextIncomeDate(settings, now = new Date()) {
  return getNextCycleStart(settings, now);
}
