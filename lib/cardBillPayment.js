// Fase 10.5 — PAGAMENTO INTEGRAL DA FATURA do cartão (ação "Marcar fatura como paga" na área Cartões v5).
//
// MODELAGEM (sem migration — o domínio já tem o necessário):
//   pagar fatura NÃO é Expense (as compras já entraram quando foram lançadas). É um Transfer `kind = "card_bill_payment"`
//   conta corrente → cartão, vinculado à CardBill (`cardBillId`). O saldo da conta cai exatamente o valor pago (computeAccountBalance
//   soma transferências de saída); o limite do cartão é liberado (computeCardUsedLimit já subtrai card_bill_payment); a CardBill vira
//   `paid` com `paidAmount`/`paidAt`. O motor de livre/comprometido enxerga a fatura quitada (restante 0) sem nenhum ajuste artificial.
//
// IDENTIDADE / CONCILIAÇÃO: o Transfer carrega em `rawMessage` uma chave estável
//   CARD_BILL_PAYMENT|v1|bill=<id>|cycle=<AAAA-MM>|amount=<valor>|acct=<id>|day=<AAAA-MM-DD>
// que permite reconhecer, depois, a linha bancária do mesmo pagamento (extrato) e CONCILIAR — nunca criar uma segunda saída
// (ver reconcileBankLineWithCardBillPayment).
//
// Só quitação INTEGRAL (restante da fatura). Sem pagamento parcial/rotativo nesta fase.
import { prisma } from "./prisma.js";
import { DomainError } from "./domainErrors.js";
import { money, addMoney, subtractMoney, roundMoney, serializeMoney } from "./money.js";
import { computeAccountBalance } from "./accounts.js";
import { isAfterAnchor } from "./anchorOrdering.js";
import { computeExpectedCardBillTotal, applyObservedTotal } from "./cardBillCalculator.js";
import { getCardBillClosesAt, getCardBillDueDate } from "./cardCycle.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { serializeRecord } from "./telegramAi/correctionService.js";
import { PAYMENT_KEY_PREFIX, paymentKey, isBankReconciled, matchPaymentCandidates, paymentWindow, withBankReference, sanitizeReference, dayStart, dayKey, PAYMENT_MATCH_TOLERANCE_DAYS } from "./cardBillPaymentKey.js";

export { PAYMENT_KEY_PREFIX, paymentKey, isBankReconciled };
export const PAYMENT_STATUS = Object.freeze({ PAID: "PAID", ALREADY_PAID: "ALREADY_PAID", UNDONE: "UNDONE" });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Pagamentos DESTE fluxo da fatura (marcados pela chave) — qualquer outro Transfer card_bill_payment (Telegram etc.) não é desfeito aqui.
async function flowPayments(client, cardBillId) {
  return client.transfer.findMany({ where: { cardBillId, kind: "card_bill_payment", rawMessage: { startsWith: PAYMENT_KEY_PREFIX } }, orderBy: { createdAt: "asc" } });
}

async function resolveBill(tx, { cardBillId, cardId, cycleMonth }) {
  let bill = cardBillId ? await tx.cardBill.findUnique({ where: { id: cardBillId } }) : null;
  if (!bill && cardId && cycleMonth) bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId, cycleMonth } } });
  return bill;
}

async function logAudit(tx, data) {
  return tx.telegramCorrectionAudit.create({ data: { chatId: null, telegramUpdateId: null, undoesAuditId: null, fieldChanges: null, rawMessage: "web:cartoes", ...data } });
}

