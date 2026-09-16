// ============================================================================
// Fase 7.0 — executor determinístico. Recebe um plano JÁ VALIDADO/RESOLVIDO
// (lib/telegramAi/planValidator.js) e executa CADA action chamando um
// serviço financeiro EXISTENTE — nunca escreve num model Prisma diretamente
// (exceto Transfer, que não tem um commit* reaproveitável — ver nota
// abaixo), nunca decide regra financeira nova aqui.
//
// TUDO dentro de UMA prisma.$transaction, injetada pelo caller
// (lib/telegramAi/pipeline.js, que por sua vez roda dentro da MESMA
// transação que lib/telegramUpdateHandler.js já abre pra idempotência do
// update do Telegram) — atomicidade real de banco, item 4 do pedido: "se
// uma action inválida impedir o batch: não gravar metade". Como o plano já
// foi 100% validado ANTES de chegar aqui (planValidator bloqueia o lote
// inteiro se qualquer action falhar resolução), executePlan só lança se
// algo mudar entre validação e execução (ex.: race condition) — nesse caso
// a transação inteira reverte, igual ao apply do Data Hub (Fase 6.0.1).
// ============================================================================
import { commitBotIntent } from "../commitBotIntent.js";
import { resolveCurrentBillSafely, payBill } from "../cardBillCalculator.js";
import { applyBalanceReconciliation } from "../balanceReconciliation.js";
import { applyCardBillReconciliation } from "../cardBillReconciliation.js";
import { createCommitment, updateCommitmentDetails, settleCommitmentCreatingExpense } from "../commitments.js";
import { createContingency, updateContingencyStatus, updateContingencyAmount } from "../contingencies.js";
import { createReceivable } from "../receivables.js";
import { resolveAccountByName } from "./entityResolver.js";

function toDate(isoDateOnly) {
  return new Date(`${isoDateOnly}T12:00:00.000Z`); // meio-dia UTC evita virar o dia errado por fuso.
}

async function executeRecordExpense(action, resolved, { client, rawMessage }) {
  const target = resolved.entity.kind === "card" ? { type: "card", card: resolved.entity.card } : { type: "account", account: resolved.entity.account };
  return commitBotIntent(
    "expense",
    { amount: Number(action.amount), description: action.description || action.merchant || "Gasto", category: action.category || "Outros", target, occurredAt: toDate(action.date), rawMessage, confidence: action.confidence === "HIGH" ? undefined : "ESTIMATED" },
    { source: "telegram_ai", client }
  );
}

async function executeRecordIncome(action, resolved, { client, rawMessage }) {
  const target = resolved.entity.kind === "card" ? { type: "card", card: resolved.entity.card } : { type: "account", account: resolved.entity.account };
  return commitBotIntent(
    "income",
    { amount: Number(action.amount), description: action.description || action.payer || "Receita", category: action.category || "Outros", target, occurredAt: toDate(action.date), rawMessage, confidence: action.confidence === "HIGH" ? undefined : "ESTIMATED" },
    { source: "telegram_ai", client }
  );
}

// RECORD_CARD_PURCHASE = despesa à vista no cartão (sem parcelamento) — o
// MESMO commitExpense com target:card, nunca um model separado.
async function executeRecordCardPurchase(action, resolved, { client, rawMessage }) {
  return commitBotIntent(
    "expense",
    { amount: Number(action.amount), description: action.description || action.merchant || "Compra no cartão", category: action.category || "Outros", target: { type: "card", card: resolved.entity.card }, occurredAt: toDate(action.date), rawMessage, confidence: action.confidence === "HIGH" ? undefined : "ESTIMATED" },
    { source: "telegram_ai", client }
  );
}

async function executeRecordInstallmentPurchase(action, resolved, { client, rawMessage }) {
  return commitBotIntent(
    "installment_purchase",
    {
      amount: Number(action.totalAmount),
      installmentCount: action.installments,
      description: action.description || action.merchant || "Compra parcelada",
      category: action.category || "Outros",
      target: { type: "card", card: resolved.entity.card },
      occurredAt: toDate(action.date),
      rawMessage,
      confidence: action.confidence === "HIGH" ? undefined : "ESTIMATED",
    },
    { source: "telegram_ai", client }
  );
}

