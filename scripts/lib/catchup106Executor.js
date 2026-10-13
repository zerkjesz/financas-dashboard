// Fase 10.6 — EXECUTOR do catch-up 08/10 → 13/10. Separado do planner (scripts/lib/catchup106Planner.js, 100% somente leitura).
//
//   buildCatchup106Plan({ client })            => somente leitura (planner)
//   executeCatchup106Plan({ client, plan })    => aplica o plano JÁ VALIDADO, com guardas; qualquer precondition falha => ABORTA e reverte tudo
//
// O executor NÃO recalcula decisões financeiras: cada operação traz as `preconditions` que o planner observou. Única "decisão" em tempo de
// execução (por pedido explícito): os ajustes de reconciliação de saldo — só são gravados depois que TODAS as linhas reais foram aplicadas e o
// ledger recalculado deixa EXATAMENTE o resíduo esperado; resíduo diferente => ABORTA; resíduo zero => não grava ajuste.
//
// ORDEM (importa): a observação da fatura de novembro é gravada ANTES da compra de 12/10 (Rei do Pernil), para que o motor trate essa compra
// como "lançada depois da observação" (incorrida, fora do observedTotal). Transação única (tudo-ou-nada) quando `client` é o cliente raiz.
import { money, subtractMoney, addMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { computeExpectedCardBillTotal, computeAdditionsSinceObservation } from "../../lib/cardBillCalculator.js";
import { payHouseBill } from "../../lib/houseBills.js";
import { reconcileBankLineWithCardBillPayment, PAYMENT_KEY_PREFIX } from "../../lib/cardBillPayment.js";
import { createReceivable, markReceivableReceived } from "../../lib/receivables.js";
import { createInternalReimbursement } from "../../lib/internalReimbursement.js";
import { serializeRecord } from "../../lib/telegramAi/correctionService.js";
import { PLAN_TAG, TARGETS } from "./catchup106Planner.js";

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);
const same = (a, b) => money(a).minus(money(b)).abs().lt("0.005");
const KNOWN = new Set(["PAY_HOUSE_BILL", "CORRECT_CARD_BILL_PAYMENT", "RECONCILE_PAYMENT_BANK_LINE", "ADD_CARD_CREDIT", "ADD_ACCOUNT", "ADD_TRANSFER", "ADD_RESERVE", "ADD_RESERVE_MOVEMENT", "UPDATE_GOAL_SAVED", "ADD_INCOME", "ADD_EXPENSE", "ADD_RECEIVABLE_RECEIVED", "UNFUND_COMMITMENT", "ADD_RECEIVABLE", "RECORD_CARD_BILL_OBSERVATION", "ADD_CARD_EXPENSE", "ADD_PURCHASE_WITH_INSTALLMENTS", "SYNC_CARD_BILL_ROW", "RECORD_CARD_LIMIT_OBSERVATION", "ADD_INTERNAL_REIMBURSEMENT", "ADD_BALANCE_RECONCILIATION"]);

export class CatchupAbort extends Error {
  constructor(message, opId) {
    super(`CATCH-UP 10.6 ABORTADO${opId ? ` (${opId})` : ""}: ${message}`);
    this.name = "CatchupAbort";
    this.opId = opId;
  }
}

export async function executeCatchup106Plan({ client, plan } = {}) {
  if (!client || !plan) throw new Error("client e plan são obrigatórios");
  const run = (tx) => runPlan(tx, plan);
  return typeof client.$transaction === "function" ? client.$transaction(run, { timeout: 180000, maxWait: 20000 }) : run(client);
}

// fases de execução (estável dentro da fase = ordem do plano)
function rank(op) {
  switch (op.kind) {
    case "ADD_CARD_EXPENSE": return op.data.posted === false ? 6 : 3;
    case "ADD_PURCHASE_WITH_INSTALLMENTS": return 3;
    case "RECORD_CARD_BILL_OBSERVATION": return 4;
    case "SYNC_CARD_BILL_ROW": return 7;
    case "RECORD_CARD_LIMIT_OBSERVATION": return 7;
    case "ADD_INTERNAL_REIMBURSEMENT": return 8;
    case "ADD_BALANCE_RECONCILIATION": return 9;
    default: return 1;
  }
}