// ----------------------------------------------------------------------------- pagar
export async function payCardBillInFull({ cardBillId, cardId, cycleMonth, fromAccountId, paidAt, now = new Date(), client = prisma } = {}) {
  const run = async (tx) => {
    const card = cardId ? await tx.card.findUnique({ where: { id: cardId } }) : cardBillId ? await tx.card.findFirst({ where: { bills: { some: { id: cardBillId } } } }) : await tx.card.findFirst({ orderBy: { createdAt: "asc" } });
    if (!card) throw new DomainError("NOT_FOUND", "Cartão não encontrado.");
    let bill = await resolveBill(tx, { cardBillId, cardId: card.id, cycleMonth });
    if (!bill) {
      if (!cycleMonth) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");
      // pagar é uma MUTAÇÃO explícita: pode materializar a fatura que até então só existia projetada
      const closesAt = getCardBillClosesAt(card, cycleMonth);
      bill = await tx.cardBill.create({ data: { cardId: card.id, cycleMonth, closesAt, dueAt: getCardBillDueDate(card, cycleMonth), totalAmount: await computeExpectedCardBillTotal(card, cycleMonth, { client: tx }), status: closesAt < now ? "closed" : "open" } });
    }

    // ---- idempotência: já paga => ALREADY_PAID, nenhuma alteração financeira
    const existing = await flowPayments(tx, bill.id);
    if (bill.status === "paid") return { status: PAYMENT_STATUS.ALREADY_PAID, bill: summarize(bill), payment: existing.at(-1) ? summarizeTransfer(existing.at(-1)) : null, changed: false };

    // ---- valor: restante do total AUTORITATIVO (observado, quando existe) — quitação integral
    const effectiveTotal = (await applyObservedTotal(card, { ...bill, isPersisted: true }, { client: tx })).totalAmount;
    const alreadyPaid = money(bill.paidAmount);
    const remaining = roundMoney(subtractMoney(effectiveTotal, alreadyPaid));
    if (!remaining.gt(0)) return { status: PAYMENT_STATUS.ALREADY_PAID, bill: summarize(bill), payment: existing.at(-1) ? summarizeTransfer(existing.at(-1)) : null, changed: false };
    const closesAt = bill.closesAt;
    if (closesAt > now) throw new DomainError("INVALID", "Esta fatura ainda não fechou — o valor só é definitivo depois do fechamento.");

    // ---- conta de origem (default: a conta do cartão — Itaú conta corrente)
    const accountId = fromAccountId ?? card.accountId;
    const account = accountId ? await tx.account.findUnique({ where: { id: accountId } }) : null;
    if (!account) throw new DomainError("INVALID", "Escolha de onde saiu o dinheiro.");
    if (account.type === "food_voucher") throw new DomainError("INVALID", "O vale-alimentação é restrito a comida — escolha outra conta.");

    // ---- data do pagamento: data-calendário (convenção do app = meia-noite UTC do dia local)
    const today = localCalendarDateAsUtcMidnight(now, getAppTimezone());
    const day = paidAt ?? dayKey(today);
    if (!DAY_RE.test(day) || Number.isNaN(dayStart(day).getTime())) throw new DomainError("INVALID", "Data do pagamento inválida (use AAAA-MM-DD).");
    if (dayStart(day) > today) throw new DomainError("INVALID", "A data do pagamento não pode ser no futuro.");
    const occurredAt = dayStart(day);

    // ---- trava otimista: só o primeiro a mudar a fatura de estado vence (duplo clique / duas abas)
    const claimed = await tx.cardBill.updateMany({ where: { id: bill.id, status: { not: "paid" }, paidAmount: bill.paidAmount }, data: { status: "paid", paidAt: occurredAt, paidAmount: roundMoney(addMoney(alreadyPaid, remaining)) } });
    if (claimed.count !== 1) return { status: PAYMENT_STATUS.ALREADY_PAID, bill: summarize(await tx.cardBill.findUnique({ where: { id: bill.id } })), payment: null, changed: false };

    const transfer = await tx.transfer.create({
      data: {
        amount: remaining,
        description: `Pagamento da fatura ${card.name} — ${bill.cycleMonth}`,
        fromAccountId: account.id,
        toCardId: card.id,
        cardBillId: bill.id,
        kind: "card_bill_payment",
        source: "manual",
        confidence: "CONFIRMED",
        rawMessage: paymentKey({ billId: bill.id, cycleMonth: bill.cycleMonth, amount: remaining, accountId: account.id, day }),
        occurredAt,
      },
    });
    await logAudit(tx, { model: "cardBill", recordId: bill.id, action: "pay_card_bill", preimage: serializeRecord(bill), fieldChanges: { transferId: transfer.id, amount: remaining.toFixed(2), fromAccountId: account.id, paidAt: day } });

    const fresh = await tx.cardBill.findUnique({ where: { id: bill.id } });
    const anchor = await tx.balanceAdjustment.findFirst({ where: { accountId: account.id }, orderBy: { occurredAt: "desc" } });
    const balanceAfter = await computeAccountBalance(account.id, { client: tx });
    const warnings = [];
    if (anchor && !isAfterAnchor(occurredAt, anchor.occurredAt)) warnings.push("PAYMENT_BEFORE_LAST_BALANCE_CHECK"); // dia anterior ao último saldo conferido: o saldo já inclui esse pagamento
    if (balanceAfter.lt(0)) warnings.push("ACCOUNT_BALANCE_NEGATIVE");
    return { status: PAYMENT_STATUS.PAID, bill: summarize(fresh), payment: summarizeTransfer(transfer), balanceAfter: serializeMoney(balanceAfter), warnings, changed: true };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 30000, maxWait: 10000 }) : run(client);
}

