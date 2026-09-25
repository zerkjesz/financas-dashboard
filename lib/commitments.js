import { prisma } from "./prisma.js";
import { money } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — ConfirmedCommitment: obrigação confirmada sem origem definida ainda.
// Estados com semântica explícita, decisão bloqueante da Fase 2 (nunca reabrir):
//   CONFIRMED — a obrigação é real, nenhuma decisão de funding ainda.
//   FUNDED    — já existe decisão de origem do dinheiro. NÃO significa que o
//               pagamento aconteceu — nunca cria Expense sozinho.
//   SETTLED   — o movimento financeiro real aconteceu e está vinculado (expenseId).
//   CANCELLED — descartado; nunca pode virar SETTLED depois.

// ============================================================================
// READ
// ============================================================================

export async function listCommitments({ status, client = prisma } = {}) {
  return client.confirmedCommitment.findMany({
    where: status ? { status } : undefined,
    // Fase 8.0.1 — dueDate pode ser null ("sem prazo definido"): datados primeiro, por data;
    // os sem prazo ao final (explícito — não depende do default de nulls do banco).
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export async function getCommitment(id, { client = prisma } = {}) {
  return client.confirmedCommitment.findUnique({ where: { id } });
}

// ============================================================================
// MUTATION
// ============================================================================

// Fase 7.0 — `client` opcional (default: `prisma`), mesmo padrão aditivo já
// usado em commitBotIntent.js/cardBillCalculator.js: permite chamar isto
// DENTRO de uma prisma.$transaction externa (o pipeline conversacional do
// Telegram, pra que um plano com várias actions — ex.: uma despesa +
// um compromisso na mesma mensagem — grave tudo atômico ou nada). Nenhum
// call site existente (que não passa client) muda de comportamento.
// Fase 8.0.1 — `dueDate` é OPCIONAL: null/undefined = "sem prazo definido". NUNCA é
// preenchido com uma data fictícia; todo consumidor trata null (ver
// lib/obligationClassifier.js:classifyConfirmedCommitment). Uma data informada mas
// inválida continua sendo erro (não vira null em silêncio).
export async function createCommitment({ description, amount, dueDate, notes, confidence } = {}, { client = prisma } = {}) {
  if (!description) throw new Error("description é obrigatória");
  const amountMoney = money(amount);
  if (!amountMoney.gt(0)) throw new Error("amount precisa ser positivo");
  let due = null;
  if (dueDate != null) {
    due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) throw new Error("dueDate inválida");
  }

  return client.confirmedCommitment.create({
    data: {
      description,
      amount: amountMoney,
      dueDate: due,
      notes: notes || null,
      confidence: resolveConfidence(confidence),
    },
  });
}

// Atualiza amount/dueDate de um commitment ainda não SETTLED/CANCELLED —
// não existia antes (só existiam funding/settle/cancel); necessário pro
// UPDATE_CONFIRMED_COMMITMENT do plano conversacional ("na verdade são
// R$300, não R$250").
// Fase 8.0.1 — `dueDate`: undefined = não mexe; null = LIMPA o prazo ("sem prazo definido");
// data = define.
export async function updateCommitmentDetails(commitmentId, details = {}, { client = prisma } = {}) {
  const { amount, dueDate } = details;
  const commitment = await client.confirmedCommitment.findUnique({ where: { id: commitmentId } });
  if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
  if (commitment.status === "SETTLED" || commitment.status === "CANCELLED") {
    throw new Error(`Commitment ${commitment.status} não pode ser editado`);
  }
  const data = {};
  if (amount != null) data.amount = money(amount);
  if (dueDate === null) data.dueDate = null;
  else if (dueDate !== undefined) {
    const due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) throw new Error("dueDate inválida");
    data.dueDate = due;
  }
  if (Object.keys(data).length === 0) throw new Error("nada pra atualizar");
  return client.confirmedCommitment.update({ where: { id: commitmentId }, data });
}

// Funding por Reserve — ATÔMICO (Fase 3.3, item 4): cria o ReserveMovement RELEASE,
// atualiza fundingReserveId/fundedAt e marca o commitment FUNDED, tudo numa única
// prisma.$transaction. Nunca fica uma reserva liberada com o commitment ainda
// CONFIRMED, nem um commitment FUNDED sem o RELEASE correspondente no ledger.
//
// v1: funda o VALOR CHEIO do commitment de uma vez (sem funding parcial — não
// pedido nesta fase). Só permitido a partir de CONFIRMED (não FUNDED/SETTLED/
// CANCELLED) — evita fundar duas vezes ou fundar algo já descartado.
export async function fundCommitmentFromReserve(commitmentId, reserveId, { note, confidence, occurredAt } = {}) {
  const commitment = await prisma.confirmedCommitment.findUnique({ where: { id: commitmentId } });
  if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
  if (commitment.status !== "CONFIRMED") {
    throw new Error(`Só é possível fundar um commitment CONFIRMED (status atual: ${commitment.status})`);
  }

  return prisma.$transaction(async (tx) => {
    const movement = await tx.reserveMovement.create({
      data: {
        reserveId,
        amount: money(commitment.amount),
        kind: "RELEASE",
        note: note || `Funding de "${commitment.description}"`,
        confidence: resolveConfidence(confidence),
        occurredAt: occurredAt || undefined,
      },
    });
    const updated = await tx.confirmedCommitment.update({
      where: { id: commitmentId },
      data: { status: "FUNDED", fundingReserveId: reserveId, fundedAt: new Date() },
    });
    return { commitment: updated, reserveMovement: movement };
  });
}

// Funding por Account (Fase 4.0, item 15) — semântica mínima: FUNDED aqui
// significa earmark/intenção de usar caixa irrestrito, nada mais. Diferente do
// funding por Reserve (que move um ReserveMovement RELEASE de verdade), fundar
// por Account é só uma ANOTAÇÃO — não cria Expense, não altera Account.balance
// (nenhum BalanceAdjustment/Income/Expense/Transfer é criado), não cria
// ReserveMovement nenhum. Ainda não calcula freeMoney (isso é fase futura) — só
// muda o status/earmark do commitment.
export async function fundCommitmentFromAccount(commitmentId, accountId) {
  if (!accountId) throw new Error("accountId é obrigatório");

  return prisma.$transaction(async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
    if (commitment.status !== "CONFIRMED") {
      throw new Error(`Só é possível fundar um commitment CONFIRMED (status atual: ${commitment.status})`);
    }
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) throw new Error("Account não encontrada");

    return tx.confirmedCommitment.update({
      where: { id: commitmentId },
      data: { status: "FUNDED", fundingAccountId: accountId, fundedAt: new Date() },
    });
  });
}

