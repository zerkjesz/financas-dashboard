// ============================================================================
// Fase 10 — READ-MODEL do cartão ITAÚ (área /cartoes v5). SOMENTE LEITURA: nenhuma escrita, nenhuma
// materialização de fatura. Carrega os dados reais (fatura observada, parcelas, calendário, âncora de limite)
// e delega os cálculos a lib/cardsItauPure.js. Ver a procedência (AUTHORITATIVE/DERIVED/ESTIMATED/UNKNOWN)
// no cabeçalho daquele arquivo.
// ============================================================================
import { prisma } from "./prisma.js";
import { serializeMoney } from "./money.js";
import { listCardBillsView, computeExpectedCardBillTotal } from "./cardBillCalculator.js";
import { computeCardTotalLimit, computeCardUsedLimit } from "./cards.js";
import { getCardBillPeriod, getCardCycleForDate } from "./cardCycle.js";
import { resolveCurrentRelevantCardBillCycleMonth } from "./freeMoney.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { buildActiveInstallments, buildFutureBills, buildRelief, buildCommitmentSeries, computeLimitKnowledge, cleanPurchaseName, monthLong, round2 } from "./cardsItauPure.js";

const num = (x) => (x == null ? null : Number(serializeMoney(x)));
const utcDayMs = (d) => Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth(), new Date(d).getUTCDate());
const isoDay = (d) => new Date(utcDayMs(d)).toISOString().slice(0, 10);

export async function buildItauModel({ now = new Date(), client = prisma, cardId } = {}) {
  const card = cardId ? await client.card.findUnique({ where: { id: cardId } }) : await client.card.findFirst({ orderBy: { createdAt: "asc" } });
  if (!card) return null;
  const todayMs = localCalendarDateAsUtcMidnight(now, getAppTimezone()).getTime();
  const daysTo = (d) => Math.round((utcDayMs(d) - todayMs) / 86400000);

  const [views, purchases, anchor, totalLimit, derivedUsed] = await Promise.all([
    listCardBillsView(card.id, { now, client }),
    client.purchase.findMany({ where: { cardId: card.id }, include: { installments: true }, orderBy: { purchasedAt: "asc" } }),
    client.cardLimitUpdate.findFirst({ where: { cardId: card.id }, orderBy: { occurredAt: "desc" } }),
    computeCardTotalLimit(card.id, { client }),
    computeCardUsedLimit(card.id, { client }),
  ]);

  const currentCycle = resolveCurrentRelevantCardBillCycleMonth(views) ?? getCardCycleForDate(card, now);
  const view = views.find((v) => v.cycleMonth === currentCycle) ?? views[0];

  // ---- parcelas (fonte: Purchase/Installment) ----
  const installmentRows = [];
  for (const p of purchases) {
    const maxNumber = p.installments.reduce((m, i) => Math.max(m, i.number), 0);
    for (const i of p.installments) installmentRows.push({ purchaseId: p.id, purchaseName: cleanPurchaseName(p.description), number: i.number, amount: num(i.amount), billMonth: i.billMonth, isLast: i.number === maxNumber });
  }
  const activePurchases = purchases.map((p) => ({ id: p.id, description: p.description, totalAmount: num(p.totalAmount), installmentCount: p.installmentCount, installmentValue: num(p.installmentValue), installments: p.installments.map((i) => ({ number: i.number, amount: num(i.amount), billMonth: i.billMonth })) }));
  const installments = buildActiveInstallments(activePurchases, currentCycle);

  // ---- fatura corrente: total autoritativo + composição conhecida ----
  const total = num(view.totalAmount);
  const paid = num(view.paidAmount) ?? 0;
  const knownDetail = num(await computeExpectedCardBillTotal(card, currentCycle, { client }));
  const installmentsInCurrent = round2(installmentRows.filter((r) => r.billMonth === currentCycle).reduce((a, r) => a + r.amount, 0));
  const unknownDetail = view.totalSource === "observed" ? Math.max(0, num(view.knownDetailGap)) : Math.max(0, round2(total - knownDetail));
  const closesAt = view.closesAt;
  const dueAt = view.dueAt;
  const isClosed = utcDayMs(closesAt) < todayMs || view.status === "closed";
  const currentBill = {
    cycleMonth: currentCycle,
    monthLong: monthLong(currentCycle),
    status: view.status,
    isClosed,
    total,
    remaining: Math.max(0, round2(total - paid)),
    paidAmount: paid,
    totalSource: view.totalSource, // observed | stored | calculated
    observedAt: view.observedAt ? new Date(view.observedAt).toISOString() : null,
    installments: installmentsInCurrent,
    purchases: Math.max(0, round2(knownDetail - installmentsInCurrent)),
    unknownDetail: round2(unknownDetail),
    closesAt: isoDay(closesAt),
    dueAt: isoDay(dueAt),
    daysToClose: daysTo(closesAt),
    daysToDue: daysTo(dueAt),
  };

  // ---- compras avulsas já lançadas em ciclos SEGUINTES (conhecidas; nunca projetadas) ----
  const periodEnd = getCardBillPeriod(card, currentCycle).end;
  const laterExpenses = await client.expense.findMany({ where: { cardId: card.id, occurredAt: { gte: periodEnd } }, select: { amount: true, occurredAt: true } });
  const futureExpenseByCycle = {};
  for (const e of laterExpenses) {
    const c = getCardCycleForDate(card, e.occurredAt);
    if (c > currentCycle) futureExpenseByCycle[c] = round2((futureExpenseByCycle[c] ?? 0) + num(e.amount));
  }

  const rows = buildFutureBills({ card, currentCycle, currentBill, installmentRows, futureExpenseByCycle });
  const relief = buildRelief(rows, installments.length);
  const futureKnown = round2(
    installmentRows.filter((r) => r.billMonth > currentCycle).reduce((a, r) => a + r.amount, 0) + Object.values(futureExpenseByCycle).reduce((a, v) => a + v, 0)
  );
  const limit = computeLimitKnowledge({ totalLimit: num(totalLimit), anchor, derivedUsed: num(derivedUsed), currentRemaining: currentBill.remaining, futureKnown, knownDetailGap: currentBill.unknownDetail, now });
  const commitmentSeries = buildCommitmentSeries({ rows, currentRemaining: currentBill.remaining, totalLimit: limit.total });

  return {
    card: { id: card.id, name: card.name, slug: card.slug, closingDay: card.closingDay, dueDay: card.dueDay, totalLimit: limit.total },
    currentBill,
    limit,
    futureBills: rows.map((r) => ({ ...r, closesAt: isoDay(r.closesAt), dueAt: isoDay(r.dueAt) })),
    relief,
    commitmentSeries,
    installments,
    installmentsSummary: { activeCount: installments.length, remainingTotal: round2(installments.reduce((a, i) => a + i.remainingAmount, 0)) },
    purchaseSimulator: { minAmount: 50, maxAmount: Math.max(50, Math.floor(limit.total / 10) * 10), step: 10, options: [1, 2, 3, 6, 10] },
  };
}
