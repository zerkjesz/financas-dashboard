import { clampToMonth } from "./recurringCycles.js";
import { addMonthKey, monthKey } from "./formatMoney.js";

// Fase 4.0 — lógica central do ciclo de fatura de cartão. Substitui as funções
// locais que existiam em lib/cardBillCalculator.js (cycleRange/computeClosesAt/
// computeDueAt) — cardBillCalculator.js passa a só CONSUMIR este módulo, nunca mais
// reimplementar a conta. `cycleReference` é sempre uma string "YYYY-MM" — mesma
// convenção já usada em CardBill.cycleMonth, Purchase.firstInstallmentMonth,
// Installment.billMonth etc; escolhida de propósito pra não quebrar nenhum
// call-site existente que já grava/lê essa string no banco.
//
// Granularidade: DATA, nunca hora exata — não temos o horário exato de fechamento
// bancário, então "dia X" é tratado como um dia inteiro (meia-noite a meia-noite
// UTC). Isso é uma limitação deliberada e documentada, não um descuido: um cartão
// que fecha "dia 4 às 23h" e outro que fecha "dia 4 à 0h" são indistinguíveis aqui.
//
// Convenção formal pra cartão com closingDay definido (ex: Itaú real: closingDay=4,
// dueDay=11 — AINDA NÃO configurado no cartão real, ver Fase 4.0 item 2):
//   período   = [dia (closingDay+1) do mês anterior, dia closingDay do mês de
//                referência] — dia closingDay em si é o ÚLTIMO dia do período
//                (inclusive), dia (closingDay+1) já pertence ao PRÓXIMO período.
//   closesAt  = dia closingDay do mês de referência.
//   dueAt     = dia dueDay do MESMO mês de referência quando dueDay >= closingDay
//               (vencimento vem depois do fechamento dentro do mesmo mês civil —
//               caso do Itaú real: fecha 4, vence 11); dia dueDay do mês SEGUINTE
//               quando dueDay < closingDay (o vencimento só pode vir depois
//               cronologicamente do fechamento — regra geral, não hardcoded pro
//               Itaú). Esse é exatamente o bug que a auditoria original achou:
//               computeDueAt() antigo SEMPRE somava um mês, certo por acaso só
//               quando closingDay era null.
//
// Quando closingDay é null (config real ainda ausente pro cartão): mantém
// EXATAMENTE o fallback de mês calendário que já existia (cycleReference = mês
// civil das transações; closesAt = dia 1 do mês seguinte; dueAt = dueDay do mês
// seguinte) — comportamento intacto pro cartão real hoje, nada muda pra ele nesta
// fase.

function dayInMonthKey(monthKeyStr, day) {
  const [year, month] = monthKeyStr.split("-").map(Number);
  return clampToMonth(year, month - 1, day);
}

function assertValidCard(card) {
  if (!card) throw new Error("Card é obrigatório");
  if (!Number.isInteger(card.dueDay) || card.dueDay < 1 || card.dueDay > 31) {
    throw new Error(`Card.dueDay inválido: ${JSON.stringify(card.dueDay)} — não é possível resolver o ciclo sem um dueDay válido`);
  }
  if (card.closingDay != null && (!Number.isInteger(card.closingDay) || card.closingDay < 1 || card.closingDay > 31)) {
    throw new Error(`Card.closingDay inválido: ${JSON.stringify(card.closingDay)}`);
  }
}

// Período de transações [start, end) — end EXCLUSIVE, pra uso direto em queries
// Prisma (`occurredAt: { gte: start, lt: end }`), igual ao padrão já usado no
// resto do app.
export function getCardBillPeriod(card, cycleReference) {
  assertValidCard(card);
  if (card.closingDay == null) {
    const start = dayInMonthKey(cycleReference, 1);
    const end = dayInMonthKey(addMonthKey(cycleReference, 1), 1);
    return { start, end };
  }
  const end = new Date(dayInMonthKey(cycleReference, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  const prevMonth = addMonthKey(cycleReference, -1);
  const start = new Date(dayInMonthKey(prevMonth, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function getCardBillClosesAt(card, cycleReference) {
  assertValidCard(card);
  if (card.closingDay == null) return dayInMonthKey(addMonthKey(cycleReference, 1), 1);
  return dayInMonthKey(cycleReference, card.closingDay);
}

// FIX da Fase 4.0 (achado original da auditoria, P1-3): antes SEMPRE somava um mês
// ao cycleReference, certo por acaso só com closingDay null. Agora deriva
// corretamente se o vencimento cai no mesmo mês de referência (fechamento) ou no
// seguinte, comparando dueDay com closingDay.
export function getCardBillDueDate(card, cycleReference) {
  assertValidCard(card);
  if (card.closingDay == null) {
    return dayInMonthKey(addMonthKey(cycleReference, 1), card.dueDay);
  }
  const monthOffset = card.dueDay >= card.closingDay ? 0 : 1;
  return dayInMonthKey(addMonthKey(cycleReference, monthOffset), card.dueDay);
}

// Mapeamento INVERSO: dado um cartão e uma data de transação, a que
// cycleReference ("YYYY-MM") essa transação pertence. Sem closingDay: é
// simplesmente o mês civil da transação (monthKey). Com closingDay: dia <=
// closingDay pertence ao ciclo que FECHA neste mês; dia > closingDay já pertence
// ao ciclo que fecha no mês SEGUINTE (ver período acima — closingDay é o último
// dia inclusive do período que fecha "neste" mês de referência).
export function getCardCycleForDate(card, date) {
  assertValidCard(card);
  if (card.closingDay == null) return monthKey(date);
  const day = date.getUTCDate();
  const thisMonth = monthKey(date);
  return day <= card.closingDay ? thisMonth : addMonthKey(thisMonth, 1);
}

// Nome de domínio mais específico pro mesmo cálculo — usado por
// lib/cardBillCalculator.js pra decidir em qual CardBill uma Expense/Installment
// deve entrar quando a transação acontece "agora".
export const resolveBillForTransactionDate = getCardCycleForDate;
