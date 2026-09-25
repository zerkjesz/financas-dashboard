import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney, sumMoney, isPositive, multiplyMoney, divideMoney, ZERO } from "./money.js";
import { listAccountsWithBalances } from "./accounts.js";
import { computeUnrestrictedCash, unrestrictedCashAccountIds } from "./unrestrictedCash.js";
import { getReserveBalance, computeReplenishmentGap } from "./reserves.js";
import { listCardBillsView, applyObservedTotal } from "./cardBillCalculator.js";
import {
  OBLIGATION_CLASS,
  classifyCardBill,
  classifyBill,
  classifyExternalInstallment,
  classifyConfirmedCommitment,
} from "./obligationClassifier.js";
import { clampToMonth, startOfDay } from "./recurringCycles.js";
import { getHouseBillObligations, billHouseKey } from "./houseBills.js";

// ============================================================================
// Fase 4.1 — Financial Engine V2. Vocabulário oficial (item 1) — nomes
// diferentes pra conceitos diferentes, nunca usados como sinônimo:
//
//   TOTAL BALANCES            soma de TODOS os saldos acompanhados (inclui VA).
//   UNRESTRICTED CASH         checking + cash (lib/unrestrictedCash.js).
//   RESTRICTED BALANCE        saldos restritos (food_voucher).
//   PROTECTED MONEY           parte do unrestrictedCash alocada em Reserve ativa
//                             vinculada a conta IRRESTRITA (ver getProtectedMoney).
//   INCURRED LIABILITIES      dívida já formada que ainda vai sair do caixa
//                             (CardBill relevante/atual com saldo > 0).
//   CURRENT HORIZON OBLIGATION obrigação confirmada que precisa ser coberta
//                             antes da próxima renda esperada.
//   FUTURE OBLIGATION         obrigação que aparece na projeção mas não
//                             sequestra freeMoney hoje.
//   FREE MONEY                unrestrictedCash - protectedMoney - incurred -
//                             currentHorizon. PODE ser negativo.
//   SAFE TO SPEND             parte conservadora do freeMoney positivo.
//   PROJECTED CASH            trajetória física do unrestrictedCash no tempo
//                             (ver lib/financialProjection.js) — NUNCA começa
//                             de freeMoney/safeToSpend.
// ============================================================================

// ============================================================================
// protectedMoney (item 2)
// ============================================================================
//
// protectedMoney = soma dos saldos atuais de Reserve ATIVA vinculada a conta
// IRRESTRITA. Uma Reserve vinculada a food_voucher/outra conta restrita NÃO
// entra aqui — o saldo dela já está FORA de unrestrictedCash (por definição,
// unrestrictedCash já exclui contas restritas), então contá-la de novo seria
// subtrair a mesma coisa duas vezes. `countsTowardProtectedMoney: false` no
// breakdown documenta essa exclusão explicitamente, em vez de omitir a Reserve
// silenciosamente do retorno.
// Fase 5.2A prep — `client` opcional (default: o singleton `prisma`), mesmo
// padrão aditivo já usado em lib/accounts.js/lib/cardBillCalculator.js/lib/cards.js:
// permite validar com `{ client: tx }` dentro de uma prisma.$transaction futura,
// contra o estado ainda não commitado. Nenhum call-site existente muda de
// comportamento (default idêntico ao anterior).
export async function getProtectedMoneyBreakdown({ unrestrictedAccountIds, client = prisma } = {}) {
  const reserves = await client.reserve.findMany({ where: { isActive: true } });
  const breakdown = [];
  for (const reserve of reserves) {
    const currentAmount = await getReserveBalance(reserve.id, { client });
    const countsTowardProtectedMoney = unrestrictedAccountIds.has(reserve.accountId);
    breakdown.push({
      reserveId: reserve.id,
      name: reserve.name,
      accountId: reserve.accountId,
      currentAmount,
      targetAmount: reserve.targetAmount != null ? money(reserve.targetAmount) : null,
      replenishmentGap: computeReplenishmentGap(reserve.targetAmount, currentAmount),
      countsTowardProtectedMoney,
    });
  }
  return breakdown;
}