// Núcleo compartilhado das duas formas de settlement (opção A: vincular Expense já
// existente; opção B: criar o Expense na mesma transação) — evita duplicar a regra
// de transição de estado/validação em dois lugares.
async function applySettlement(tx, commitment, expenseId) {
  if (commitment.status === "SETTLED") {
    throw new Error("Commitment já está SETTLED — settlement duplicado rejeitado");
  }
  if (commitment.status === "CANCELLED") {
    throw new Error("Commitment CANCELLED não pode ser settled");
  }
  return tx.confirmedCommitment.update({
    where: { id: commitment.id },
    data: { status: "SETTLED", expenseId, settledAt: new Date() },
  });
}

// Opção A — vincula um Expense JÁ EXISTENTE (ex: o usuário já lançou o gasto antes
// de mexer no commitment). expenseId único no schema impede vincular o mesmo
// Expense a dois commitments. `client` opcional (Fase 7.0, mesmo padrão de
// payBill/anticipateBill em cardBillCalculator.js): participa da transação
// externa se uma for passada, senão abre a sua própria.
export async function settleCommitmentWithExpense(commitmentId, expenseId, { client = prisma } = {}) {
  if (!expenseId) throw new Error("expenseId é obrigatório");
  const run = async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
    return applySettlement(tx, commitment, expenseId);
  };
  if (client === prisma) return prisma.$transaction(run);
  return run(client);
}

// Opção B — cria o Expense (a partir do valor/descrição do commitment, com
// possibilidade de override) E já vincula, na mesma transação. Reusa
// applySettlement pra não duplicar a regra de transição de estado. `client`
// opcional — mesmo padrão acima.
export async function settleCommitmentCreatingExpense(commitmentId, { accountId, cardId, description, category, occurredAt, confidence } = {}, { client = prisma } = {}) {
  if (!accountId && !cardId) throw new Error("Informe accountId ou cardId pra registrar o Expense do settlement");

  const run = async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
    if (commitment.status === "SETTLED") throw new Error("Commitment já está SETTLED — settlement duplicado rejeitado");
    if (commitment.status === "CANCELLED") throw new Error("Commitment CANCELLED não pode ser settled");

    const expense = await tx.expense.create({
      data: {
        amount: money(commitment.amount),
        description: description || commitment.description,
        category: category || "Outros",
        accountId: accountId || null,
        cardId: cardId || null,
        source: "manual",
        confidence: resolveConfidence(confidence),
        occurredAt: occurredAt || new Date(),
      },
    });
    const updated = await applySettlement(tx, commitment, expense.id);
    return { commitment: updated, expense };
  };
  if (client === prisma) return prisma.$transaction(run);
  return run(client);
}

export async function cancelCommitment(commitmentId, { client = prisma } = {}) {
  const commitment = await client.confirmedCommitment.findUnique({ where: { id: commitmentId } });
  if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
  if (commitment.status === "SETTLED") throw new Error("Commitment já SETTLED não pode ser cancelado");
  return client.confirmedCommitment.update({ where: { id: commitmentId }, data: { status: "CANCELLED" } });
}
