import { prisma } from "./prisma.js";
import { money } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — Receivable: dinheiro a receber. Enquanto PENDING, nunca altera
// Account nem unrestrictedCash — e NUNCA vira "recebido" só porque expectedDate já
// passou (isso seria inventar dinheiro que ainda não existe de verdade).

// ============================================================================
// READ
// ============================================================================

export async function listReceivables({ status } = {}) {
  return prisma.receivable.findMany({
    where: status ? { status } : undefined,
    orderBy: { expectedDate: "asc" },
  });
}

// ============================================================================
// MUTATION
// ============================================================================

// Fase 7.0 — `client` opcional (default: `prisma`), mesmo padrão aditivo do
// resto do domínio financeiro — participa da transação do pipeline
// conversacional do Telegram quando uma é passada.
export async function createReceivable({ description, counterparty, amount, expectedDate, notes, confidence } = {}, { client = prisma } = {}) {
  if (!description) throw new Error("description é obrigatória");
  if (!counterparty) throw new Error("counterparty é obrigatório");
  const amountMoney = money(amount);
  if (!amountMoney.gt(0)) throw new Error("amount precisa ser positivo");

  return client.receivable.create({
    data: {
      description,
      counterparty,
      amount: amountMoney,
      expectedDate: expectedDate ? new Date(expectedDate) : null,
      notes: notes || null,
      confidence: resolveConfidence(confidence),
    },
  });
}

// Transacional + idempotente: cria o Income real e vincula, tudo numa
// prisma.$transaction. Rejeita explicitamente se o Receivable já estiver RECEIVED
// (nunca cria um segundo Income pro mesmo recebimento) — e o `@unique` em
// Receivable.incomeId garante no banco que o mesmo Income nunca fica vinculado a
// dois receivables diferentes.
export async function markReceivableReceived(receivableId, { accountId, occurredAt, description, category, confidence } = {}) {
  if (!accountId) throw new Error("accountId é obrigatório");

  return prisma.$transaction(async (tx) => {
    const receivable = await tx.receivable.findUnique({ where: { id: receivableId } });
    if (!receivable) throw new Error("Receivable não encontrado");
    if (receivable.status === "RECEIVED") {
      throw new Error("Receivable já está RECEIVED — recebimento duplicado rejeitado");
    }
    if (receivable.status === "CANCELLED") {
      throw new Error("Receivable CANCELLED não pode ser marcado como recebido");
    }

    const income = await tx.income.create({
      data: {
        amount: money(receivable.amount),
        description: description || receivable.description,
        category: category || "Outros",
        accountId,
        source: "manual",
        confidence: resolveConfidence(confidence),
        occurredAt: occurredAt || new Date(),
      },
    });
    const updated = await tx.receivable.update({
      where: { id: receivableId },
      data: { status: "RECEIVED", incomeId: income.id },
    });
    return { receivable: updated, income };
  });
}

export async function cancelReceivable(receivableId) {
  const receivable = await prisma.receivable.findUnique({ where: { id: receivableId } });
  if (!receivable) throw new Error("Receivable não encontrado");
  if (receivable.status === "RECEIVED") throw new Error("Receivable já RECEIVED não pode ser cancelado");
  return prisma.receivable.update({ where: { id: receivableId }, data: { status: "CANCELLED" } });
}