// Transfer não tem um commit* reaproveitável de forma direta (commitTransfer
// em commitBotIntent.js resolve contas RE-PARSEANDO rawMessage — o caminho
// do parser antigo; aqui as duas pontas já vêm RESOLVIDAS pelo
// planValidator). Escreve o model diretamente — é exatamente o mesmo shape
// de dado que commitTransfer grava, só sem re-derivar do texto.
async function executeRecordTransfer(action, resolved, { client, rawMessage }) {
  const { from, to, toCard } = resolved;
  const transfer = await client.transfer.create({
    data: {
      amount: Number(action.amount),
      description: action.description || "Transferência",
      fromAccountId: from?.id ?? null,
      toAccountId: to?.id ?? null,
      toCardId: toCard?.id ?? null,
      kind: "generic",
      source: "telegram_ai",
      confidence: action.confidence === "HIGH" ? undefined : "ESTIMATED",
      rawMessage,
      occurredAt: toDate(action.date),
    },
  });
  const fromName = from?.name ?? "?";
  const toName = to?.name ?? toCard?.name ?? "?";
  return { record: transfer, reply: `✅ Transferência registrada: ${action.amount} de ${fromName} para ${toName}.` };
}

async function executeRecordCardPayment(action, resolved, { client, rawMessage }) {
  const card = resolved.card;
  const bill = await resolveCurrentBillSafely(card.id, { client });
  const fromAccount = action.fromAccount ? await resolveAccountByName(action.fromAccount, { client }) : await client.account.findFirst({ where: { type: "checking" } });
  if (!fromAccount) return { record: null, reply: "⚠️ Não identifiquei de qual conta saiu o pagamento da fatura." };
  const result = await payBill(bill.id, { fromAccountId: fromAccount.id, amount: Number(action.amount), description: `Pagamento fatura ${card.name}`, source: "telegram_ai", rawMessage, occurredAt: toDate(action.date) }, { client });
  return { record: result, reply: `✅ Pagamento de fatura registrado: ${action.amount} (${card.name}), saiu de ${fromAccount.name}.` };
}

async function executeSetAccountBalanceSnapshot(action, resolved, { client, rawMessage }) {
  const { record, preview } = await applyBalanceReconciliation(resolved.account.id, action.observedBalance, { rawMessage, client });
  return { record, reply: `✅ Saldo de ${resolved.account.name} reconciliado para ${action.observedBalance} (diferença ${preview.delta}).` };
}

async function executeSetVaBalanceSnapshot(action, resolved, { client, rawMessage }) {
  const { record, preview } = await applyBalanceReconciliation(resolved.account.id, action.observedBalance, { rawMessage, client });
  return { record, reply: `✅ Saldo do Vale reconciliado para ${action.observedBalance} (diferença ${preview.delta}).` };
}

async function executeSetCardBillSnapshot(action, resolved, { client, rawMessage }) {
  const { record, preview } = await applyCardBillReconciliation(resolved.card.id, action.observedTotal, { date: toDate(action.date), rawMessage, client });
  return { record, reply: `✅ Fatura de ${resolved.card.name} reconciliada: observado ${action.observedTotal}, calculado ${preview.calculated} (diferença ${preview.delta}).` };
}

async function executeCreateConfirmedCommitment(action, resolved, { client }) {
  const commitment = await createCommitment({ description: action.description, amount: action.amount, dueDate: toDate(action.dueDate), notes: action.notes }, { client });
  return { record: commitment, reply: `✅ Compromisso confirmado: ${action.description} · ${action.amount} · vence ${action.dueDate}.` };
}

