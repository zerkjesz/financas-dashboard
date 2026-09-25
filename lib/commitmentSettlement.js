// ============================================================================
// Fase 9.1 — LIQUIDAR / DESFAZER um ConfirmedCommitment pela UI, atômico e auditado.
//
// settlementMode decide a natureza do movimento:
//   "EXPENSE"            (default) — o compromisso é um gasto: cria Expense (comportamento anterior).
//   "EXTERNAL_TRANSFER"  — DEVOLUÇÃO DE CAPITAL (ex.: devolver ao CNPJ): NUNCA é despesa. Cria uma
//                          Transfer (conta -> fora do Norte, toAccountId null), o mesmo formato
//                          dos aportes externos da Fase 8.0, e vincula em settledTransferId.
// FUNDED != SETTLED: fundar continua sendo só earmark; só esta liquidação move dinheiro de verdade.
// ============================================================================
import { prisma } from "./prisma.js";
import { money } from "./money.js";
import { serializeRecord } from "./telegramAi/correctionService.js";
import { DomainError } from "./domainErrors.js";
import { assertPayableAccount } from "./installmentPayments.js";
import { resolvePaymentInstant } from "./paymentDates.js";

export async function settleCommitment(commitmentId, { accountId, when = "hoje", paidAt, now = new Date() } = {}, { client = prisma } = {}) {
  const run = async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new DomainError("NOT_FOUND", "Compromisso não encontrado.");
    if (commitment.status === "SETTLED") throw new DomainError("ALREADY_PAID", "Este compromisso já está liquidado.");
    if (commitment.status === "CANCELLED") throw new DomainError("INVALID", "Compromisso cancelado não pode ser liquidado.");
    const occurredAt = paidAt ? new Date(paidAt) : resolvePaymentInstant(when, now);
    await assertPayableAccount(tx, accountId, commitment.amount);

    let data;
    let created;
    if (commitment.settlementMode === "EXTERNAL_TRANSFER") {
      const transfer = await tx.transfer.create({
        data: { amount: commitment.amount, description: `Devolução — ${commitment.description}`, fromAccountId: accountId, toAccountId: null, kind: "generic", source: "manual", confidence: "CONFIRMED", rawMessage: `settle-commitment:${commitment.id}`, occurredAt },
      });
      data = { status: "SETTLED", settledAt: occurredAt, settledTransferId: transfer.id };
      created = { transfer };
    } else {
      const expense = await tx.expense.create({
        data: { amount: commitment.amount, description: commitment.description, category: "Outros", accountId, source: "manual", confidence: "CONFIRMED", rawMessage: `settle-commitment:${commitment.id}`, occurredAt },
      });
      data = { status: "SETTLED", settledAt: occurredAt, expenseId: expense.id };
      created = { expense };
    }
    const updated = await tx.confirmedCommitment.update({ where: { id: commitment.id }, data });
    await tx.telegramCorrectionAudit.create({
      data: { model: "confirmedCommitment", recordId: commitment.id, action: "settle_commitment", preimage: serializeRecord(commitment), fieldChanges: { status: "SETTLED", mode: commitment.settlementMode, amount: money(commitment.amount).toString() }, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: "web" },
    });
    return { commitment: updated, ...created };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}

export async function undoCommitmentSettlement(commitmentId, { expectedUpdatedAt } = {}, { client = prisma } = {}) {
  const run = async (tx) => {
    const commitment = await tx.confirmedCommitment.findUnique({ where: { id: commitmentId } });
    if (!commitment) throw new DomainError("NOT_FOUND", "Compromisso não encontrado.");
    if (commitment.status !== "SETTLED") throw new DomainError("NOT_PAID", "Este compromisso não está liquidado — nada a desfazer.");
    if (expectedUpdatedAt && commitment.updatedAt.toISOString() !== expectedUpdatedAt) throw new DomainError("STALE", "Este compromisso mudou desde que você o viu. Atualize a página e confira antes de desfazer.");
    let removed = null;
    await tx.confirmedCommitment.update({ where: { id: commitment.id }, data: { expenseId: null, settledTransferId: null } }); // solta os vínculos antes de apagar
    if (commitment.settledTransferId) {
      const transfer = await tx.transfer.findUnique({ where: { id: commitment.settledTransferId } });
      if (transfer) { removed = serializeRecord(transfer); await tx.transfer.delete({ where: { id: transfer.id } }); }
    } else if (commitment.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: commitment.expenseId } });
      if (expense) { removed = serializeRecord(expense); await tx.expense.delete({ where: { id: expense.id } }); }
    }
    const updated = await tx.confirmedCommitment.update({ where: { id: commitment.id }, data: { status: commitment.fundedAt ? "FUNDED" : "CONFIRMED", settledAt: null } });
    await tx.telegramCorrectionAudit.create({
      data: { model: "confirmedCommitment", recordId: commitment.id, action: "undo_settle_commitment", preimage: serializeRecord(commitment), fieldChanges: { status: updated.status, removed }, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: "web" },
    });
    return { commitment: updated };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}
