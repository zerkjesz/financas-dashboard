import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney, maxMoney, ZERO } from "./money.js";
import { anchorExtraWindow, sumCalendarExtras } from "./anchorOrdering.js";

// Decimal-first (Fase 3.1): totalLimit/newUsedLimit/amount/totalAmount já vêm do
// Prisma como Decimal. Todas as funções abaixo devolvem Decimal — serializeMoney()
// só na borda da API.
// Fase 5.1B-CARD-v2 — `client` opcional (default: o singleton `prisma`),
// mesmo padrão de lib/cardBillCalculator.js: permite validar invariantes
// DENTRO de uma `prisma.$transaction(async tx => ...)` passando
// `{ client: tx }`, contra o estado ainda não commitado. Aditivo — nenhum
// call-site existente muda de comportamento.
export async function computeCardTotalLimit(cardId, { client = prisma } = {}) {
  const [card, lastLimitChange] = await Promise.all([
    client.card.findUnique({ where: { id: cardId } }),
    client.cardLimitUpdate.findFirst({ where: { cardId, newTotalLimit: { not: null } }, orderBy: { occurredAt: "desc" } }),
  ]);
  return money(lastLimitChange?.newTotalLimit ?? card?.totalLimit);
}

// Limite usado = última âncora (CardLimitUpdate) + gastos/compras no cartão desde então
// - pagamentos de fatura e antecipações de parcela desde então (ambos liberam limite).
export async function computeCardUsedLimit(cardId, { client = prisma } = {}) {
  const anchor = await client.cardLimitUpdate.findFirst({
    where: { cardId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = money(anchor?.newUsedLimit);

  const [expenseSum, purchaseSum, paymentsSum] = await Promise.all([
    client.expense.aggregate({ where: { cardId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    client.purchase.aggregate({ where: { cardId, purchasedAt: { gt: since } }, _sum: { totalAmount: true } }),
    client.transfer.aggregate({
      where: {
        toCardId: cardId,
        kind: { in: ["card_bill_payment", "installment_anticipation"] },
        occurredAt: { gt: since },
      },
      _sum: { amount: true },
    }),
  ]);

  // Fase 10.4 — mesma regra de ordenação de lib/accounts.js (âncora em fim do dia local; lançamentos-calendário do dia seguinte contam).
  const win = anchorExtraWindow(anchor?.occurredAt);
  const [xExp, xPur, xPay] = await Promise.all([
    sumCalendarExtras(client.expense, { cardId }, win),
    sumCalendarExtras(client.purchase, { cardId }, win, { dateField: "purchasedAt", field: "totalAmount" }),
    sumCalendarExtras(client.transfer, { toCardId: cardId, kind: { in: ["card_bill_payment", "installment_anticipation"] } }, win),
  ]);

  let used = base;
  used = addMoney(used, addMoney(expenseSum._sum.amount, xExp));
  used = addMoney(used, addMoney(purchaseSum._sum.totalAmount, xPur));
  used = subtractMoney(used, addMoney(paymentsSum._sum.amount, xPay));
  return maxMoney(ZERO, used);
}

export async function computeCardAvailableLimit(cardId, { client = prisma } = {}) {
  const [total, used] = await Promise.all([computeCardTotalLimit(cardId, { client }), computeCardUsedLimit(cardId, { client })]);
  return subtractMoney(total, used);
}

export async function computeAmountAnticipated(cardId) {
  const sum = await prisma.transfer.aggregate({
    where: { toCardId: cardId, kind: "installment_anticipation" },
    _sum: { amount: true },
  });
  return money(sum._sum.amount);
}

export async function listCardsWithLimits() {
  const cards = await prisma.card.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(
    cards.map(async (card) => {
      // total/usado calculados uma vez só e reaproveitados — computeCardAvailableLimit
      // recalcularia os dois de novo, dobrando as queries à toa.
      const [totalLimit, usedLimit, amountAnticipated] = await Promise.all([
        computeCardTotalLimit(card.id),
        computeCardUsedLimit(card.id),
        computeAmountAnticipated(card.id),
      ]);
      return { ...card, totalLimit, usedLimit, availableLimit: subtractMoney(totalLimit, usedLimit), amountAnticipated };
    })
  );
}

export async function getCardBySlug(slug) {
  return prisma.card.findUnique({ where: { slug } });
}