async function runPlan(tx, plan) {
  if (plan.blockers?.length) throw new CatchupAbort(`o plano tem bloqueios: ${plan.blockers.join(" | ")}`);
  const ops = plan.operations ?? [];
  const ids = new Set();
  for (const o of ops) {
    if (!KNOWN.has(o.kind)) throw new CatchupAbort(`operação desconhecida ${o.kind}`, o.id);
    if (!o.preconditions) throw new CatchupAbort("operação sem preconditions", o.id);
    if (ids.has(o.id)) throw new CatchupAbort("id de operação duplicado", o.id);
    ids.add(o.id);
  }
  const mutations = { created: {}, updated: {}, deleted: {}, total: 0 };
  const bump = (kind, model, n = 1) => {
    mutations[kind][model] = (mutations[kind][model] ?? 0) + n;
    mutations.total += n;
  };
  const skipped = [];
  const fail = (op, msg) => {
    throw new CatchupAbort(msg, op.id);
  };
  const accountBySlug = async (op, slug) => {
    const a = await tx.account.findFirst({ where: { slug } });
    if (!a) fail(op, `conta '${slug}' não existe`);
    return a;
  };
  async function assertAbsentEntry(op, a) {
    const where = a.cardId ? { cardId: a.cardId } : { accountId: a.accountId };
    const found = await tx[a.model].findFirst({ where: { ...where, OR: [{ rawMessage: { startsWith: a.marker } }, { occurredAt: { gte: day(a.day), lt: new Date(day(a.day).getTime() + 86400000) }, amount: a.amount }] } });
    if (found) fail(op, `já existe lançamento equivalente (${a.model} ${found.id}) — o plano está desatualizado`);
  }
  const audit = (model, recordId, action, preimage, fieldChanges, op) => tx.telegramCorrectionAudit.create({ data: { model, recordId, action, preimage, fieldChanges, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: `${PLAN_TAG}:${op.id}` } });

  // createdAt explícito e estritamente crescente (≥ relógio real): a observação de novembro fica DEPOIS de todo lançamento já postado e a
  // compra de 12/10 (Rei do Pernil) DEPOIS da observação — é isso que o motor usa para separar "observado" de "lançado depois".
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1000);
    return new Date(lastStamp);
  };
  let observationCreatedAt = null;

  const ordered = ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
  for (const op of ordered) {
    const pre = op.preconditions;
    switch (op.kind) {
      case "PAY_HOUSE_BILL": {
        const rule = await tx.recurringRule.findUnique({ where: { id: pre.ruleId } });
        if (!rule || rule.name !== "Energia") fail(op, "regra de Energia mudou");
        const existing = await tx.bill.findFirst({ where: { recurringRuleId: rule.id, cycleMonth: pre.noBillForCycle, part: 1 } });
        if (existing) fail(op, "já existe Bill de Energia para o ciclo");
        await payHouseBill({ ruleId: rule.id, cycleMonth: op.target.cycleMonth, part: 1, accountId: op.data.accountId, paidAt: day(op.data.paidAt).toISOString(), amount: op.data.amount }, { client: tx });
        bump("created", "bill");
        bump("created", "expense");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "CORRECT_CARD_BILL_PAYMENT": {
        const t = await tx.transfer.findUnique({ where: { id: pre.transferId } });
        const bill = await tx.cardBill.findUnique({ where: { id: pre.billId } });
        if (!t || t.kind !== "card_bill_payment" || !same(t.amount, pre.currentAmount) || t.cardBillId !== bill?.id) fail(op, "pagamento da fatura mudou");
        if (!bill || bill.status !== pre.billStatus || !same(bill.totalAmount, pre.billTotal)) fail(op, "fatura de outubro mudou");
        if (/\|bank=/.test(t.rawMessage ?? "")) fail(op, "pagamento já conciliado com o banco — não corrigir");
        const preimage = serializeRecord(t);
        const rawMessage = String(t.rawMessage).replace(`amount=${money(pre.currentAmount).toFixed(2)}`, `amount=${money(op.to.amount).toFixed(2)}`);
        if (rawMessage === t.rawMessage) fail(op, "chave do pagamento não contém o valor esperado");
        await tx.transfer.update({ where: { id: t.id }, data: { amount: op.to.amount, rawMessage, description: `${t.description} (pago ${money(op.to.amount).toFixed(2)} em dinheiro + ${TARGETS.octCredit} em crédito do estorno)` } });
        // paidAmount permanece 1.795,77: o total da fatura foi quitado (1.677,43 em conta + 118,34 em crédito) — restante 0
        await audit("transfer", t.id, "correct_card_bill_payment", preimage, { amount: { from: pre.currentAmount, to: op.to.amount } }, op);
        bump("updated", "transfer");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "RECONCILE_PAYMENT_BANK_LINE": {
        const r = await reconcileBankLineWithCardBillPayment({ accountId: op.data.accountId, amount: op.data.amount, date: op.data.date, reference: op.data.reference, client: tx });
        if (!r.matched || r.alreadyReconciled) fail(op, `conciliação não casou com o pagamento: ${JSON.stringify(r)}`);
        bump("updated", "transfer");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "ADD_CARD_CREDIT": {
        const clash = await tx.cardCreditMovement.findFirst({ where: { cardId: op.target.cardId, note: { startsWith: pre.absent.notePrefix } } });
        if (clash) fail(op, "movimento de crédito equivalente já existe");
        const pay = op.data.linkPayment ? await tx.transfer.findFirst({ where: { cardBillId: op.data.cardBillId, kind: "card_bill_payment", rawMessage: { startsWith: PAYMENT_KEY_PREFIX } } }) : null;
        await tx.cardCreditMovement.create({ data: { cardId: op.target.cardId, amount: op.data.amount, kind: op.data.kind, occurredAt: day(op.data.occurredAt), note: op.data.note, confidence: "CONFIRMED", cardBillId: op.data.cardBillId, transferId: pay?.id ?? null } });
        bump("created", "cardCreditMovement");
        break;
      }
      case "ADD_ACCOUNT": {
        if (await tx.account.findFirst({ where: { slug: pre.absentSlug } })) fail(op, "conta já existe");
        await tx.account.create({ data: { slug: op.data.slug, name: op.data.name, type: op.data.type } });
        bump("created", "account");
        break;
      }
      case "ADD_TRANSFER": {
        if (await tx.transfer.findFirst({ where: { rawMessage: { startsWith: pre.absent.rawMessagePrefix } } })) fail(op, "transferência equivalente já existe");
        const from = await accountBySlug(op, op.data.fromSlug);
        const to = await accountBySlug(op, op.data.toSlug);
        await tx.transfer.create({ data: { amount: op.data.amount, description: op.data.description, fromAccountId: from.id, toAccountId: to.id, kind: "generic", source: "manual", confidence: "CONFIRMED", rawMessage: op.data.rawMessage, occurredAt: day(op.data.occurredAt) } });
        bump("created", "transfer");
        break;
      }
      case "ADD_RESERVE": {
        const acc = await accountBySlug(op, op.data.accountSlug);
        if (await tx.reserve.findFirst({ where: { accountId: acc.id, name: op.data.name } })) fail(op, "reserva já existe");
        await tx.reserve.create({ data: { accountId: acc.id, name: op.data.name, targetAmount: op.data.targetAmount, isActive: true } });
        bump("created", "reserve");
        break;
      }
      case "ADD_RESERVE_MOVEMENT": {
        const reserve = await tx.reserve.findFirst({ where: { name: op.data.reserveName } });
        if (!reserve) fail(op, "reserva Tattoo não existe");
        if (await tx.reserveMovement.findFirst({ where: { reserveId: reserve.id, kind: op.data.kind, amount: op.data.amount } })) fail(op, "movimento da reserva já existe");
        await tx.reserveMovement.create({ data: { reserveId: reserve.id, amount: op.data.amount, kind: op.data.kind, occurredAt: day(op.data.occurredAt), note: op.data.note, confidence: "CONFIRMED" } });
        bump("created", "reserveMovement");
        break;
      }
      case "UPDATE_GOAL_SAVED": {
        const g = await tx.goal.findUnique({ where: { id: pre.goalId } });
        if (!g || !same(g.savedAmount, pre.currentSaved)) fail(op, "meta Tattoo mudou");
        const preimage = serializeRecord(g);
        await tx.goal.update({ where: { id: g.id }, data: { savedAmount: op.to.savedAmount } });
        await audit("goal", g.id, "correct", preimage, { savedAmount: { from: pre.currentSaved, to: op.to.savedAmount } }, op);
        bump("updated", "goal");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "ADD_INCOME":
      case "ADD_EXPENSE": {
        await assertAbsentEntry(op, pre.absent);
        const { occurredAt, ...rest } = op.data;
        await tx[pre.absent.model].create({ data: { ...rest, accountId: op.target.accountId, occurredAt: day(occurredAt) } });
        bump("created", pre.absent.model);
        break;
      }
      case "ADD_RECEIVABLE_RECEIVED": {
        if (await tx.receivable.findFirst({ where: { notes: { startsWith: pre.absent.notesPrefix } } })) fail(op, "recebível equivalente já existe");
        const d = op.data;
        const rec = await createReceivable({ description: d.description, counterparty: d.counterparty, amount: d.amount, expectedDate: null, notes: d.notes, confidence: "CONFIRMED" }, { client: tx });
        await markReceivableReceived(rec.id, { accountId: d.accountId, occurredAt: day(d.receivedAt), description: d.incomeDescription, category: d.category, confidence: "CONFIRMED", client: tx });
        bump("created", "receivable");
        bump("updated", "receivable");
        bump("created", "income");
        break;
      }
      case "UNFUND_COMMITMENT": {
        const c = await tx.confirmedCommitment.findUnique({ where: { id: pre.commitmentId } });
        if (!c || c.status !== pre.status || !same(c.amount, pre.amount) || c.settlementMode !== pre.settlementMode || c.fundingAccountId !== pre.fundingAccountId) fail(op, "compromisso CNPJ mudou");
        if (c.settledAt || c.settledTransferId || c.expenseId) fail(op, "compromisso CNPJ já foi liquidado — não alterar");
        const preimage = serializeRecord(c);
        await tx.confirmedCommitment.update({ where: { id: c.id }, data: { status: "CONFIRMED", fundingAccountId: null, fundingReserveId: null, fundedAt: null, dueDate: null, notes: op.data.notes } });
        await audit("confirmedCommitment", c.id, "correct", preimage, { status: { from: c.status, to: "CONFIRMED" }, fundingAccountId: { from: c.fundingAccountId, to: null } }, op);
        bump("updated", "confirmedCommitment");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "ADD_RECEIVABLE": {
        if (await tx.receivable.findFirst({ where: { notes: { startsWith: pre.absent.notesPrefix } } })) fail(op, "recebível equivalente já existe");
        const d = op.data;
        await createReceivable({ description: d.description, counterparty: d.counterparty, amount: d.amount, expectedDate: null, notes: d.notes, confidence: "CONFIRMED" }, { client: tx });
        bump("created", "receivable");
        break;
      }
      case "ADD_CARD_EXPENSE": {
        await assertAbsentEntry(op, { ...pre.absent, model: "expense" });
        const { occurredAt, posted, ...rest } = op.data;
        await tx.expense.create({ data: { ...rest, cardId: op.target.cardId, occurredAt: day(occurredAt), ...(posted === false ? { createdAt: stamp() } : {}) } });
        bump("created", "expense");
        break;
      }
      case "ADD_PURCHASE_WITH_INSTALLMENTS": {
        const a = pre.absent;
        const dup = (await tx.purchase.findMany({ where: { cardId: a.cardId } })).find((x) => (x.rawMessage ?? "").startsWith(a.marker) || (dayKey(x.purchasedAt) === a.purchasedDay && same(x.installmentValue, a.value) && x.installmentCount === a.count));
        if (dup) fail(op, `compra parcelada já existe (${dup.id})`);
        const d = op.data;
        const created = await tx.purchase.create({ data: { description: d.description, totalAmount: d.totalAmount, installmentCount: d.installmentCount, installmentValue: d.installmentValue, category: d.category, cardId: op.target.cardId, firstInstallmentMonth: d.firstInstallmentMonth, startingInstallmentNumber: d.startingInstallmentNumber, source: "manual", confidence: d.confidence, rawMessage: `${d.rawMessage} | fatura Itaú 13/10/2026 | 3x de ${d.installmentValue}`, purchasedAt: day(d.purchasedAt) } });
        await tx.installment.createMany({ data: d.rows.map((r) => ({ purchaseId: created.id, number: r.number, amount: r.amount, billMonth: r.billMonth })) });
        bump("created", "purchase");
        bump("created", "installment", d.rows.length);
        break;
      }
      case "RECORD_CARD_BILL_OBSERVATION": {
        const clash = await tx.cardBillReconciliation.findFirst({ where: { cardId: pre.cardId, cycleMonth: pre.cycleMonth, observedTotal: pre.noObservationWithTotal } });
        if (clash) fail(op, "observação da fatura equivalente já existe");
        const card = await tx.card.findUnique({ where: { id: pre.cardId } });
        const calc = await computeExpectedCardBillTotal(card, pre.cycleMonth, { client: tx });
        if (!same(calc, op.data.calculatedTotal)) fail(op, `total calculado da fatura (${calc.toFixed(2)}) difere do projetado pelo plano (${op.data.calculatedTotal}) — alguma linha do cartão não foi aplicada como esperado`);
        const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: pre.cardId, cycleMonth: pre.cycleMonth } } });
        observationCreatedAt = stamp();
        await tx.cardBillReconciliation.create({ data: { cardBillId: bill?.id ?? null, cardId: pre.cardId, cycleMonth: pre.cycleMonth, observedTotal: op.data.observedTotal, calculatedTotal: calc, delta: subtractMoney(op.data.observedTotal, calc), note: op.data.note, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: new Date(op.data.occurredAt), createdAt: observationCreatedAt } });
        bump("created", "cardBillReconciliation");
        break;
      }
      case "SYNC_CARD_BILL_ROW": {
        const b = await tx.cardBill.findUnique({ where: { id: pre.billId } });
        if (!b || !same(b.totalAmount, pre.currentTotal) || b.status !== pre.currentStatus) fail(op, `CardBill ${b?.cycleMonth ?? pre.billId} mudou`);
        await tx.cardBill.update({ where: { id: b.id }, data: { totalAmount: op.data.totalAmount } });
        bump("updated", "cardBill");
        break;
      }
      case "RECORD_CARD_LIMIT_OBSERVATION": {
        const clash = await tx.cardLimitUpdate.findFirst({ where: { cardId: pre.cardId, newUsedLimit: pre.noLimitObservationWithUsed } });
        if (clash) fail(op, "observação de limite equivalente já existe");
        const d = op.data;
        await tx.cardLimitUpdate.create({ data: { cardId: pre.cardId, newTotalLimit: d.newTotalLimit, newUsedLimit: d.newUsedLimit, reportedAvailable: d.reportedAvailable, note: "Snapshot do limite no app do Itaú em 13/10/2026 (total 5.087,00; disponível 3.465,22; utilizado 1.621,78) = fatura de novembro 1.060,46 + parcelas futuras 461,32 + compra de 12/10 ainda não postada 100,00.", source: "manual", confidence: "CONFIRMED", rawMessage: d.rawMessage, occurredAt: new Date(d.occurredAt) } });
        bump("created", "cardLimitUpdate");
        break;
      }
      case "ADD_INTERNAL_REIMBURSEMENT": {
        const d = op.data;
        if (await tx.internalReimbursement.findFirst({ where: { notes: { startsWith: pre.absent.notesPrefix } } })) fail(op, "repasse equivalente já existe");
        const caju = await tx.account.findFirst({ where: { slug: "vale-alimentacao" } });
        const itau = await tx.account.findFirst({ where: { slug: "itau" } });
        const src = d.sourceExpenseMarker ? await tx.expense.findFirst({ where: { rawMessage: { startsWith: d.sourceExpenseMarker } } }) : null;
        await createInternalReimbursement({ fromAccountId: caju.id, toAccountId: itau.id, amount: d.amount, description: d.description, sourceExpenseId: src?.id ?? null, sourceLabel: d.sourceLabel, confidence: "CONFIRMED", notes: d.notes, client: tx });
        bump("created", "internalReimbursement");
        break;
      }
      case "ADD_BALANCE_RECONCILIATION": {
        const ledger = await computeAccountBalance(pre.accountId, { client: tx });
        if (!same(ledger, pre.expectedLedgerAfterLines)) fail(op, `ledger recalculado ${ledger.toFixed(2)} ≠ esperado ${pre.expectedLedgerAfterLines} — o resíduo mudou inesperadamente`);
        const residual = subtractMoney(pre.targetBalance, ledger);
        if (residual.isZero()) {
          skipped.push({ id: op.id, reason: "ledger já igual ao saldo autoritativo — nenhum ajuste necessário" });
          break;
        }
        if (!same(residual, pre.expectedAdjustment)) fail(op, `resíduo ${residual.toFixed(2)} ≠ esperado ${pre.expectedAdjustment}`);
        if (await tx.balanceAdjustment.findFirst({ where: { accountId: pre.accountId, rawMessage: op.data.rawMessage } })) fail(op, "ajuste de reconciliação equivalente já existe");
        await tx.balanceAdjustment.create({ data: { accountId: pre.accountId, newBalance: op.data.newBalance, note: `${op.data.note} Ledger ${ledger.toFixed(2)} vs saldo autoritativo ${op.data.newBalance} — resíduo ${residual.toFixed(2)} (RECONCILIATION_ADJUSTMENT; não é Expense/Income).`, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: new Date(op.data.occurredAt) } });
        bump("created", "balanceAdjustment");
        break;
      }
      default:
        fail(op, "operação sem handler");
    }
  }

  // ------------------------------------------------------------ verificação final (dentro da mesma transação)
  const verification = {};
  if (ops.length > 0) {
    const bySlug = async (slug) => tx.account.findFirst({ where: { slug } });
    const [itau, caju, dinheiro, cofrinho] = await Promise.all(["itau", "vale-alimentacao", "dinheiro", "cofrinho-itau"].map(bySlug));
    const card = await tx.card.findFirst({ orderBy: { createdAt: "asc" } });
    verification.itau = (await computeAccountBalance(itau.id, { client: tx })).toFixed(2);
    verification.caju = (await computeAccountBalance(caju.id, { client: tx })).toFixed(2);
    verification.dinheiro = (await computeAccountBalance(dinheiro.id, { client: tx })).toFixed(2);
    verification.cofrinho = cofrinho ? (await computeAccountBalance(cofrinho.id, { client: tx })).toFixed(2) : null;
    const rec = await tx.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: "2026-11" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    verification.novObserved = rec ? money(rec.observedTotal).toFixed(2) : null;
    verification.additionsSinceNovObservation = rec ? (await computeAdditionsSinceObservation(card, "2026-11", rec, { client: tx })).toFixed(2) : null;
    const problems = [];
    if (!same(verification.itau, TARGETS.itau)) problems.push(`Itaú ${verification.itau} ≠ ${TARGETS.itau}`);
    if (!same(verification.caju, TARGETS.caju)) problems.push(`Caju ${verification.caju} ≠ ${TARGETS.caju}`);
    if (!same(verification.dinheiro, TARGETS.dinheiro)) problems.push(`Dinheiro ${verification.dinheiro} ≠ ${TARGETS.dinheiro}`);
    if (verification.cofrinho !== null && !same(verification.cofrinho, TARGETS.tattoo)) problems.push(`Cofrinho ${verification.cofrinho} ≠ ${TARGETS.tattoo}`);
    if (verification.novObserved !== null && !same(verification.novObserved, TARGETS.novObserved)) problems.push(`observação de novembro ${verification.novObserved} ≠ ${TARGETS.novObserved}`);
    if (verification.additionsSinceNovObservation !== null && !same(verification.additionsSinceNovObservation, "100.00")) problems.push(`acréscimos depois da observação de novembro = ${verification.additionsSinceNovObservation} (esperado 100,00 — Rei do Pernil)`);
    if (problems.length) throw new CatchupAbort(`verificação final falhou: ${problems.join("; ")}`);
  }
  return { applied: ordered.length - skipped.length, skipped, mutations, verification };
}
