import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney, maxMoney, ZERO } from "./money.js";

// Decimal-first (Fase 3.1): totalLimit/newUsedLimit/amount/totalAmount já vêm do
// Prisma como Decimal. Todas as funções abaixo devolvem Decimal — serializeMoney()
// só na borda da API.
export async function computeCardTotalLimit(cardId) {
  const [card, lastLimitChange] = await Promise.all([
    prisma.card.findUnique({ where: { id: cardId } }),
    prisma.cardLimitUpdate.findFirst({ where: { cardId, newTotalLimit: { not: null } }, orderBy: { occurredAt: "desc" } }),
  ]);
  return money(lastLimitChange?.newTotalLimit ?? card?.totalLimit);
}

// Limite usado = última âncora (CardLimitUpdate) + gastos/compras no cartão desde então
// - pagamentos de fatura e antecipações de parcela desde então (ambos liberam limite).
export async function computeCardUsedLimit(cardId) {
  const anchor = await prisma.cardLimitUpdate.findFirst({
    where: { cardId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = money(anchor?.newUsedLimit);

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

  let used = base;
  used = addMoney(used, expenseSum._sum.amount);
  used = addMoney(used, purchaseSum._sum.totalAmount);
  used = subtractMoney(used, paymentsSum._sum.amount);
  return maxMoney(ZERO, used);
}

export async function computeCardAvailableLimit(cardId) {
  const [total, used] = await Promise.all([computeCardTotalLimit(cardId), computeCardUsedLimit(cardId)]);
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
