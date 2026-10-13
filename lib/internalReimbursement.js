// Fase 10.6 — REPASSES INTERNOS (ex.: "Repasses do Caju"): obrigação de funding/reembolso ENTRE contas do próprio usuário.
//
// Quando um gasto saiu do Itaú (ou do cartão) mas deveria ter saído do Caju, o Caju "deve" esse valor ao Itaú. Isso NÃO é despesa, NÃO é
// receita e NÃO é transferência realizada enquanto PENDING. Só quando o usuário faz o repasse de verdade (SETTLED) nasce UM Transfer
// Caju → Itaú (kind "internal_reimbursement"): o Caju cai, o Itaú sobe, nenhum Income/Expense. Idempotente: a 2ª tentativa devolve
// ALREADY_SETTLED sem alterar nada (trava otimista + Transfer único por repasse via transferId @unique).
//
// Read-model: `summarizeInternalReimbursements` — o saldo real da conta NÃO muda enquanto há pendência; mostra-se "disponível após
// repasses" (= saldo − pendentes) só como leitura.
import { prisma } from "./prisma.js";
import { DomainError } from "./domainErrors.js";
import { money, addMoney, subtractMoney, serializeMoney } from "./money.js";
import { computeAccountBalance } from "./accounts.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { isAfterAnchor } from "./anchorOrdering.js";
import { serializeRecord } from "./telegramAi/correctionService.js";

export const REIMBURSEMENT_STATUS = Object.freeze({ PENDING: "PENDING", SETTLED: "SETTLED", CANCELLED: "CANCELLED" });
export const SETTLE_RESULT = Object.freeze({ SETTLED: "SETTLED", ALREADY_SETTLED: "ALREADY_SETTLED" });
export const REIMBURSEMENT_KEY_PREFIX = "INTERNAL_REIMBURSEMENT|v1|";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);

async function audit(tx, data) {
  return tx.telegramCorrectionAudit.create({ data: { chatId: null, telegramUpdateId: null, undoesAuditId: null, fieldChanges: null, rawMessage: "web:compromissos", ...data } });
}

export async function createInternalReimbursement({ fromAccountId, toAccountId, amount, description, sourceExpenseId = null, sourceLabel = null, confidence = "CONFIRMED", notes = null, client = prisma } = {}) {
  const value = money(amount);
  if (!value.gt(0)) throw new DomainError("INVALID", "O valor do repasse precisa ser positivo.");
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) throw new DomainError("INVALID", "Informe duas contas diferentes (de onde sai e para onde volta).");
  if (!description) throw new DomainError("INVALID", "Descreva o repasse.");
  return client.internalReimbursement.create({ data: { fromAccountId, toAccountId, amount: value, description, status: REIMBURSEMENT_STATUS.PENDING, sourceExpenseId, sourceLabel, confidence, notes } });
}

