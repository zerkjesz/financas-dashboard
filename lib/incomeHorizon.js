import { prisma } from "./prisma.js";
import { clampToMonth, startOfDay } from "./recurringCycles.js";
import { getNextCycleStart } from "./financialCycle.js";
import { money } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";
import { getAppSettings } from "./settings.js";

// Fase 4.0.1/4.0.2 — camada dedicada à pergunta "quando cai a PRÓXIMA RENDA de
// verdade", separada de lib/financialCycle.js (que só sabe "quando começa o
// próximo ciclo no calendário"). São perguntas diferentes: o calendário pode
// virar o ciclo no dia certo sem que o salário daquele dia tenha sido
// efetivamente registrado.
//
// A ocorrência de uma RecurringRule de renda é identificada pela DATA EXATA
// prevista (Income.recurringOccurrenceDate, @db.Date) — nunca por mês
// calendário/cycleMonth (que misturaria três conceitos diferentes: mês
// calendário, ciclo financeiro, e ocorrência recorrente).
//
// Este arquivo tem duas seções: a lógica PURA de classificação (não lê o banco —
// resolveNextExpectedIncome, testada em scripts/test-income-horizon.mjs com
// dado 100% sintético) e a INTEGRAÇÃO COM PERSISTÊNCIA REAL (lê/escreve Income,
// só usada por quem realmente precisa consultar/registrar o banco).

export const INCOME_HORIZON_STATUS = Object.freeze({
  UPCOMING: "UPCOMING", // ainda não chegou a data esperada.
  DUE_TODAY: "DUE_TODAY", // é hoje, ainda sem Income real.
  OVERDUE: "OVERDUE", // já passou da data esperada, ainda sem Income real — NUNCA pula pro próximo mês sozinho.
  FALLBACK: "FALLBACK", // sem RecurringRule de renda irrestrita confiável — usa AppSettings.cycleStartDay só como agenda, não como renda configurada de verdade.
});

// ============================================================================
// PURO — não lê o banco.
// ============================================================================

function accountIsUnrestricted(accountId, accountsById) {
  if (accountId == null) {
    // Sem accountId setado na regra, não há sinal de restrição conhecido — trata
    // como elegível por padrão (decisão documentada, não uma adivinhação
    // silenciosa: o único sinal de restrição que este código reconhece é
    // type === "food_voucher" numa conta explícita).
    return true;
  }
  const account = accountsById.get(accountId);
  if (!account) return true; // conta não encontrada no mapa fornecido — mesmo default acima.
  return account.type !== "food_voucher";
}