export async function getProtectedMoney({ unrestrictedAccountIds, client = prisma } = {}) {
  const breakdown = await getProtectedMoneyBreakdown({ unrestrictedAccountIds, client });
  return sumMoney(breakdown.filter((b) => b.countsTowardProtectedMoney).map((b) => b.currentAmount));
}

// Fase 4.1.2 — Card Liability Gate. Resolve, entre as CardBill NÃO LIQUIDADAS
// (saldo > 0) de UM cartão, qual é a "fatura atualmente relevante": a PRIMEIRA
// cronologicamente (por closesAt, não pela ordem que veio do banco — item 7,
// teste F). Só ela é INCURRED_LIABILITY; as demais (mesmo com saldo > 0) são
// FUTURE_OBLIGATION — ver justificativa completa em
// lib/obligationClassifier.js:classifyCardBill. Pura — recebe a lista de bills
// já carregada, não lê o banco.
//
// Pressuposto documentado (não validado aqui — ver scripts/audit.js:
// auditCurrentRelevantCardBillSanity e a auditoria de materialização, Fase
// 4.1.2 item 6): a lista de bills é materializada de forma CONTÍGUA ao redor
// de "agora" (lib/cardBillCalculator.js:listBillsForCard sempre inclui o ciclo
// atual, nunca só ciclos futuros distantes). Se essa contiguidade for quebrada
// por algum motivo, "a primeira não liquidada" poderia ser uma fatura distante
// — por isso a auditoria read-only existe, em vez de confiar cegamente nisso.
// Retorna cycleMonth (não id) — Fase 4.1.3: uma fatura PROJECTED (ver
// lib/cardBillCalculator.js:getCardBillView) tem id=null, então comparar por
// id quebraria se a "primeira não liquidada" for uma projeção (várias
// projetadas teriam id null simultaneamente). cycleMonth é único por cartão e
// sempre existe, persisted ou não.
export function resolveCurrentRelevantCardBillCycleMonth(bills) {
  const unsettled = bills
    .filter((bill) => subtractMoney(money(bill.totalAmount), money(bill.paidAmount ?? 0)).gt(0))
    .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime());
  return unsettled.length > 0 ? unsettled[0].cycleMonth : null;
}