export async function listInternalReimbursements({ status, fromAccountId, client = prisma } = {}) {
  return client.internalReimbursement.findMany({ where: { ...(status ? { status } : {}), ...(fromAccountId ? { fromAccountId } : {}) }, include: { fromAccount: true, toAccount: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

// Marca o repasse como FEITO: cria o Transfer real (uma única vez) e fecha o repasse.
export async function settleInternalReimbursement({ id, settledAt, now = new Date(), client = prisma } = {}) {
  const run = async (tx) => {
    const r = await tx.internalReimbursement.findUnique({ where: { id } });
    if (!r) throw new DomainError("NOT_FOUND", "Repasse não encontrado.");
    if (r.status === REIMBURSEMENT_STATUS.SETTLED) return { status: SETTLE_RESULT.ALREADY_SETTLED, reimbursement: serialize(r), changed: false };
    if (r.status === REIMBURSEMENT_STATUS.CANCELLED) throw new DomainError("INVALID", "Este repasse foi cancelado.");

    const today = localCalendarDateAsUtcMidnight(now, getAppTimezone());
    const day = settledAt ?? dayKey(today);
    if (!DAY_RE.test(day) || Number.isNaN(dayStart(day).getTime())) throw new DomainError("INVALID", "Data do repasse inválida (use AAAA-MM-DD).");
    if (dayStart(day) > today) throw new DomainError("INVALID", "A data do repasse não pode ser no futuro.");
    const occurredAt = dayStart(day);

    // trava otimista: só o primeiro a mudar o estado vence (duplo clique / duas abas)
    const claimed = await tx.internalReimbursement.updateMany({ where: { id: r.id, status: REIMBURSEMENT_STATUS.PENDING }, data: { status: REIMBURSEMENT_STATUS.SETTLED, settledAt: occurredAt } });
    if (claimed.count !== 1) return { status: SETTLE_RESULT.ALREADY_SETTLED, reimbursement: serialize(await tx.internalReimbursement.findUnique({ where: { id } })), changed: false };

    const transfer = await tx.transfer.create({
      data: {
        amount: r.amount,
        description: `Repasse: ${r.description}`,
        fromAccountId: r.fromAccountId,
        toAccountId: r.toAccountId,
        kind: "internal_reimbursement",
        source: "manual",
        confidence: "CONFIRMED",
        rawMessage: `${REIMBURSEMENT_KEY_PREFIX}id=${r.id}|amount=${money(r.amount).toFixed(2)}|day=${day}`,
        occurredAt,
      },
    });
    const updated = await tx.internalReimbursement.update({ where: { id: r.id }, data: { transferId: transfer.id } });
    await audit(tx, { model: "internalReimbursement", recordId: r.id, action: "settle_internal_reimbursement", preimage: serializeRecord(r), fieldChanges: { transferId: transfer.id, amount: money(r.amount).toFixed(2), settledAt: day } });
    const warnings = [];
    if ((await computeAccountBalance(r.fromAccountId, { client: tx })).lt(0)) warnings.push("SOURCE_BALANCE_NEGATIVE");
    // data no dia (ou antes) do último saldo conferido de uma das contas: o saldo conferido JÁ é a verdade daquele dia e não muda com este Transfer
    for (const accountId of [r.fromAccountId, r.toAccountId]) {
      const anchor = await tx.balanceAdjustment.findFirst({ where: { accountId }, orderBy: { occurredAt: "desc" } });
      if (anchor && !isAfterAnchor(occurredAt, anchor.occurredAt)) {
        warnings.push("SETTLED_BEFORE_LAST_BALANCE_CHECK");
        break;
      }
    }
    return { status: SETTLE_RESULT.SETTLED, reimbursement: serialize(updated), transferId: transfer.id, warnings, changed: true };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 30000, maxWait: 10000 }) : run(client);
}

export async function cancelInternalReimbursement({ id, client = prisma } = {}) {
  const r = await client.internalReimbursement.findUnique({ where: { id } });
  if (!r) throw new DomainError("NOT_FOUND", "Repasse não encontrado.");
  if (r.status !== REIMBURSEMENT_STATUS.PENDING) throw new DomainError("INVALID", "Só um repasse pendente pode ser cancelado.");
  return client.internalReimbursement.update({ where: { id }, data: { status: REIMBURSEMENT_STATUS.CANCELLED } });
}

// Read-model de uma conta de ORIGEM (ex.: Caju): saldo real (inalterado) + pendências + "disponível após repasses".
export async function summarizeInternalReimbursements({ fromAccountId, client = prisma } = {}) {
  const pending = await client.internalReimbursement.findMany({ where: { fromAccountId, status: REIMBURSEMENT_STATUS.PENDING }, include: { toAccount: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const balance = await computeAccountBalance(fromAccountId, { client });
  const pendingTotal = pending.reduce((a, r) => addMoney(a, r.amount), money(0));
  return {
    accountBalance: Number(serializeMoney(balance)),
    pendingTotal: Number(serializeMoney(pendingTotal)),
    availableAfterPending: Number(serializeMoney(subtractMoney(balance, pendingTotal))),
    items: pending.map((r) => ({ id: r.id, description: r.description, amount: Number(serializeMoney(r.amount)), sourceLabel: r.sourceLabel, toAccountName: r.toAccount?.name ?? null })),
  };
}

function serialize(r) {
  return { id: r.id, status: r.status, amount: Number(serializeMoney(r.amount)), settledAt: r.settledAt ? dayKey(r.settledAt) : null, transferId: r.transferId ?? null };
}