function dateOnlyKey(date) {
  return startOfDay(date).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// `realizedOccurrences`: Set de chaves "recurringRuleId:YYYY-MM-DD" (data EXATA
// prevista, nunca mês) que o CALLER já confirmou corresponderem a um Income
// real (income.recurringRuleId === rule.id E income.recurringOccurrenceDate ===
// essa data). Esta função nunca decide sozinha "o que conta como realizado" —
// só compara contra o que foi informado.
function occurrenceKey(recurringRuleId, occurrenceDate) {
  return `${recurringRuleId}:${dateOnlyKey(occurrenceDate)}`;
}

// Resolve, pra UMA RecurringRule de renda, a ocorrência relevante "agora":
//   - se a ocorrência deste mês ainda não chegou -> UPCOMING, data = deste mês.
//   - se chegou (hoje ou já passou) e NÃO foi realizada -> DUE_TODAY (se for hoje)
//     ou OVERDUE (se já passou) — nunca pula pro mês seguinte sozinho.
//   - se chegou e FOI realizada -> a ocorrência relevante passa a ser a do mês
//     seguinte, status UPCOMING.
function resolveRuleOccurrence(rule, { now, realizedOccurrences }) {
  const today = startOfDay(now);
  const thisMonthOccurrence = clampToMonth(today.getUTCFullYear(), today.getUTCMonth(), rule.dayOfMonth);

  if (today < thisMonthOccurrence) {
    return { date: thisMonthOccurrence, status: INCOME_HORIZON_STATUS.UPCOMING };
  }

  const realized = realizedOccurrences.has(occurrenceKey(rule.id, thisMonthOccurrence));
  if (realized) {
    const nextMonthOccurrence = clampToMonth(today.getUTCFullYear(), today.getUTCMonth() + 1, rule.dayOfMonth);
    return { date: nextMonthOccurrence, status: INCOME_HORIZON_STATUS.UPCOMING };
  }

  const isToday = today.getTime() === thisMonthOccurrence.getTime();
  return { date: thisMonthOccurrence, status: isToday ? INCOME_HORIZON_STATUS.DUE_TODAY : INCOME_HORIZON_STATUS.OVERDUE };
}

// resolveNextExpectedIncome({ now, recurringRules, realizedIncomes, accounts, settings })
//
// - now: Date.
// - recurringRules: RecurringRule[] (o caller filtra kind="income" — esta função
//   também filtra defensivamente, mas não é o único filtro).
// - realizedIncomes: array de { recurringRuleId, recurringOccurrenceDate } —
//   pares JÁ CONFIRMADOS pelo caller como "esta ocorrência desta regra teve um
//   Income real", pela DATA EXATA prevista (Date ou string ISO de data). Esta
//   função NUNCA infere isso sozinha — ver resolveNextExpectedIncomeFromDb
//   abaixo pra como isso é buscado de verdade no banco.
// - accounts: Account[] — usado só pra resolver o `type` de rule.accountId
//   (filtrar food_voucher/VA, item 4/5).
// - settings: AppSettings — usado só no FALLBACK (item 6).
//
// Retorno: { expectedDate, status, recurringRuleId, accountId, isFallback }
export function resolveNextExpectedIncome({ now = new Date(), recurringRules = [], realizedIncomes = [], accounts = [], settings } = {}) {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const realizedOccurrences = new Set(realizedIncomes.map((r) => occurrenceKey(r.recurringRuleId, new Date(r.recurringOccurrenceDate))));

  // Item 5: só renda irrestrita (checking/cash) — VA/food_voucher nunca entra
  // no horizonte de freeMoney (tem ciclo próprio, separado).
  const eligibleRules = recurringRules.filter(
    (rule) => rule.kind === "income" && rule.isActive !== false && rule.dayOfMonth != null && accountIsUnrestricted(rule.accountId, accountsById)
  );

  if (eligibleRules.length === 0) {
    // Item 6 — fallback explícito, NUNCA tratado como renda configurada de
    // verdade. Marcado isFallback:true pra quem consome saber a diferença.
    if (!settings) throw new Error("Sem RecurringRule de renda irrestrita e sem settings — não há como calcular nem o fallback.");
    return {
      expectedDate: getNextCycleStart(settings, now),
      status: INCOME_HORIZON_STATUS.FALLBACK,
      recurringRuleId: null,
      accountId: null,
      isFallback: true,
    };
  }

  // Uma ocorrência por regra elegível, depois escolhe a cronologicamente mais
  // relevante (a mais próxima/atrasada primeiro — OVERDUE e DUE_TODAY sempre têm
  // data <= hoje, então naturalmente vêm antes de qualquer UPCOMING futuro).
  const candidates = eligibleRules.map((rule) => ({ rule, ...resolveRuleOccurrence(rule, { now, realizedOccurrences }) }));
  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  const winner = candidates[0];

  return {
    expectedDate: winner.date,
    status: winner.status,
    recurringRuleId: winner.rule.id,
    accountId: winner.rule.accountId ?? null,
    isFallback: false,
  };
}

// ============================================================================
// INTEGRAÇÃO COM PERSISTÊNCIA REAL (Fase 4.0.2, item 4)
// ============================================================================
//
// O gap de modelagem da Fase 4.0.1 foi resolvido: Income.recurringOccurrenceDate
// (Date, nullable, sem backfill) + @@unique([recurringRuleId,
// recurringOccurrenceDate]) — ver prisma/migrations/
// 20260904180000_income_recurring_occurrence_date. "Realizado" agora tem
// definição exata e sem ambiguidade: existe Income onde recurringRuleId === X
// E recurringOccurrenceDate === Y. Nenhum matching por valor/descrição/
// categoria/proximidade de data — só essas duas colunas.

// Busca, em UMA query, todas as ocorrências já realizadas pro conjunto de
// regras dado — formato pronto pra passar como `realizedIncomes` de
// resolveNextExpectedIncome.
// Fase 5.2C prep — `client` opcional (default: `prisma`), mesmo padrão aditivo
// já usado em lib/accounts.js/lib/freeMoney.js — permite validar com
// `{ client: tx }` dentro de uma transação futura. Nenhum call-site existente
// muda de comportamento.
export async function getRealizedOccurrences(recurringRuleIds, { client = prisma } = {}) {
  if (recurringRuleIds.length === 0) return [];
  const incomes = await client.income.findMany({
    where: { recurringRuleId: { in: recurringRuleIds }, recurringOccurrenceDate: { not: null } },
    select: { recurringRuleId: true, recurringOccurrenceDate: true },
  });
  return incomes.map((i) => ({ recurringRuleId: i.recurringRuleId, recurringOccurrenceDate: i.recurringOccurrenceDate }));
}

// Busca RecurringRule (kind=income, ativas) + Account + as ocorrências já
// realizadas pra elas, e resolve o horizonte real — a versão "de produção" de
// resolveNextExpectedIncome. Read-only (nunca cria/materializa nada).
export async function resolveNextExpectedIncomeFromDb({ now = new Date(), client = prisma } = {}) {
  const [recurringRules, accounts, settings] = await Promise.all([
    client.recurringRule.findMany({ where: { kind: "income", isActive: true } }),
    client.account.findMany(),
    getAppSettings({ client }),
  ]);
  const realizedIncomes = await getRealizedOccurrences(recurringRules.map((r) => r.id), { client });
  return resolveNextExpectedIncome({ now, recurringRules, realizedIncomes, accounts, settings });
}

// Registra explicitamente um Income JÁ SABENDO qual ocorrência recorrente ele
// realiza — nenhum matching automático. Valida (item 3):
//   - RecurringRule existe e é do tipo income;
//   - a conta é apropriada (bate com rule.accountId quando a regra já tem uma
//     conta configurada — não deixa registrar a renda de uma regra numa conta
//     diferente da configurada, silenciosamente);
//   - aquela recurringRule + occurrenceDate ainda não foi realizada (checagem
//     explícita ANTES do insert — a unique constraint é a última linha de
//     defesa, não a única).
export async function recordRecurringIncomeOccurrence({
  recurringRuleId,
  recurringOccurrenceDate,
  accountId,
  amount,
  description,
  category,
  source,
  confidence,
  rawMessage,
} = {}) {
  if (!recurringRuleId) throw new Error("recurringRuleId é obrigatório");
  if (!recurringOccurrenceDate) throw new Error("recurringOccurrenceDate é obrigatório");
  if (!accountId) throw new Error("accountId é obrigatório");

  const rule = await prisma.recurringRule.findUnique({ where: { id: recurringRuleId } });
  if (!rule) throw new Error("RecurringRule não encontrada");
  if (rule.kind !== "income") throw new Error(`RecurringRule "${rule.name}" não é do tipo income (kind=${rule.kind})`);

  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error("Account não encontrada");
  if (rule.accountId != null && rule.accountId !== accountId) {
    throw new Error(`RecurringRule "${rule.name}" está configurada pra outra conta — informe accountId=${rule.accountId}`);
  }

  const occurrenceDate = startOfDay(new Date(recurringOccurrenceDate));
  const existing = await prisma.income.findUnique({
    where: { recurringRuleId_recurringOccurrenceDate: { recurringRuleId, recurringOccurrenceDate: occurrenceDate } },
  });
  if (existing) {
    throw new Error(`Esta ocorrência (${recurringRuleId} / ${dateOnlyKey(occurrenceDate)}) já foi registrada — Income ${existing.id}`);
  }

  const amountMoney = money(amount);
  if (!amountMoney.gt(0)) throw new Error("amount precisa ser positivo");

  return prisma.income.create({
    data: {
      amount: amountMoney,
      description: description || rule.name,
      category: category || rule.category || "Outros",
      accountId,
      recurringRuleId,
      recurringOccurrenceDate: occurrenceDate,
      isRecurring: true,
      source: source || "manual",
      confidence: resolveConfidence(confidence),
      rawMessage: rawMessage || null,
    },
  });
}

// Fase 4.1, item 11 — metadata pronta pra expor no financialEngine:
// { expectedDate, status, amount?, recurringRuleId?, isFallback }. `amount` só
// vem preenchido quando a RecurringRule vencedora tiver um amount configurado
// (RecurringRule.amount é nullable — renda de valor variável não tem amount).
export async function getNextIncomeInfo({ now = new Date(), client = prisma } = {}) {
  const horizon = await resolveNextExpectedIncomeFromDb({ now, client });
  let amount = null;
  if (horizon.recurringRuleId) {
    const rule = await client.recurringRule.findUnique({ where: { id: horizon.recurringRuleId } });
    if (rule?.amount != null) amount = money(rule.amount);
  }
  return {
    expectedDate: horizon.expectedDate,
    status: horizon.status,
    amount,
    recurringRuleId: horizon.recurringRuleId,
    isFallback: horizon.isFallback,
  };
}

// Vincula um Income JÁ EXISTENTE a uma ocorrência recorrente — sem heurística,
// o caller já sabe exatamente qual regra + data. Útil pra quando o Income foi
// lançado antes de existir este vínculo (ex: correção manual).
export async function linkIncomeToRecurringOccurrence(incomeId, { recurringRuleId, recurringOccurrenceDate } = {}) {
  if (!recurringRuleId) throw new Error("recurringRuleId é obrigatório");
  if (!recurringOccurrenceDate) throw new Error("recurringOccurrenceDate é obrigatório");

  const [rule, income] = await Promise.all([
    prisma.recurringRule.findUnique({ where: { id: recurringRuleId } }),
    prisma.income.findUnique({ where: { id: incomeId } }),
  ]);
  if (!rule) throw new Error("RecurringRule não encontrada");
  if (rule.kind !== "income") throw new Error(`RecurringRule "${rule.name}" não é do tipo income (kind=${rule.kind})`);
  if (!income) throw new Error("Income não encontrado");

  const occurrenceDate = startOfDay(new Date(recurringOccurrenceDate));
  const existing = await prisma.income.findUnique({
    where: { recurringRuleId_recurringOccurrenceDate: { recurringRuleId, recurringOccurrenceDate: occurrenceDate } },
  });
  if (existing && existing.id !== incomeId) {
    throw new Error(`Esta ocorrência já está vinculada a outro Income (${existing.id})`);
  }

  return prisma.income.update({
    where: { id: incomeId },
    data: { recurringRuleId, recurringOccurrenceDate: occurrenceDate },
  });
}
