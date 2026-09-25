// Fase 9.1 — despacho das ações da UI de Compromissos (pagar/desfazer) pros serviços de domínio.
// Fica em lib/ (não na rota) pra ser testado sem HTTP: a rota só valida o corpo e mapeia erros.
import { payExternalInstallment, undoExternalInstallmentPayment } from "./installmentPayments.js";
import { payHouseBill, undoHouseBillPayment } from "./houseBills.js";
import { settleCommitment, undoCommitmentSettlement } from "./commitmentSettlement.js";
import { DomainError } from "./domainErrors.js";

export async function performPay(body, { now = new Date() } = {}) {
  const { kind, accountId, when, amount, recordExpense } = body ?? {};
  const common = { accountId, when: when ?? "hoje", recordExpense: recordExpense !== false, now };
  if (kind === "installment") {
    if (!body.installmentId) throw new DomainError("INVALID", "installmentId é obrigatório.");
    const r = await payExternalInstallment(body.installmentId, common);
    return { kind, installmentId: r.installment.id, expenseId: r.expense?.id ?? null, undo: { kind, id: r.installment.id, expectedUpdatedAt: r.installment.updatedAt.toISOString() } };
  }
  if (kind === "house") {
    if (!body.ruleId) throw new DomainError("INVALID", "ruleId é obrigatório.");
    const r = await payHouseBill({ ruleId: body.ruleId, cycleMonth: body.cycleMonth, part: body.part ?? 1, amount, ...common });
    return { kind, billId: r.bill.id, expenseId: r.expense?.id ?? null, undo: { kind, id: r.bill.id, expectedUpdatedAt: r.bill.updatedAt.toISOString() } };
  }
  if (kind === "commitment") {
    if (!body.commitmentId) throw new DomainError("INVALID", "commitmentId é obrigatório.");
    const r = await settleCommitment(body.commitmentId, { accountId, when: common.when, now });
    return { kind, commitmentId: r.commitment.id, undo: { kind, id: r.commitment.id, expectedUpdatedAt: r.commitment.updatedAt.toISOString() } };
  }
  throw new DomainError("INVALID", "kind inválido (installment | house | commitment).");
}

export async function performUndo(body) {
  const { kind, id, expectedUpdatedAt } = body ?? {};
  if (!id) throw new DomainError("INVALID", "id é obrigatório.");
  if (kind === "installment") { await undoExternalInstallmentPayment(id, { expectedUpdatedAt }); return { kind, id }; }
  if (kind === "house") { await undoHouseBillPayment(id, { expectedUpdatedAt }); return { kind, id }; }
  if (kind === "commitment") { await undoCommitmentSettlement(id, { expectedUpdatedAt }); return { kind, id }; }
  throw new DomainError("INVALID", "kind inválido (installment | house | commitment).");
}
