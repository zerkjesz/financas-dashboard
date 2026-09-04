import { clampToMonth, monthKeyOf, startOfDay } from "./recurringCycles.js";
import { getNextCycleStart } from "./financialCycle.js";

// Fase 4.0.1 — camada dedicada à pergunta "quando cai a PRÓXIMA RENDA de verdade",
// separada de lib/financialCycle.js (que só sabe "quando começa o próximo ciclo
// no calendário"). São perguntas diferentes: o calendário pode virar o ciclo no
// dia certo sem que o salário daquele dia tenha sido efetivamente registrado.
//
// PURO — não lê o banco. Quem chama já resolveu `recurringRules`/`realizedIncomes`/
// `accounts` (ver GAP DE MODELAGEM no fim deste arquivo pra por que a busca real de
// `realizedIncomes` ainda não está implementada em nenhum service que consulta o
// banco).

export const INCOME_HORIZON_STATUS = Object.freeze({
  UPCOMING: "UPCOMING", // ainda não chegou a data esperada.
  DUE_TODAY: "DUE_TODAY", // é hoje, ainda sem Income real.
  OVERDUE: "OVERDUE", // já passou da data esperada, ainda sem Income real — NUNCA pula pro próximo mês sozinho.
  FALLBACK: "FALLBACK", // sem RecurringRule de renda irrestrita confiável — usa AppSettings.cycleStartDay só como agenda, não como renda configurada de verdade.
});

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

// `realizedOccurrences`: Set de chaves "recurringRuleId:YYYY-MM" que o CALLER já
// confirmou corresponderem a um Income real. Esta função nunca decide sozinha "o
// que conta como realizado" — só compara contra o que foi informado (ver GAP DE
// MODELAGEM no fim do arquivo).
function occurrenceKey(recurringRuleId, occurrenceDate) {
  return `${recurringRuleId}:${monthKeyOf(occurrenceDate)}`;
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
// - realizedIncomes: array de { recurringRuleId, cycleMonth } — pares JÁ
//   CONFIRMADOS pelo caller como "esta ocorrência desta regra teve um Income
//   real". `cycleMonth` no formato "YYYY-MM" do mês da ocorrência esperada (não
//   do Income em si). Esta função NUNCA infere isso sozinha.
// - accounts: Account[] — usado só pra resolver o `type` de rule.accountId
//   (filtrar food_voucher/VA, item 4).
// - settings: AppSettings — usado só no FALLBACK (item 8).
//
// Retorno: { expectedDate, status, recurringRuleId, accountId, isFallback }
export function resolveNextExpectedIncome({ now = new Date(), recurringRules = [], realizedIncomes = [], accounts = [], settings } = {}) {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const realizedOccurrences = new Set(realizedIncomes.map((r) => `${r.recurringRuleId}:${r.cycleMonth}`));

  // Item 4: só renda irrestrita (checking/cash) — VA/food_voucher nunca entra
  // no horizonte de freeMoney (tem ciclo próprio, separado).
  const eligibleRules = recurringRules.filter(
    (rule) => rule.kind === "income" && rule.isActive !== false && rule.dayOfMonth != null && accountIsUnrestricted(rule.accountId, accountsById)
  );

  if (eligibleRules.length === 0) {
    // Item 8 — fallback explícito, NUNCA tratado como renda configurada de
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
// GAP DE MODELAGEM (Fase 4.0.1, item 5) — documentado, não contornado.
//
// Problema: não existe hoje uma forma confiável de responder, contra o banco
// real, "a ocorrência de RecurringRule X esperada no cycleMonth Y já foi
// registrada como Income real?" — ou seja, ninguém hoje consegue produzir de
// forma segura o array `realizedIncomes` que esta função espera receber.
//
// Schema atual: Income.recurringRuleId existe (String? nullable), mas:
//   1. NUNCA é populado por nenhum caminho de escrita atual — grep confirmado em
//      app/api/incomes/route.js, lib/commitBotIntent.js:commitIncome e
//      lib/receivables.js:markReceivableReceived: nenhum dos três seta esse
//      campo. Uma query por recurringRuleId hoje sempre volta vazia, mesmo que o
//      usuário já tenha lançado o salário manualmente.
//   2. Mesmo se fosse populado, falta o campo irmão que o Bill tem: Bill usa
//      (recurringRuleId, cycleMonth) com @@unique — dá pra perguntar "existe Bill
//      da regra X pro ciclo Y" sem ambiguidade. Income não tem esse `cycleMonth`
//      nem constraint — a única forma de tentar casar um Income a uma ocorrência
//      específica seria comparar `occurredAt` contra uma janela de datas.
//
// Por que isso não é seguro de resolver agora: comparar por data é exatamente a
// heurística frágil que o `computeVirtualRecurringCredit` (removido na Fase 1.1,
// commit 7932047) usava — e o motivo dela ter sido removida é precisamente esse
// tipo de fragilidade (ex: usuário lança o salário com atraso ou edita a data,
// ou tem duas rendas no mesmo mês). Não vou reintroduzir esse padrão.
//
// Alteração mínima proposta (NÃO aplicada — aguardando aprovação explícita):
//   - Income.cycleMonth String? (mesmo padrão de Bill.cycleMonth).
//   - @@unique([recurringRuleId, cycleMonth]) em Income (nullable-safe: Postgres
//     não considera NULLs conflitantes numa unique composta, então Income sem
//     recurringRuleId continua livre, sem precisar de nenhum backfill).
//   - Popular os dois campos explicitamente nos pontos de criação onde a origem
//     for conhecidamente uma ocorrência recorrente (ex: uma futura tela/fluxo
//     "confirmar recebimento do salário" passaria isso explicitamente) — histórico
//     existente fica NULL/NULL ("não vinculado"), mesma política de não-backfill
//     retroativo já usada pra DataConfidence na Fase 3.2.
//
// Até essa decisão ser tomada, qualquer service que precise de `realizedIncomes`
// de dados reais deve deixar isso explícito (retornar vazio/undefined com um
// comentário apontando pra este gap), nunca inventar um match por descrição/
// valor/categoria.
// ============================================================================