async function executeUpdateConfirmedCommitment(action, resolved, { client }) {
  const updated = await updateCommitmentDetails(resolved.commitment.id, { amount: action.amount, dueDate: action.dueDate ? toDate(action.dueDate) : undefined }, { client });
  return { record: updated, reply: `✅ Compromisso "${updated.description}" atualizado.` };
}

async function executeSettleConfirmedCommitment(action, resolved, { client }) {
  const account = action.account ? await resolveAccountByName(action.account, { client }) : await client.account.findFirst({ where: { type: "checking" } });
  const { commitment, expense } = await settleCommitmentCreatingExpense(resolved.commitment.id, { accountId: account?.id, description: resolved.commitment.description }, { client });
  return { record: { commitment, expense }, reply: `✅ Compromisso "${commitment.description}" liquidado (${expense.amount}).` };
}

async function executeCreateContingency(action, resolved, { client }) {
  const contingency = await createContingency({ description: action.description, maxAmount: action.maxAmount, expectedAmount: action.expectedAmount, expectedDate: action.expectedDate ? toDate(action.expectedDate) : null }, { client });
  return { record: contingency, reply: `✅ Contingência registrada: ${action.description} · até ${action.maxAmount}.` };
}

async function executeUpdateContingency(action, resolved, { client }) {
  let updated = resolved.contingency;
  if (action.status) updated = await updateContingencyStatus(resolved.contingency.id, action.status, { client });
  if (action.maxAmount) updated = await updateContingencyAmount(resolved.contingency.id, action.maxAmount, { client });
  return { record: updated, reply: `✅ Contingência "${updated.description}" atualizada.` };
}

async function executeCreateReceivable(action, resolved, { client }) {
  const receivable = await createReceivable({ description: action.description, counterparty: action.counterparty, amount: action.amount, expectedDate: action.expectedDate ? toDate(action.expectedDate) : null }, { client });
  return { record: receivable, reply: `✅ A receber registrado: ${action.description} de ${action.counterparty} · ${action.amount}.` };
}

const EXECUTORS = {
  RECORD_EXPENSE: executeRecordExpense,
  RECORD_INCOME: executeRecordIncome,
  RECORD_CARD_PURCHASE: executeRecordCardPurchase,
  RECORD_INSTALLMENT_PURCHASE: executeRecordInstallmentPurchase,
  RECORD_TRANSFER: executeRecordTransfer,
  RECORD_CARD_PAYMENT: executeRecordCardPayment,
  SET_ACCOUNT_BALANCE_SNAPSHOT: executeSetAccountBalanceSnapshot,
  SET_VA_BALANCE_SNAPSHOT: executeSetVaBalanceSnapshot,
  SET_CARD_BILL_SNAPSHOT: executeSetCardBillSnapshot,
  CREATE_CONFIRMED_COMMITMENT: executeCreateConfirmedCommitment,
  UPDATE_CONFIRMED_COMMITMENT: executeUpdateConfirmedCommitment,
  SETTLE_CONFIRMED_COMMITMENT: executeSettleConfirmedCommitment,
  CREATE_CONTINGENCY: executeCreateContingency,
  UPDATE_CONTINGENCY: executeUpdateContingency,
  CREATE_RECEIVABLE: executeCreateReceivable,
};

export const EXECUTABLE_ACTION_TYPES = Object.freeze(Object.keys(EXECUTORS));

// `preparedActions` = saída de planValidator.validatePlan(...).perAction,
// TODAS já com ok:true (o caller garante isso antes de chamar). Roda dentro
// da transação `client` fornecida pelo caller — nunca abre a própria.
export async function executePlan(preparedActions, { client, rawMessage }) {
  const results = [];
  for (const prepared of preparedActions) {
    const executor = EXECUTORS[prepared.action.type];
    if (!executor) throw new Error(`Nenhum executor determinístico pra ${prepared.action.type} — isto nunca deveria chegar aqui (bug no planValidator/confirmationPolicy).`);
    const result = await executor(prepared.action, prepared.resolved, { client, rawMessage });
    results.push({ localId: prepared.action.localId, type: prepared.action.type, ...result });
  }
  return results;
}
