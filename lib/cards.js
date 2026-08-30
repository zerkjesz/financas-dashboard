import { prisma } from "./prisma.js";

export async function computeCardTotalLimit(cardId) {
  const [card, lastLimitChange] = await Promise.all([
    prisma.card.findUnique({ where: { id: cardId } }),
    prisma.cardLimitUpdate.findFirst({ where: { cardId, newTotalLimit: { not: null } }, orderBy: { occurredAt: "desc" } }),
  ]);
  return lastLimitChange?.newTotalLimit ?? card?.totalLimit ?? 0;
}

// Limite usado = última âncora (CardLimitUpdate) + gastos/compras no cartão desde então
// - pagamentos de fatura e antecipações de parcela desde então (ambos liberam limite).
export async function computeCardUsedLimit(cardId) {
  const anchor = await prisma.cardLimitUpdate.findFirst({
    where: { cardId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = anchor?.newUsedLimit ?? 0;

  const [expenseSum, purchaseSum, paymentsSum] = await Promise.all([
    prisma.expense.aggregate({ where: { cardId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.purchase.aggregate({ where: { cardId, purchasedAt: { gt: since } }, _sum: { totalAmount: true } }),
    prisma.transfer.aggregate({
      where: {
        toCardId: cardId,
        kind: { in: ["card_bill_payment", "installment_anticipation"] },
        occurredAt: { gt: since },
      },
      _sum: { amount: true },
    }),
  ]);

  const used =
    base + (expenseSum._sum.amount || 0) + (purchaseSum._sum.totalAmount || 0) - (paymentsSum._sum.amount || 0);
  return Math.max(0, used);
}

export async function computeCardAvailableLimit(cardId) {
  const [total, used] = await Promise.all([computeCardTotalLimit(cardId), computeCardUsedLimit(cardId)]);
  return total - used;
}

export async function computeAmountAnticipated(cardId) {
  const sum = await prisma.transfer.aggregate({
    where: { toCardId: cardId, kind: "installment_anticipation" },
    _sum: { amount: true },
  });
  return sum._sum.amount || 0;
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
      return { ...card, totalLimit, usedLimit, availableLimit: totalLimit - usedLimit, amountAnticipated };
    })
  );
}

export async function getCardBySlug(slug) {
  return prisma.card.findUnique({ where: { slug } });
}