// ============================================================================
// Passada única de classificação — alimenta incurred/currentHorizon/future
// (itens 3/4/22) sem reconsultar o banco 3 vezes nem reimplementar a mesma
// lógica 3 vezes. CardCreditMovement NÃO é aplicado aqui — decisão explícita
// (Fase 3.3, item 10 / Fase 4.1, item 3): o crédito do cartão ainda não abate
// o saldo necessário de settlement nesta fase. Comportamento DOCUMENTADO, não
// esquecido — se um teste tiver saldo de CardCredit, ele é ignorado de
// propósito por esta função.
async function classifyAllObligations({ now = new Date(), nextIncomeDate, client = prisma } = {}) {
  if (!nextIncomeDate) throw new Error("nextIncomeDate é obrigatório");

  const buckets = {
    [OBLIGATION_CLASS.INCURRED_LIABILITY]: { total: ZERO, items: [] },
    [OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION]: { total: ZERO, items: [] },
    [OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT]: { total: ZERO, items: [] },
    [OBLIGATION_CLASS.FUTURE_OBLIGATION]: { total: ZERO, items: [] },
  };
  const push = (cls, item) => {
    const bucket = buckets[cls];
    if (!bucket) return; // SETTLED/CANCELLED — não é obrigação, não entra em nenhum bucket.
    bucket.total = addMoney(bucket.total, item.amount);
    bucket.items.push(item);
  };

  // `now` não é mais usado pela classificação de CardBill (Fase 4.1.2 — ver
  // resolveCurrentRelevantCardBillCycleMonth acima); mantido no parâmetro da
  // função por estabilidade de API (outros chamadores já passam) e porque
  // Bill/ExternalInstallment/ConfirmedCommitment continuam usando
  // `nextIncomeDate`, não `now`, então nada muda pra eles.
  //
  // Fase 4.1.3 — listCardBillsView (não prisma.cardBill.findMany direto):
  // combina persisted + PROJECTED em memória, então o engine funciona igual
  // com 0, 1 ou N CardBill materializadas pra este cartão (item 8) — nunca
  // escreve nada aqui.
  const cards = await client.card.findMany();
  for (const card of cards) {
    const bills = await listCardBillsView(card.id, { client });
    const currentRelevantCycleMonth = resolveCurrentRelevantCardBillCycleMonth(bills);
    for (const bill of bills) {
      const cls = classifyCardBill(bill, { isCurrentRelevant: bill.cycleMonth === currentRelevantCycleMonth });
      const remaining = subtractMoney(money(bill.totalAmount), money(bill.paidAmount ?? 0));
      push(cls, { type: "CardBill", id: bill.id, cardId: card.id, cardName: card.name, cycleMonth: bill.cycleMonth, amount: remaining, dueAt: bill.dueAt });
    }
  }

  const [bills, pendingExternalInstallments, commitments] = await Promise.all([
    client.bill.findMany({ where: { status: { in: ["pending", "overdue"] } } }),
    client.externalInstallment.findMany({ where: { status: "PENDING" }, include: { plan: true }, orderBy: { number: "asc" } }),
    client.confirmedCommitment.findMany({ where: { status: { in: ["CONFIRMED", "FUNDED"] } } }),
  ]);

  // Fase 9.1.1 — contas da casa (RecurringRule + competência persistida/projetada): PENDING com valor
  // conhecido = obrigação do horizonte atual; PAID nunca; variável sem valor NÃO vira zero (vai pra
  // `houseBills.unpriced`). As chaves já cobertas aqui saem do caminho legado abaixo (sem double count).
  const house = await getHouseBillObligations({ now, horizonEnd: nextIncomeDate, client });
  for (const item of house.items) push(OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION, item);

  for (const bill of bills) {
    const key = billHouseKey(bill);
    if (key && house.handled.has(key)) continue; // já representada como conta da casa
    const cls = classifyBill(bill, { nextIncomeDate });
    push(cls, { type: "Bill", id: bill.id, description: bill.description, amount: money(bill.amount), dueDate: bill.dueDate });
  }
  // NÃO enumerável: `buckets` é um mapa classe -> { total, items } que consumidores iteram
  // (Object.keys/values/entries); o resumo das contas da casa é lido só por nome (`buckets.houseBills`).
  Object.defineProperty(buckets, "houseBills", {
    enumerable: false,
    value: {
      pendingKnownCount: house.items.length,
      pendingKnownAmount: sumMoney(house.items.map((i) => i.amount)),
      unpricedPendingBillsCount: house.unpriced.length,
      unpricedPendingBills: house.unpriced,
    },
  });

  // Fase 5.2B, item 5 — "primeira parcela PENDING de cada plano" resolvido AQUI
  // (nunca no classificador, que é puro): agrupa por planId, dentro de cada
  // grupo o menor `number` (já ordenado por number ASC na query acima) é a
  // próxima a vencer. Todas as demais PENDING do mesmo plano — mesmo que também
  // sejam AFTER_NEXT_INCOME — ficam FUTURE_OBLIGATION até a vez delas chegar
  // (a anterior ser paga, o que remove essa linha do próximo `findMany`).
  const firstUnpaidNumberByPlan = new Map();
  for (const installment of pendingExternalInstallments) {
    if (!firstUnpaidNumberByPlan.has(installment.planId)) firstUnpaidNumberByPlan.set(installment.planId, installment.number);
  }

  for (const installment of pendingExternalInstallments) {
    const isFirstUnpaidOfPlan = firstUnpaidNumberByPlan.get(installment.planId) === installment.number;
    const cls = classifyExternalInstallment(installment, { nextIncomeDate, dueTiming: installment.plan.dueTiming, isFirstUnpaidOfPlan });
    push(cls, { type: "ExternalInstallment", id: installment.id, planId: installment.planId, planDescription: installment.plan.description, number: installment.number, amount: money(installment.amount), dueDate: installment.dueDate, dueTiming: installment.plan.dueTiming });
  }

  for (const commitment of commitments) {
    const cls = classifyConfirmedCommitment(commitment, { nextIncomeDate });
    push(cls, {
      type: "ConfirmedCommitment",
      id: commitment.id,
      description: commitment.description,
      shortLabel: commitment.shortLabel ?? null,
      amount: money(commitment.amount),
      dueDate: commitment.dueDate,
      status: commitment.status, // CONFIRMED ou FUNDED — usado por unfundedConfirmedCommitments (item 20)
      fundingAccountId: commitment.fundingAccountId,
      fundingReserveId: commitment.fundingReserveId,
    });
  }

  return buckets;
}

