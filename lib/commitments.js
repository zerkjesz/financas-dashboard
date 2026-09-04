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

export async function listCommitments({ status } = {}) {
  return prisma.confirmedCommitment.findMany({
    where: status ? { status } : undefined,
    orderBy: { dueDate: "asc" },
  });
}

export async function getCommitment(id) {
  return prisma.confirmedCommitment.findUnique({ where: { id } });
}

// ============================================================================
// MUTATION
// ============================================================================

export async function createCommitment({ description, amount, dueDate, notes, confidence } = {}) {
  if (!description) throw new Error("description é obrigatória");
  const amountMoney = money(amount);
  if (!amountMoney.gt(0)) throw new Error("amount precisa ser positivo");
  if (!dueDate) throw new Error("dueDate é obrigatória");

  return prisma.confirmedCommitment.create({
    data: {
      description,
      amount: amountMoney,
      dueDate: new Date(dueDate),
      notes: notes || null,
      confidence: resolveConfidence(confidence),
    },
  });
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
// Expense a dois commitments.
export async function settleCommitmentWithExpense(commitmentId, expenseId) {
  if (!expenseId) throw new Error("expenseId é obrigatório");
  return prisma.$transaction(async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
    return applySettlement(tx, commitment, expenseId);
  });
}

// Opção B — cria o Expense (a partir do valor/descrição do commitment, com
// possibilidade de override) E já vincula, na mesma transação. Reusa
// applySettlement pra não duplicar a regra de transição de estado.
export async function settleCommitmentCreatingExpense(commitmentId, { accountId, cardId, description, category, occurredAt, confidence } = {}) {
  if (!accountId && !cardId) throw new Error("Informe accountId ou cardId pra registrar o Expense do settlement");

  return prisma.$transaction(async (tx) => {
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
  });
}

export async function cancelCommitment(commitmentId) {
  const commitment = await prisma.confirmedCommitment.findUnique({ where: { id: commitmentId } });
  if (!commitment) throw new Error("ConfirmedCommitment não encontrado");
  if (commitment.status === "SETTLED") throw new Error("Commitment já SETTLED não pode ser cancelado");
  return prisma.confirmedCommitment.update({ where: { id: commitmentId }, data: { status: "CANCELLED" } });
}
