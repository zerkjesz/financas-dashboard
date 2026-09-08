import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";
import { money, addMoney, subtractMoney, compareMoney, isPositive, roundMoney } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";
import { getCardBillPeriod, getCardBillClosesAt, getCardBillDueDate, getCardCycleForDate } from "./cardCycle.js";

// Fase 4.0: a lógica de ciclo (período/fechamento/vencimento) foi extraída pra
// lib/cardCycle.js — este arquivo só CONSOME, nunca mais reimplementa. Fixa o bug
// original da auditoria (computeDueAt somava um mês sempre, certo por acaso só com
// closingDay null) sem manter uma segunda implementação daqui.

// Calcula o valor esperado de uma fatura pra um ciclo — só LEITURA (aggregate),
// nunca escreve nada. Extraída de getOrCreateBill() e exportada especificamente pra
// scripts/audit.js poder recomputar/comparar sem precisar chamar getOrCreateBill()
// (que grava no banco — create/update). getOrCreateBill() continua usando esta
// função internamente pra montar o total antes de decidir se cria/atualiza a linha.
// Decimal-first (Fase 3.1): devolve Decimal, não number.
//
// Fase 5.1B-CARD-v2 — `client` opcional (default: o singleton `prisma`), pra
// permitir chamar esta função DENTRO de uma `prisma.$transaction(async tx =>
// ...)` passando `{ client: tx }`, e assim validar invariantes contra o
// estado AINDA NÃO COMMITADO da própria transação, antes do commit real.
// Mudança 100% aditiva — nenhum call-site existente que não passa `client`
// muda de comportamento (continua usando o `prisma` global, como sempre).
export async function computeExpectedCardBillTotal(card, cycleMonth, { client = prisma } = {}) {
  const { start, end } = getCardBillPeriod(card, cycleMonth);
  const [expenseSum, installmentSum] = await Promise.all([
    client.expense.aggregate({
      where: { cardId: card.id, occurredAt: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    client.installment.aggregate({
      where: { billMonth: cycleMonth, purchase: { cardId: card.id } },
      _sum: { amount: true },
    }),
  ]);
  return addMoney(money(expenseSum._sum.amount), money(installmentSum._sum.amount));
}

// ============================================================================
// Fase 4.1.3 — Card Read Paths Must Be Read-Only.
//
// PERSISTED CardBill = row real no banco (pagamento recebido, parcial,
// fechada por uma operação explícita, ou qualquer outro motivo real de
// persistir). PROJECTED CardBill = valor calculável em memória a partir de
// Card+Purchase+Installment+Expense, pro caso comum de "mostrar a fatura de
// um ciclo que ainda não tem motivo nenhum pra existir como row" — NUNCA gera
// INSERT/UPDATE. As duas têm exatamente o mesmo formato de campos (cycleMonth/
// closesAt/dueAt/totalAmount/paidAmount/status), diferindo só em `isPersisted`
// e em `id` (null quando projetada) — quem consome (UI, engine) não precisa
// saber qual é qual pra maioria dos usos, só não pode tratar `id` como
// garantidamente real.
//
// getCardBillView/listCardBillsView são os ÚNICOS pontos de leitura de fatura
// de cartão que qualquer rota GET/render/dashboard/auditoria deve chamar —
// nunca getOrCreateBill/listBillsForCard (que escrevem). Ver auditoria de
// materialização, achado P0/P1 da Fase 4.1.2, resolvido aqui.
// Fase 5.0.3, item 19 — `now` injetável (default `new Date()`, zero mudança
// de comportamento pra quem já chama sem esse argumento) — mesmo padrão já
// usado no resto do Financial Engine V2 (ex: resolveNextExpectedIncome,
// computeFinancialStatus). Existe só pra permitir testes deterministas com
// data fixa; produção continua usando o relógio real por padrão.
export async function getCardBillView(card, cycleMonth, { now = new Date(), client = prisma } = {}) {
  const persisted = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth } } });
  if (persisted) {
    return { ...persisted, isPersisted: true };
  }

  // Mesma fórmula de status que getOrCreateBill usaria ao criar — só que aqui
  // nunca é gravada. paidAmount/paidAt permanecem null (nenhum pagamento pode
  // existir pra uma fatura que não existe).
  const totalAmount = await computeExpectedCardBillTotal(card, cycleMonth, { client });
  const closesAt = getCardBillClosesAt(card, cycleMonth);
  const dueAt = getCardBillDueDate(card, cycleMonth);
  const status = closesAt < now ? "closed" : "open";

  return {
    id: null,
    cardId: card.id,
    cycleMonth,
    closesAt,
    dueAt,
    totalAmount,
    paidAmount: null,
    status,
    paidAt: null,
    createdAt: null,
    updatedAt: null,
    isPersisted: false,
  };
}

// Substituto READ-ONLY de listBillsForCard — mesma janela de meses, mesma
// ordenação, zero escrita. Quem só precisa EXIBIR faturas (passadas, atual, ou
// uma prévia de futuras) usa isto.
export async function listCardBillsView(cardId, { monthsBack = 2, monthsForward = 12, now = new Date(), client = prisma } = {}) {
  const card = await client.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  const currentCycle = getCardCycleForDate(card, now);
  const months = [];
  for (let i = -monthsBack; i <= monthsForward; i++) {
    months.push(addMonthKey(currentCycle, i));
  }
  const bills = await Promise.all(months.map((month) => getCardBillView(card, month, { now, client })));
  return bills.sort((a, b) => a.cycleMonth.localeCompare(b.cycleMonth));
}