// Ponto único de entrada — computa os 3 buckets numa passada só. Todo consumidor
// que precisar de mais de um bucket (ex: computeFreeMoney, lib/financialEngine.js)
// deve chamar ISTO, não getIncurredLiabilities+getCurrentHorizonObligations+
// getFutureObligations separadamente (senão classifyAllObligations roda 3x à
// toa — mesmo dado, mesmas queries, triplicadas).
export async function getObligationsBreakdown({ now = new Date(), nextIncomeDate, client = prisma } = {}) {
  return classifyAllObligations({ now, nextIncomeDate, client });
}

// ============================================================================
// incurredLiabilities (item 3)
// ============================================================================
//
// Só CardBill classificada INCURRED_LIABILITY (ciclo já iniciado + saldo > 0)
// — NUNCA soma toda CardBill materializada (faturas futuras são
// FUTURE_OBLIGATION). liability = totalAmount - paidAmount (pagamento parcial
// já reduz o valor somado). Atalho de conveniência quando só este bucket
// importa — se for usar mais de um bucket, prefira getObligationsBreakdown().
export async function getIncurredLiabilities({ now = new Date(), nextIncomeDate = now, client = prisma } = {}) {
  const buckets = await classifyAllObligations({ now, nextIncomeDate, client });
  return buckets[OBLIGATION_CLASS.INCURRED_LIABILITY];
}

// ============================================================================
// currentHorizonObligations (item 4)
// ============================================================================
//
// Fontes: Bill, ExternalInstallment, ConfirmedCommitment — nunca RecurringRule
// diretamente (Bill materializada é a fonte de verdade; ver
// lib/recurringDedup.js — as queries acima só buscam Bill, então uma
// ocorrência recorrente materializada nunca é somada duas vezes por
// construção, não por filtro adicional). Atalho de conveniência — se for usar
// mais de um bucket, prefira getObligationsBreakdown().
export async function getCurrentHorizonObligations({ now = new Date(), nextIncomeDate, client = prisma } = {}) {
  const buckets = await classifyAllObligations({ now, nextIncomeDate, client });
  return buckets[OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION];
}

// ============================================================================
// futureObligations (item 22 — completa o breakdown do engine summary)
// ============================================================================
export async function getFutureObligations({ now = new Date(), nextIncomeDate, client = prisma } = {}) {
  const buckets = await classifyAllObligations({ now, nextIncomeDate, client });
  return buckets[OBLIGATION_CLASS.FUTURE_OBLIGATION];
}

// ============================================================================
// unfundedConfirmedCommitments (item 20)
// ============================================================================
export function getUnfundedConfirmedCommitments(currentHorizonItems) {
  const unfunded = currentHorizonItems.filter((i) => i.type === "ConfirmedCommitment" && i.status === "CONFIRMED");
  return { count: unfunded.length, amount: sumMoney(unfunded.map((i) => i.amount)), items: unfunded };
}

// ============================================================================
// contingencyExposure (item 21)
// ============================================================================
//
// Nunca misturado com obrigação confirmada — Contingency nunca entra em
// freeMoney (nem aqui, nem em nenhuma fase futura, por padrão).
export async function getContingencyExposure({ client = prisma } = {}) {
  const contingencies = await client.contingency.findMany({ where: { status: { not: "DISMISSED" } } });
  const expected = sumMoney(contingencies.filter((c) => c.expectedAmount != null).map((c) => c.expectedAmount));
  const maximum = sumMoney(contingencies.map((c) => c.maxAmount));
  return { expected, maximum, items: contingencies };
}

