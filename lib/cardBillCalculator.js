import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";
import { money, addMoney, subtractMoney, compareMoney, isPositive, roundMoney } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

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

// Calcula o valor esperado de uma fatura pra um ciclo — só LEITURA (aggregate),
// nunca escreve nada. Extraída de getOrCreateBill() e exportada especificamente pra
// scripts/audit.js poder recomputar/comparar sem precisar chamar getOrCreateBill()
// (que grava no banco — create/update). getOrCreateBill() continua usando esta
// função internamente pra montar o total antes de decidir se cria/atualiza a linha.
// Decimal-first (Fase 3.1): devolve Decimal, não number.
export async function computeExpectedCardBillTotal(card, cycleMonth) {
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
  return addMoney(money(expenseSum._sum.amount), money(installmentSum._sum.amount));
}

export async function getOrCreateBill(cardId, cycleMonth) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  let bill = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  const closesAt = computeClosesAt(card, cycleMonth);
  const dueAt = computeDueAt(card, cycleMonth);

  if (!bill) {
    const totalAmount = await computeExpectedCardBillTotal(card, cycleMonth);
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
    const totalAmount = await computeExpectedCardBillTotal(card, cycleMonth);
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
// closingDay === null NÃO significa "o cartão usa mês calendário real" — significa
// apenas que o ciclo real ainda não foi configurado no banco (ex: o Itaú fecha dia 4 e
// vence dia 11 de verdade, mas closingDay ainda está null hoje). Enquanto a lógica
// definitiva de ciclo não existir (fica pra fase de ciclo do cartão), esta função NUNCA
// cria uma CardBill nova baseada em mês calendário (era exatamente esse o problema:
// adivinhar cycleMonth) — só resolve automaticamente se existir EXATAMENTE UMA fatura
// em aberto (não paga) pra esse cartão. Havendo zero ou mais de uma, falha
// explicitamente. É aceitável bloquear pagamento/antecipação pelo bot temporariamente
// até o ciclo real existir — Telegram é principalmente entrada de dados, não precisa
// resolver ambiguidade sozinho. (Norte v2, Fase 1.2.)
export async function resolveCurrentBillSafely(cardId) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  const unpaidBills = await prisma.cardBill.findMany({
    where: { cardId, status: { in: ["open", "closed", "partially_paid"] } },
  });

  if (unpaidBills.length === 1) return unpaidBills[0];

  if (unpaidBills.length === 0) {
    throw new Error("Não há nenhuma fatura em aberto pra esse cartão. Registre pelo dashboard.");
  }
  throw new Error(
    `Existem ${unpaidBills.length} faturas em aberto pra esse cartão (${card.name}) e o ciclo real dele ainda não está configurado — ` +
      `não dá pra saber com segurança qual delas você quer sem adivinhar. Pague ou antecipe pelo dashboard, escolhendo a fatura certa.`
  );
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
//
// Decimal-first (Fase 3.1): `amount` chega como number puro (vem do corpo da
// requisição HTTP/bot — fronteira de entrada, Etapa 8) e é convertido pra Decimal
// já na primeira linha, via money(). Todo o resto do cálculo fica em Decimal.
export async function payBill(cardBillId, { fromAccountId, amount, description, source, confidence, rawMessage }) {
  if (!fromAccountId) throw new Error("Informe a conta de origem do pagamento");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor do pagamento inválido");
  const amountMoney = money(amount);

  const bill = await prisma.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  const alreadyPaid = money(bill.paidAmount);
  const remaining = roundMoney(subtractMoney(bill.totalAmount, alreadyPaid));
  // amount > remaining + 0.01 (tolerância antiga de float) vira comparação exata:
  // amount só pode exceder remaining por causa de arredondamento de centavo, nunca
  // mais que isso — compareMoney(amount, remaining) > 0 já é exato em Decimal, sem
  // precisar de margem de tolerância nenhuma.
  if (compareMoney(amountMoney, remaining) > 0) {
    throw new Error(
      `Pagamento de R$${roundMoney(amountMoney).toFixed(2)} é maior que o restante da fatura (R$${remaining.toFixed(2)}). ` +
        `Saldo credor ainda não é suportado — pague no máximo o valor restante.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const transfer = await tx.transfer.create({
      data: {
        amount: amountMoney,
        description: description || `Pagamento fatura ${bill.cycleMonth}`,
        fromAccountId,
        toCardId: bill.cardId,
        cardBillId: bill.id,
        kind: "card_bill_payment",
        source: source || "manual",
        confidence: resolveConfidence(confidence),
        rawMessage: rawMessage || null,
      },
    });
    const newPaidAmount = roundMoney(addMoney(alreadyPaid, amountMoney));
    const status = compareMoney(newPaidAmount, bill.totalAmount) >= 0 ? "paid" : "partially_paid";
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
export async function anticipateBill(cardBillId, { fromAccountId, amount, description, source, confidence, rawMessage }) {
  if (!fromAccountId) throw new Error("Informe a conta de origem da antecipação");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor da antecipação inválido");
  const amountMoney = money(amount);
  if (!isPositive(amountMoney)) throw new Error("Valor da antecipação inválido");

  const bill = await prisma.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  return prisma.transfer.create({
    data: {
      amount: amountMoney,
      description: description || "Antecipação de fatura",
      fromAccountId,
      toCardId: bill.cardId,
      cardBillId: bill.id,
      kind: "installment_anticipation",
      source: source || "manual",
      confidence: resolveConfidence(confidence),
      rawMessage: rawMessage || null,
    },
  });
}