// getOrCreateBill/listBillsForCard (abaixo) CONTINUAM existindo — são
// primitivas de MUTAÇÃO (materializam de verdade), usadas quando uma operação
// explícita realmente precisa de uma row persistida (ex: pagar uma fatura que
// ainda não existe — ver app/api/cards/[id]/bills/[billId]/pay/route.js, e
// scripts de teste que testam a própria materialização). NENHUMA rota
// GET/render/dashboard/auditoria pode chamá-las — auditado em
// scripts/test-card-read-paths-readonly.mjs.
export async function getOrCreateBill(cardId, cycleMonth) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  let bill = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  const closesAt = getCardBillClosesAt(card, cycleMonth);
  const dueAt = getCardBillDueDate(card, cycleMonth);

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

// Resolve a fatura "atual" de um cartão de forma segura pra usos sensíveis
// (antecipação, pagamento por texto/bot).
//
// Fase 4.0: substitui a proteção temporária da Fase 1.2 pela arquitetura
// definitiva — antes, sem uma forma confiável de calcular "qual é o ciclo de HOJE
// pra este cartão", a função "adivinhava" contando quantas faturas em aberto
// existiam (só resolvia se desse EXATAMENTE 1). Agora lib/cardCycle.js resolve
// isso deterministicamente pra QUALQUER cartão (com ou sem closingDay
// configurado) — não tem mais ambiguidade nem contagem: getCardCycleForDate(card,
// now) diz exatamente qual cycleReference é "agora" pra esse cartão específico.
//
// Continua "não adivinhar, falhar explicitamente" — só que agora o motivo de
// falha é outro: a fatura do ciclo de hoje pode ainda não estar MATERIALIZADA no
// banco (getOrCreateBill nunca é chamada aqui de propósito — resolveCurrentBillSafely
// é usada por fluxos sensíveis de escrita, como antecipação/pagamento, e não deve
// ter o efeito colateral de criar uma CardBill nova só por ter sido consultada).
// Na prática isso raramente falha: listBillsForCard já materializa meses ao redor
// de hoje toda vez que a tela de Cartões é carregada.
export async function resolveCurrentBillSafely(cardId, { client = prisma } = {}) {
  const card = await client.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  const cycleReference = getCardCycleForDate(card, new Date());
  const bill = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth: cycleReference } } });
  if (!bill) {
    throw new Error(
      `A fatura do ciclo atual (${cycleReference}) desse cartão (${card.name}) ainda não foi materializada. ` +
        "Abra a tela de Cartões no dashboard uma vez (isso materializa o ciclo) e tente de novo."
    );
  }
  return bill;
}

export async function listBillsForCard(cardId, { monthsBack = 2, monthsForward = 12 } = {}) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card) throw new Error(`Cartão ${cardId} não encontrado`);

  // Ancorado no ciclo REAL de hoje pra este cartão (Fase 4.0) — não mais um
  // "mês calendário de hoje" genérico que ignoraria closingDay se ele existisse.
  const currentCycle = getCardCycleForDate(card, new Date());
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
// Fase 5.3C.2 — `client` opcional, mesmo padrão "própria transação OU
// participa de uma externa" de lib/bills.js:markBillPaid (ver comentário lá)
// — permite compor atomicamente dentro do caminho do Telegram.
export async function payBill(cardBillId, { fromAccountId, amount, description, source, confidence, rawMessage }, { client = prisma } = {}) {
  if (!fromAccountId) throw new Error("Informe a conta de origem do pagamento");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor do pagamento inválido");
  const amountMoney = money(amount);

  const bill = await client.cardBill.findUnique({ where: { id: cardBillId } });
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

  const run = async (tx) => {
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
  };

  if (client === prisma) return prisma.$transaction(run);
  return run(client);
}

// Antecipação: paga uma parte da fatura antes do vencimento sem quitá-la por completo —
// reduz o limite usado do cartão (via lib/cards.js), mas não fecha a CardBill. Recebe o
// id da CardBill (não do Card) pra poder vincular o Transfer a ela via cardBillId, e
// EXIGE fromAccountId — antes isso não debitava conta nenhuma (achado P0-1: dinheiro
// contado duas vezes, disponível na conta E liberando limite do cartão).
export async function anticipateBill(cardBillId, { fromAccountId, amount, description, source, confidence, rawMessage }, { client = prisma } = {}) {
  if (!fromAccountId) throw new Error("Informe a conta de origem da antecipação");
  if (typeof amount !== "number" || !(amount > 0)) throw new Error("Valor da antecipação inválido");
  const amountMoney = money(amount);
  if (!isPositive(amountMoney)) throw new Error("Valor da antecipação inválido");

  const bill = await client.cardBill.findUnique({ where: { id: cardBillId } });
  if (!bill) throw new Error("Fatura não encontrada");

  return client.transfer.create({
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