// ============================================================================
// freeMoney (item 6)
// ============================================================================
//
// freeMoney = unrestrictedCash - protectedMoney - incurredLiabilities -
// currentHorizonObligations. PODE ser negativo — nunca max(0) aqui (item 6).
// Extraída como função PURA (só aritmética, nenhum acesso a banco) pra poder
// ser testada isoladamente com números sintéticos — ver
// scripts/test-free-money.mjs, exemplo canônico do item 8 e lifecycle A/B/C do
// item 9.
export function computeFreeMoneyFromBreakdown({ unrestrictedCash, protectedMoney, incurredLiabilities, currentHorizonObligations }) {
  return subtractMoney(
    subtractMoney(subtractMoney(money(unrestrictedCash), money(protectedMoney)), money(incurredLiabilities)),
    money(currentHorizonObligations)
  );
}

export async function computeFreeMoney({ now = new Date(), accounts, nextIncomeDate, client = prisma } = {}) {
  if (!nextIncomeDate) throw new Error("nextIncomeDate é obrigatório");
  const resolvedAccounts = accounts || (await listAccountsWithBalances());
  const unrestrictedIds = unrestrictedCashAccountIds(resolvedAccounts);

  const unrestrictedCash = computeUnrestrictedCash(resolvedAccounts);
  const [protectedMoney, buckets] = await Promise.all([
    getProtectedMoney({ unrestrictedAccountIds: unrestrictedIds, client }),
    getObligationsBreakdown({ now, nextIncomeDate, client }),
  ]);
  const incurred = buckets[OBLIGATION_CLASS.INCURRED_LIABILITY];
  const currentHorizon = buckets[OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION];
  const nextIncomeWindow = buckets[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT];
  const future = buckets[OBLIGATION_CLASS.FUTURE_OBLIGATION];

  // nextIncomeWindow NUNCA entra aqui (Fase 5.2B, item 10) — mesmo tratamento
  // de futureObligations: aparece na projeção/relatório, não sequestra
  // freeMoney atual (só lib/freeMoney.js:getNextIncomeCommitment soma isso).
  const freeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash,
    protectedMoney,
    incurredLiabilities: incurred.total,
    currentHorizonObligations: currentHorizon.total,
  });

  return {
    unrestrictedCash,
    protectedMoney,
    incurredLiabilities: incurred.total,
    incurredLiabilitiesItems: incurred.items,
    currentHorizonObligations: currentHorizon.total,
    currentHorizonObligationsItems: currentHorizon.items,
    nextIncomeWindowCommitment: nextIncomeWindow.total,
    nextIncomeWindowCommitmentItems: nextIncomeWindow.items,
    futureObligations: future.total,
    futureObligationsItems: future.items,
    houseBills: buckets.houseBills,
    freeMoney,
  };
}

// ============================================================================
// safeToSpend (item 7)
// ============================================================================
//
// Fonte de safetyMarginPercent SEMPRE AppSettings (hoje 10) — nunca um número
// hardcoded fora de settings/fixtures de teste.
export function computeSafeToSpend(freeMoney, safetyMarginPercent) {
  if (!isPositive(freeMoney)) {
    return { freeMoney, safetyMarginPercent, safetyReserve: ZERO, safeToSpend: ZERO };
  }
  const safetyReserve = divideMoney(multiplyMoney(freeMoney, safetyMarginPercent), 100);
  const safeToSpend = subtractMoney(freeMoney, safetyReserve);
  return { freeMoney, safetyMarginPercent, safetyReserve, safeToSpend };
}

// ============================================================================
// nextIncomeCommitment (item 18) — "quanto da PRÓXIMA renda já tem destino?"
// ============================================================================
//
// Janela (Fase 4.1.1, item 1 — regra oficial corrigida): [nextIncome.expectedDate,
// ocorrência seguinte da mesma regra) — INCLUSIVE no início, EXCLUSIVE no fim.
// Uma obrigação com dueDate EXATAMENTE no dia da próxima renda pertence ao
// compromisso DAQUELA renda (entra); uma obrigação exatamente no dia da renda
// seguinte já pertence ao ciclo seguinte (não entra). Antes desta correção o
// intervalo era (start, end] — start exclusive — errado nas duas pontas.
//
// Deliberadamente NÃO reusa classifyBill/classifyExternalInstallment/
// classifyConfirmedCommitment (que respondem "isso afeta freeMoney AGORA?", uma
// pergunta de corte único) — aqui a pergunta é "o que vence dentro desta JANELA
// futura específica", por isso é uma soma por intervalo de data direta. Isto
// NÃO é dupla contagem: é outro indicador (não outra subtração do caixa) —
// dívida que já reduz freeMoney HOJE pode aparecer aqui de novo se o
// vencimento dela cair dentro da janela, exatamente como o pedido especifica
// (item 18: "incluir dívida já incorrida com dueDate dentro desse intervalo,
// mesmo que ela já esteja reduzindo freeMoney atual").
// Pura — extraída de propósito pra ser testável isoladamente, sem banco (Fase
// 4.1.1, item 1/7). [periodStart, periodEnd): início inclusive, fim exclusive.
export function isWithinNextIncomeCommitmentWindow(date, periodStart, periodEnd) {
  return date >= periodStart && date < periodEnd;
}

