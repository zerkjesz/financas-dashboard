import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";

function dayInMonthKey(monthKeyStr, day) {
  const [year, month] = monthKeyStr.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

// Intervalo de occurredAt que pertence ao ciclo `cycleMonth` deste cartão.
// Sem closingDay definido: o ciclo é simplesmente o mês calendário.
// Com closingDay definido: ciclo vai do dia seguinte ao fechamento anterior até o fechamento deste mês.
function cycleRange(card, cycleMonth) {
  if (card.closingDay == null) {
    const start = dayInMonthKey(cycleMonth, 1);
    const end = dayInMonthKey(addMonthKey(cycleMonth, 1), 1);
    return { start, end };
  }
  const end = new Date(dayInMonthKey(cycleMonth, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  const prevMonth = addMonthKey(cycleMonth, -1);
  const start = new Date(dayInMonthKey(prevMonth, card.closingDay).getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function computeClosesAt(card, cycleMonth) {
  if (card.closingDay == null) return dayInMonthKey(addMonthKey(cycleMonth, 1), 1);
  return dayInMonthKey(cycleMonth, card.closingDay);
}

function computeDueAt(card, cycleMonth) {
  return dayInMonthKey(addMonthKey(cycleMonth, 1), card.dueDay);
}

async function computeCycleTotal(card, cycleMonth) {
  const { start, end } = cycleRange(card, cycleMonth);
  const [expenseSum, installmentSum] = await Promise.all([
    prisma.expense.aggregate({
      where: { cardId: card.id, occurredAt: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    prisma.installment.aggregate({
      where: { billMonth: cycleMonth, purchase: { cardId: card.id } },
      _sum: { amount: true },
    }),
  ]);
  return (expenseSum._sum.amount || 0) + (installmentSum._sum.amount || 0);
}

export async function getOrCreateBill(cardId, cycleMonth) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  let bill = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  const closesAt = computeClosesAt(card, cycleMonth);
  const dueAt = computeDueAt(card, cycleMonth);

  if (!bill) {
    const totalAmount = await computeCycleTotal(card, cycleMonth);
    const status = closesAt < new Date() ? "closed" : "open";
    bill = await prisma.cardBill.create({
      data: { cardId, cycleMonth, closesAt, dueAt, totalAmount, status },
    });
    return bill;
  }

  // Recomputa o total enquanto o ciclo ainda pode receber gasto novo (status "open") ou
  // já recebeu pagamento parcial mas ainda não fechou pra novos lançamentos ("partially_
  // paid" não deve travar o total, só "closed"/"paid" travam). Pagamento parcial nunca é
  // sobrescrito de volta pra "open"/"closed" aqui — só payBill muda pra "paid".
  if (bill.status === "open" || bill.status === "partially_paid") {
    const totalAmount = await computeCycleTotal(card, cycleMonth);
    const shouldClose = closesAt < new Date();
    const status = bill.status === "partially_paid" ? "partially_paid" : shouldClose ? "closed" : "open";
    bill = await prisma.cardBill.update({
      where: { id: bill.id },
      data: { totalAmount, status },
    });
  }

  return bill;
}

// Resolve a fatura "atual" de um cartão de forma segura pra usos sensíveis (antecipação,
// pagamento por texto/bot) — sem presumir que mês calendário == ciclo real do cartão.
//
// Enquanto closingDay for null, o próprio getOrCreateBill trata o ciclo como o mês
// calendário (cycleRange, acima), então resolver por mês calendário é seguro e é
// exatamente o que já acontecia. Mas assim que closingDay for preenchido (ex: Itaú
// fecha dia 4), mês calendário deixa de bater com o ciclo real do cartão — nesse caso
// NÃO adivinha um cycleMonth: busca a fatura já existente cujo fechamento (closesAt,
// dado real já persistido) é o próximo a vencer, e se nenhuma existir ainda, falha
// explicitamente em vez de criar uma fatura com cycleMonth possivelmente errado.
// (Norte v2, Fase 1.1 — proteção provisória; a arquitetura de ciclo completa vem depois.)
export async function resolveCurrentBillSafely(cardId) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  if (card.closingDay == null) {
    const currentCycle = new Date().toISOString().slice(0, 7);
    return getOrCreateBill(cardId, currentCycle);
  }

  const now = new Date();
  const bill = await prisma.cardBill.findFirst({
    where: { cardId, closesAt: { gte: now } },
    orderBy: { closesAt: "asc" },
  });
  if (!bill) {
    throw new Error(
      "Não foi possível determinar a fatura atual desse cartão com segurança (fechamento configurado e nenhuma fatura futura já calculada). " +
        "Registre/confirme a fatura pelo dashboard antes de antecipar ou pagar por aqui."
    );
  }
  return bill;
}

export async function listBillsForCard(cardId, { monthsBack = 2, monthsForward = 12 } = {}) {
  const now = new Date();
  const currentCycle = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const months = [];
  for (let i = -monthsBack; i <= monthsForward; i++) {
    months.push(addMonthKey(currentCycle, i));
  }
  const bills = [];
  for (const month of months) {
    bills.push(await getOrCreateBill(cardId, month));
  }
  return bills.sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
}

// Status é sempre derivado de paidAmount vs totalAmount, nunca setado direto pra
// "paid" — um pagamento parcial NÃO pode fechar a fatura como paga (ver AUDITORIA,
// achado P0-2). Saldo credor (pagar mais que o restante) ainda não tem onde ser
// guardado no schema — por ora isso é rejeitado com erro claro em vez de aceito e
// perdido silenciosamente (achado P0-3; o campo `creditBalance` fica pra Fase 3).
export async function payBill(cardBillId, { fromAccountId, amount, description, source, rawMessage }) {
  if (!fromAccountId) throw new Error("Informe a conta de origem do pagamento");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor do pagamento inválido");

  const bill = await prisma.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  const alreadyPaid = bill.paidAmount || 0;
  const remaining = Math.round((bill.totalAmount - alreadyPaid) * 100) / 100;
  if (amount > remaining + 0.01) {
    throw new Error(
      `Pagamento de R$${amount.toFixed(2)} é maior que o restante da fatura (R$${remaining.toFixed(2)}). ` +
        `Saldo credor ainda não é suportado — pague no máximo o valor restante.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.transfer.create({
      data: {
        amount,
        description: description || `Pagamento fatura ${bill.cycleMonth}`,
        fromAccountId,
        toCardId: bill.cardId,
        cardBillId: bill.id,
        kind: "card_bill_payment",
        source: source || "manual",
        rawMessage: rawMessage || null,
      },
    });
    const newPaidAmount = Math.round((alreadyPaid + amount) * 100) / 100;
    const status = newPaidAmount >= bill.totalAmount - 0.01 ? "paid" : "partially_paid";
    const updated = await tx.cardBill.update({
      where: { id: bill.id },
      data: { status, paidAt: new Date(), paidAmount: newPaidAmount },
    });
    return { transfer, bill: updated };
  });
}

// Antecipação: paga uma parte da fatura antes do vencimento sem quitá-la por completo —
// reduz o limite usado do cartão (via lib/cards.js), mas não fecha a CardBill. Recebe o
// id da CardBill (não do Card) pra poder vincular o Transfer a ela via cardBillId, e
// EXIGE fromAccountId — antes isso não debitava conta nenhuma (achado P0-1: dinheiro
// contado duas vezes, disponível na conta E liberando limite do cartão).
export async function anticipateBill(cardBillId, { fromAccountId, amount, description, source, rawMessage }) {
  if (!fromAccountId) throw new Error("Informe a conta de origem da antecipação");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor da antecipação inválido");

  const bill = await prisma.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  return prisma.transfer.create({
    data: {
      amount,
      description: description || "Antecipação de fatura",
      fromAccountId,
      toCardId: bill.cardId,
      cardBillId: bill.id,
      kind: "installment_anticipation",
      source: source || "manual",
      rawMessage: rawMessage || null,
    },
  });
}
