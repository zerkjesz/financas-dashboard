// ============================================================================
// Fase 9.1 — PAGAR / DESFAZER parcela de plano externo, atômico.
//
// Antes só existia markExternalInstallmentPaid(): marcava PAID mas NÃO criava despesa nem escolhia
// conta — pagar não debitava o caixa, a menos que o usuário lançasse uma Expense à parte e
// vinculasse por expenseId (dois passos manuais). Aqui, DENTRO de uma transação:
//   1. valida a parcela (PENDING, é a próxima do plano, não há pagamento duplicado);
//   2. valida a conta (existe, não é VA — VA é restrito a comida — e tem saldo);
//   3. cria a Expense correspondente (data ECONÔMICA informada, nunca a de ingestão);
//   4. marca a parcela PAID, grava paidAt e vincula expenseId;
//   5. grava auditoria append-only (TelegramCorrectionAudit, model "externalInstallment").
// Qualquer falha => ZERO escrita (rollback da transação inteira).
//
// `recordExpense: false` = "já paguei antes, só marcar": PAID sem Expense (o dinheiro saiu fora
// do Norte / já está refletido no saldo observado). Nunca inventa lançamento.
//
// Desfazer: parcela volta PENDING, paidAt/expenseId limpos, a Expense vinculada é REMOVIDA (o
// preimage completo fica na auditoria), guarda de estado obsoleto por updatedAt e idempotência
// (desfazer o que não está pago é erro explícito, nunca no-op silencioso).
// ============================================================================
import { prisma } from "./prisma.js";
import { money, serializeMoney } from "./money.js";
import { computeAccountBalance } from "./accounts.js";
import { serializeRecord } from "./telegramAi/correctionService.js";
import { DomainError } from "./domainErrors.js";
import { resolvePaymentInstant } from "./paymentDates.js";

async function audit(tx, data) {
  return tx.telegramCorrectionAudit.create({
    data: { chatId: null, telegramUpdateId: null, undoesAuditId: null, fieldChanges: null, rawMessage: "web", ...data },
  });
}

export async function assertPayableAccount(tx, accountId, amount) {
  if (!accountId) throw new DomainError("INVALID", "Escolha de onde saiu o dinheiro.");
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (!account) throw new DomainError("NOT_FOUND", "Conta não encontrada.");
  if (account.type === "food_voucher") throw new DomainError("INVALID", "O vale-alimentação é restrito a comida — escolha outra conta.");
  const balance = await computeAccountBalance(account.id, { client: tx });
  if (money(amount).gt(balance)) throw new DomainError("INSUFFICIENT_FUNDS", `Saldo insuficiente em ${account.name}.`);
  return account;
}

export async function payExternalInstallment(installmentId, { accountId, when = "hoje", paidAt, recordExpense = true, now = new Date() } = {}, { client = prisma } = {}) {
  const run = async (tx) => {
    const installment = await tx.externalInstallment.findUnique({ where: { id: installmentId }, include: { plan: true } });
    if (!installment) throw new DomainError("NOT_FOUND", "Parcela não encontrada.");
    if (installment.status === "PAID") throw new DomainError("ALREADY_PAID", `A parcela ${installment.number} já está paga.`);
    if (installment.plan.status !== "ACTIVE") throw new DomainError("INVALID", "Este parcelamento não está ativo.");
    const firstPending = await tx.externalInstallment.findFirst({ where: { planId: installment.planId, status: "PENDING" }, orderBy: { number: "asc" } });
    if (firstPending.id !== installment.id) throw new DomainError("OUT_OF_ORDER", `Pague antes a parcela ${firstPending.number}.`);

    const occurredAt = paidAt ? new Date(paidAt) : resolvePaymentInstant(when, now);
    let expense = null;
    if (recordExpense) {
      await assertPayableAccount(tx, accountId, installment.amount);
      expense = await tx.expense.create({
        data: {
          amount: installment.amount,
          description: `${installment.plan.description} — parcela ${installment.number}/${installment.plan.installmentCount}`,
          category: "Outros",
          accountId,
          source: "manual",
          confidence: "CONFIRMED",
          rawMessage: `pay-installment:${installment.id}`,
          occurredAt,
        },
      });
    }
    const updated = await tx.externalInstallment.update({ where: { id: installment.id }, data: { status: "PAID", paidAt: occurredAt, expenseId: expense?.id ?? null } });
    await audit(tx, {
      model: "externalInstallment",
      recordId: installment.id,
      action: "pay_installment",
      preimage: serializeRecord(installment),
      fieldChanges: { status: "PAID", paidAt: occurredAt.toISOString(), expenseId: expense?.id ?? null, amount: serializeMoney(installment.amount).toString(), recordExpense },
    });
    return { installment: updated, expense, plan: installment.plan };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}

export async function undoExternalInstallmentPayment(installmentId, { expectedUpdatedAt } = {}, { client = prisma } = {}) {
  const run = async (tx) => {
    const installment = await tx.externalInstallment.findUnique({ where: { id: installmentId }, include: { plan: true } });
    if (!installment) throw new DomainError("NOT_FOUND", "Parcela não encontrada.");
    if (installment.status !== "PAID") throw new DomainError("NOT_PAID", `A parcela ${installment.number} não está paga — nada a desfazer.`);
    if (expectedUpdatedAt && installment.updatedAt.toISOString() !== expectedUpdatedAt) throw new DomainError("STALE", "Esta parcela mudou desde que você a viu. Atualize a página e confira antes de desfazer.");
    let expensePreimage = null;
    if (installment.expenseId) {
      const expense = await tx.expense.findUnique({ where: { id: installment.expenseId } });
      if (expense) {
        expensePreimage = serializeRecord(expense);
        await tx.externalInstallment.update({ where: { id: installment.id }, data: { expenseId: null } }); // solta o vínculo antes de apagar
        await tx.expense.delete({ where: { id: expense.id } });
      }
    }
    const updated = await tx.externalInstallment.update({ where: { id: installment.id }, data: { status: "PENDING", paidAt: null, expenseId: null } });
    await audit(tx, {
      model: "externalInstallment",
      recordId: installment.id,
      action: "undo_pay_installment",
      preimage: serializeRecord(installment),
      fieldChanges: { status: "PENDING", removedExpense: expensePreimage },
    });
    return { installment: updated, plan: installment.plan };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}