async function sumObligationsInWindow(periodStart, periodEnd, client = prisma, now = new Date()) {
  const inWindow = (date) => isWithinNextIncomeCommitmentWindow(date, periodStart, periodEnd);

  const [cardBills, bills, externalInstallments, commitments] = await Promise.all([
    client.cardBill.findMany({ where: { dueAt: { gte: periodStart, lt: periodEnd } } }),
    client.bill.findMany({ where: { status: { in: ["pending", "overdue"] }, dueDate: { gte: periodStart, lt: periodEnd } } }),
    client.externalInstallment.findMany({ where: { status: "PENDING", dueDate: { gte: periodStart, lt: periodEnd } } }),
    client.confirmedCommitment.findMany({ where: { status: { in: ["CONFIRMED", "FUNDED"] }, dueDate: { gte: periodStart, lt: periodEnd } } }),
  ]);

  let total = ZERO;
  // Fase 8.0.1 — total autoritativo da fatura (observado quando existe), não o valor guardado.
  const cardsById = new Map((await client.card.findMany()).map((c) => [c.id, c]));
  for (const bill of cardBills) {
    if (!inWindow(bill.dueAt)) continue;
    const effective = await applyObservedTotal(cardsById.get(bill.cardId), { ...bill, isPersisted: true }, { client });
    total = addMoney(total, subtractMoney(money(effective.totalAmount), money(bill.paidAmount ?? 0)));
  }
  for (const bill of bills) total = addMoney(total, money(bill.amount));
  for (const installment of externalInstallments) total = addMoney(total, money(installment.amount));
  for (const commitment of commitments) total = addMoney(total, money(commitment.amount));
  return total;
}

export async function getNextIncomeCommitment({ nextIncome, client = prisma, now = new Date() } = {}) {
  if (!nextIncome) throw new Error("nextIncome é obrigatório (ver lib/incomeHorizon.js:getNextIncomeInfo)");

  const periodStart = startOfDay(nextIncome.expectedDate);
  // Ocorrência seguinte da MESMA cadência (mesmo dia-do-mês, um mês depois) —
  // vale tanto pra uma RecurringRule real quanto pro FALLBACK (que já usa o
  // mesmo passo de um ciclo/mês via AppSettings.cycleStartDay).
  const periodEnd = clampToMonth(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, periodStart.getUTCDate());

  // Fase 5.2B, item 11 — parcelas AFTER_NEXT_INCOME não têm dueDate (não
  // aparecem na busca por intervalo de data acima, que é exclusiva de
  // CALENDAR_DATE), mas contam pra este subtotal. Reaproveita a MESMA
  // classificação de classifyAllObligations (nunca reimplementa "primeira
  // parcela pendente de cada plano" aqui) — exatamente uma parcela por plano,
  // nunca o saldo restante inteiro.
  const [committedInWindow, buckets] = await Promise.all([
    sumObligationsInWindow(periodStart, periodEnd, client, now),
    getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate, client }),
  ]);
  const nextIncomeWindowTotal = buckets[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].total;
  const committedAmount = addMoney(committedInWindow, nextIncomeWindowTotal);
  const expectedIncomeAmount = nextIncome.amount ?? null;
  const committedPercent =
    expectedIncomeAmount != null && isPositive(expectedIncomeAmount)
      ? multiplyMoney(divideMoney(committedAmount, expectedIncomeAmount), 100)
      : null; // nunca inventa denominador (item 18)

  return { expectedIncomeAmount, committedAmount, committedPercent, periodStart, periodEnd };
}