// ----------------------------------------------------------------------------- desfazer
export async function undoCardBillPayment({ cardBillId, cardId, cycleMonth, now = new Date(), client = prisma } = {}) {
  const run = async (tx) => {
    const bill = await resolveBill(tx, { cardBillId, cardId, cycleMonth });
    if (!bill) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");
    const payments = await flowPayments(tx, bill.id);
    if (bill.status !== "paid" && payments.length === 0) throw new DomainError("NOT_PAID", "Esta fatura não está paga — nada a desfazer.");
    const target = payments.at(-1);
    if (payments.some(isBankReconciled)) throw new DomainError("BLOCKED_RECONCILED_PAYMENT", "Este pagamento já foi conciliado com o extrato do banco — não dá para desfazer por aqui.");
    if (!target) throw new DomainError("INVALID", "Este pagamento não foi registrado por aqui (ex.: pelo Telegram) — não é desfeito por esta ação.");
    // PROTEÇÃO NA API (independente da UI): um pagamento já conciliado com uma linha real do banco nunca é revertido em silêncio.
    if (isBankReconciled(target)) throw new DomainError("BLOCKED_RECONCILED_PAYMENT", "Este pagamento já foi conciliado com o extrato do banco — não dá para desfazer por aqui.");

    const preimage = serializeRecord(target);
    await tx.transfer.delete({ where: { id: target.id } });
    // reabre a fatura: só some o efeito DESTE pagamento (outros pagamentos eventuais continuam contando)
    const others = await tx.transfer.aggregate({ where: { cardBillId: bill.id, kind: "card_bill_payment" }, _sum: { amount: true } });
    const paidAmount = roundMoney(money(others._sum.amount));
    const status = paidAmount.gt(0) ? "partially_paid" : bill.closesAt < now ? "closed" : "open";
    const updated = await tx.cardBill.update({ where: { id: bill.id }, data: { status, paidAmount, paidAt: paidAmount.gt(0) ? bill.paidAt : null } });
    await logAudit(tx, { model: "cardBill", recordId: bill.id, action: "undo_pay_card_bill", preimage: { transfer: preimage, bill: serializeRecord(bill) }, fieldChanges: { removedTransferId: target.id, amount: money(target.amount).toFixed(2) } });
    return { status: PAYMENT_STATUS.UNDONE, bill: summarize(updated), removed: summarizeTransfer(target), changed: true };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 30000, maxWait: 10000 }) : run(client);
}

// ----------------------------------------------------------------------------- conciliação com o extrato
// Procura o pagamento já registrado que corresponde a uma LINHA BANCÁRIA de saída da conta (mesmo valor, mesma conta, data próxima).
export async function findCardBillPaymentMatch({ accountId, amount, date, toleranceDays = PAYMENT_MATCH_TOLERANCE_DAYS, client = prisma } = {}) {
  const candidates = await client.transfer.findMany({
    where: { kind: "card_bill_payment", fromAccountId: accountId, rawMessage: { startsWith: PAYMENT_KEY_PREFIX }, occurredAt: paymentWindow(date, toleranceDays) },
    orderBy: { occurredAt: "asc" },
  });
  return matchPaymentCandidates(candidates, { accountId, amount });
}

// Concilia (NÃO duplica): anota a referência bancária no pagamento existente. Nenhum Transfer/Expense novo, nenhuma mudança de saldo.
// Chamada pelo import REAL (lib/dataHub/apply.js) e por qualquer catch-up. Ambiguidade (2+ pagamentos compatíveis ainda não
// conciliados) => NÃO escolhe: devolve { matched: false, ambiguous: true } para ir à revisão.
export async function reconcileBankLineWithCardBillPayment({ accountId, amount, date, reference, client = prisma } = {}) {
  if (!reference) throw new DomainError("INVALID", "Informe a referência/identidade da linha bancária.");
  const ref = sanitizeReference(reference);
  const run = async (tx) => {
    const matches = await findCardBillPaymentMatch({ accountId, amount, date, client: tx });
    if (matches.length === 0) return { matched: false, reason: "Nenhum pagamento de fatura registrado corresponde a esta linha." };
    const already = matches.find((t) => (t.rawMessage ?? "").includes(`|bank=${ref}|`) || (t.rawMessage ?? "").endsWith(`|bank=${ref}`));
    if (already) return { matched: true, alreadyReconciled: true, transferId: already.id, created: 0 };
    const unreconciled = matches.filter((t) => !isBankReconciled(t));
    if (unreconciled.length === 0) return { matched: true, alreadyReconciled: true, transferId: matches[0].id, created: 0, note: "pagamento já conciliado com outra linha bancária" };
    if (unreconciled.length > 1) return { matched: false, ambiguous: true, candidateIds: unreconciled.map((t) => t.id), reason: "Mais de um pagamento de fatura compatível — conferir manualmente." };
    const target = unreconciled[0];
    const day = dayKey(dayStart(date));
    await tx.transfer.update({ where: { id: target.id }, data: { rawMessage: withBankReference(target.rawMessage, ref, day) } });
    await logAudit(tx, { model: "transfer", recordId: target.id, action: "reconcile_card_bill_payment", preimage: serializeRecord(target), fieldChanges: { bank: ref, bankDay: day } });
    return { matched: true, alreadyReconciled: false, transferId: target.id, created: 0 };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 30000, maxWait: 10000 }) : run(client);
}

// ----------------------------------------------------------------------------- saídas
function summarize(bill) {
  return { id: bill.id, cycleMonth: bill.cycleMonth, status: bill.status, totalAmount: serializeMoney(bill.totalAmount), paidAmount: bill.paidAmount == null ? null : serializeMoney(bill.paidAmount), paidAt: bill.paidAt ? dayKey(bill.paidAt) : null, dueAt: dayKey(bill.dueAt) };
}
function summarizeTransfer(t) {
  return { id: t.id, amount: serializeMoney(t.amount), fromAccountId: t.fromAccountId, occurredAt: dayKey(t.occurredAt), kind: t.kind, reconciled: isBankReconciled(t) };
}
