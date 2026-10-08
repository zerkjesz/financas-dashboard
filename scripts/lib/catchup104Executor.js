// Fase 10.4 — PASSO B: EXECUTOR do catch-up. Separado do planner (scripts/lib/catchup104Planner.js, 100% somente leitura).
//
//   buildCatchup104Plan({ client })            => somente leitura (planner)
//   executeCatchup104Plan({ client, plan })    => aplica o plano JÁ VALIDADO, com guardas; qualquer precondition falha => ABORTA e reverte tudo
//
// O executor NÃO recalcula decisões financeiras: cada operação traz as `preconditions` que o planner observou; o executor confere que o
// estado ainda é exatamente aquele e só então escreve. Única "decisão" em tempo de execução, por pedido explícito: os ajustes de
// reconciliação de saldo — só são gravados depois que todas as linhas reais foram aplicadas e o ledger recalculado deixa EXATAMENTE o resíduo
// esperado; resíduo diferente => ABORTA; resíduo zero => não grava ajuste.
//
// Transação: se `client` for o cliente raiz do Prisma, tudo roda em UMA transação interativa (tudo-ou-nada). Se `client` já for uma
// transação (testes / runners), participa dela e o chamador controla o commit/rollback.
import { money, subtractMoney, addMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { computeExpectedCardBillTotal, computeAdditionsSinceObservation } from "../../lib/cardBillCalculator.js";
import { undoHouseBillPayment } from "../../lib/houseBills.js";
import { serializeRecord } from "../../lib/telegramAi/correctionService.js";
import { PLAN_TAG, TARGETS } from "./catchup104Planner.js";

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);
const same = (a, b) => money(a).minus(money(b)).abs().lt("0.005");
const KNOWN = new Set(["REMOVE_FALSE_HOUSE_PAYMENT", "CORRECT_HOUSE_PAYMENT_AMOUNT", "ADD_INCOME", "ADD_EXPENSE", "ADD_CONFIRMED_COMMITMENT", "DISMISS_CONTINGENCY", "CORRECT_CARD_EXPENSE", "ADD_CARD_EXPENSE", "ADD_PURCHASE_WITH_INSTALLMENTS", "RENAME_PURCHASE", "SYNC_CARD_BILL_ROW", "RECORD_CARD_LIMIT_OBSERVATION", "RECORD_CARD_BILL_OBSERVATION", "ADD_BALANCE_RECONCILIATION"]);

export class CatchupAbort extends Error {
  constructor(message, opId) {
    super(`CATCH-UP ABORTADO${opId ? ` (${opId})` : ""}: ${message}`);
    this.name = "CatchupAbort";
    this.opId = opId;
  }
}

export async function executeCatchup104Plan({ client, plan } = {}) {
  if (!client || !plan) throw new Error("client e plan são obrigatórios");
  const run = (tx) => runPlan(tx, plan);
  return typeof client.$transaction === "function" ? client.$transaction(run, { timeout: 180000, maxWait: 20000 }) : run(client);
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

  async function assertAbsentEntry(op, a) {
    const where = a.cardId ? { cardId: a.cardId } : { accountId: a.accountId };
    const found = await tx[a.model].findFirst({ where: { ...where, OR: [{ rawMessage: { startsWith: a.marker } }, { occurredAt: { gte: day(a.day), lt: new Date(day(a.day).getTime() + 86400000) }, amount: a.amount }] } });
    if (found) fail(op, `já existe lançamento equivalente (${a.model} ${found.id}) — o plano está desatualizado`);
  }

  // ordem do plano; os ajustes de saldo (ADD_BALANCE_RECONCILIATION) sempre por último
  const ordered = [...ops.filter((o) => o.kind !== "ADD_BALANCE_RECONCILIATION"), ...ops.filter((o) => o.kind === "ADD_BALANCE_RECONCILIATION")];
  for (const op of ordered) {
    const pre = op.preconditions;
    switch (op.kind) {
      case "REMOVE_FALSE_HOUSE_PAYMENT": {
        const bill = await tx.bill.findUnique({ where: { id: pre.billId }, include: { expense: true } });
        if (!bill || bill.status !== pre.billStatus || !same(bill.amount, pre.billAmount) || bill.cycleMonth !== pre.cycleMonth) fail(op, "Bill da Água não está como o plano observou");
        if (!bill.expense || bill.expense.id !== pre.expenseId || !same(bill.expense.amount, pre.expenseAmount) || dayKey(bill.expense.occurredAt) !== pre.expenseDay) fail(op, "Expense da Água não está como o plano observou");
        await undoHouseBillPayment(bill.id, {}, { client: tx });
        bump("deleted", "expense");
        bump("deleted", "bill");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "CORRECT_HOUSE_PAYMENT_AMOUNT": {
        const exp = await tx.expense.findUnique({ where: { id: pre.expenseId } });
        const bill = await tx.bill.findUnique({ where: { id: pre.billId } });
        if (!exp || !same(exp.amount, pre.expenseAmount)) fail(op, "Expense do Telefone mudou");
        if (!bill || !same(bill.amount, pre.billAmount) || bill.status !== pre.billStatus || exp.billId !== bill.id) fail(op, "Bill do Telefone mudou");
        const preimage = serializeRecord(exp);
        await tx.expense.update({ where: { id: exp.id }, data: { amount: op.to } });
        await tx.bill.update({ where: { id: bill.id }, data: { amount: op.to } });
        await tx.telegramCorrectionAudit.create({ data: { model: "expense", recordId: exp.id, action: "correct", preimage, fieldChanges: { amount: { from: op.from, to: op.to } }, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: `${PLAN_TAG}:phone` } });
        bump("updated", "expense");
        bump("updated", "bill");
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
      case "ADD_CONFIRMED_COMMITMENT": {
        const clash = await tx.confirmedCommitment.findFirst({ where: { description: { startsWith: pre.noActiveCommitmentStartingWith }, status: { not: "CANCELLED" } } });
        if (clash) fail(op, "já existe compromisso Tiger ativo");
        if (op.data.dueDate !== null) fail(op, "o compromisso Tiger deve ficar SEM prazo");
        await tx.confirmedCommitment.create({ data: { description: op.data.description, shortLabel: op.data.shortLabel, amount: op.data.amount, dueDate: null, status: op.data.status, notes: op.data.notes, confidence: op.data.confidence } });
        bump("created", "confirmedCommitment");
        break;
      }
      case "DISMISS_CONTINGENCY": {
        const c = await tx.contingency.findUnique({ where: { id: pre.contingencyId } });
        if (!c || c.status !== pre.currentStatus || c.description !== pre.description) fail(op, "contingência Tiger mudou");
        await tx.contingency.update({ where: { id: c.id }, data: { status: op.data.status, notes: `${c.notes ? c.notes + " | " : ""}${op.data.notesAppend}` } });
        bump("updated", "contingency");
        break;
      }
      case "CORRECT_CARD_EXPENSE": {
        const e = await tx.expense.findUnique({ where: { id: pre.expenseId } });
        if (!e || e.cardId !== pre.cardId || !same(e.amount, pre.currentAmount) || dayKey(e.occurredAt) !== pre.currentDay || e.description !== pre.currentDescription) fail(op, `linha do cartão mudou (${pre.expenseId})`);
        const data = { ...op.data };
        if (data.occurredAt) data.occurredAt = day(data.occurredAt);
        const preimage = serializeRecord(e);
        await tx.expense.update({ where: { id: e.id }, data });
        await tx.telegramCorrectionAudit.create({ data: { model: "expense", recordId: e.id, action: "correct", preimage, fieldChanges: Object.fromEntries(Object.entries(op.data).map(([k, v]) => [k, { to: v }])), chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: `${PLAN_TAG}:${op.id}` } });
        bump("updated", "expense");
        bump("created", "telegramCorrectionAudit");
        break;
      }
      case "ADD_CARD_EXPENSE": {
        await assertAbsentEntry(op, { ...pre.absent, model: "expense" });
        const { occurredAt, ...rest } = op.data;
        await tx.expense.create({ data: { ...rest, cardId: op.target.cardId, occurredAt: day(occurredAt) } });
        bump("created", "expense");
        break;
      }
      case "ADD_PURCHASE_WITH_INSTALLMENTS": {
        const a = pre.absent;
        const dup = (await tx.purchase.findMany({ where: { cardId: a.cardId } })).find((x) => (x.rawMessage ?? "").startsWith(a.marker) || (dayKey(x.purchasedAt) === a.purchasedDay && same(x.installmentValue, a.value) && x.installmentCount === a.count));
        if (dup) fail(op, `compra parcelada já existe (${dup.id})`);
        const d = op.data;
        const derived = d.rows.filter((r) => r.derived).map((r) => `${r.number}/${d.installmentCount}`);
        const observed = d.rows.filter((r) => !r.derived).map((r) => `${r.number}/${d.installmentCount}`);
        const provenance = `${d.rawMessage} | fatura Itaú 04/10/2026 | parcelas observadas: ${observed.join(", ")}${derived.length ? ` | derived_from_official_statement (ESTIMATED): ${derived.join(", ")}` : ""}${d.totalDerived ? " | total derivado (valor × parcelas)" : ""}${d.note ? ` | ${d.note}` : ""}`;
        const created = await tx.purchase.create({ data: { description: d.description, totalAmount: d.totalAmount, installmentCount: d.installmentCount, installmentValue: d.installmentValue, category: d.category, cardId: op.target.cardId, firstInstallmentMonth: d.firstInstallmentMonth, startingInstallmentNumber: d.startingInstallmentNumber, source: "manual", confidence: d.confidence, rawMessage: provenance, purchasedAt: day(d.purchasedAt) } });
        await tx.installment.createMany({ data: d.rows.map((r) => ({ purchaseId: created.id, number: r.number, amount: r.amount, billMonth: r.billMonth })) });
        bump("created", "purchase");
        bump("created", "installment", d.rows.length);
        break;
      }
      case "RENAME_PURCHASE": {
        const p = await tx.purchase.findUnique({ where: { id: pre.purchaseId } });
        if (!p || p.description !== pre.currentDescription) fail(op, "compra Shein mudou");
        await tx.purchase.update({ where: { id: p.id }, data: { description: op.data.description } });
        bump("updated", "purchase");
        break;
      }
      case "SYNC_CARD_BILL_ROW": {
        const b = await tx.cardBill.findUnique({ where: { id: pre.billId } });
        if (!b || !same(b.totalAmount, pre.currentTotal) || b.status !== pre.currentStatus || dayKey(b.dueAt) !== pre.currentDueDay) fail(op, `CardBill ${b?.cycleMonth ?? pre.billId} mudou`);
        const data = { ...op.data };
        if (data.dueAt) data.dueAt = day(data.dueAt);
        await tx.cardBill.update({ where: { id: b.id }, data });
        bump("updated", "cardBill");
        break;
      }
      case "RECORD_CARD_LIMIT_OBSERVATION": {
        const clash = await tx.cardLimitUpdate.findFirst({ where: { cardId: pre.cardId, newUsedLimit: pre.noLimitObservationWithUsed } });
        if (clash) fail(op, "observação de limite equivalente já existe");
        const d = op.data;
        await tx.cardLimitUpdate.create({ data: { cardId: pre.cardId, newTotalLimit: d.newTotalLimit, newUsedLimit: d.newUsedLimit, reportedAvailable: d.reportedAvailable, note: "Observação do banco NA DATA DE FECHAMENTO da fatura de 04/10/2026 (limite total 5.087,00; disponível 2.471,16; utilizado 2.615,84) — snapshot do fechamento, não é valor ao vivo.", source: "manual", confidence: "CONFIRMED", rawMessage: d.rawMessage, occurredAt: new Date(d.occurredAt) } });
        bump("created", "cardLimitUpdate");
        break;
      }
      case "RECORD_CARD_BILL_OBSERVATION": {
        const clash = await tx.cardBillReconciliation.findFirst({ where: { cardId: pre.cardId, cycleMonth: pre.cycleMonth, observedTotal: pre.noObservationWithTotal } });
        if (clash) fail(op, "observação da fatura equivalente já existe");
        const card = await tx.card.findUnique({ where: { id: pre.cardId } });
        const calc = await computeExpectedCardBillTotal(card, pre.cycleMonth, { client: tx });
        if (!same(calc, op.data.calculatedTotal)) fail(op, `total calculado da fatura (${calc.toFixed(2)}) difere do projetado pelo plano (${op.data.calculatedTotal}) — alguma linha do cartão não foi aplicada como esperado`);
        const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: pre.cardId, cycleMonth: pre.cycleMonth } } });
        await tx.cardBillReconciliation.create({ data: { cardBillId: bill?.id ?? null, cardId: pre.cardId, cycleMonth: pre.cycleMonth, observedTotal: op.data.observedTotal, calculatedTotal: calc, delta: subtractMoney(op.data.observedTotal, calc), note: "Fatura oficial Itaú fechada em 04/10/2026: total R$ 1.795,77 (nacionais 1.561,33 + internacionais 226,51 + IOF 7,93), vencimento 13/10/2026, NÃO paga. Substitui a observação de 25/09 (1.616,54).", source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: new Date(op.data.occurredAt) } });
        bump("created", "cardBillReconciliation");
        break;
      }
      case "ADD_BALANCE_RECONCILIATION": {
        // linhas reais já aplicadas acima ⇒ recalcula o ledger e só então decide
        const ledger = await computeAccountBalance(pre.accountId, { client: tx });
        if (!same(ledger, pre.expectedLedgerAfterLines)) fail(op, `ledger recalculado ${ledger.toFixed(2)} ≠ esperado ${pre.expectedLedgerAfterLines} — o resíduo mudou inesperadamente`);
        const residual = subtractMoney(pre.targetBalance, ledger);
        if (residual.isZero()) {
          skipped.push({ id: op.id, reason: "ledger já igual ao saldo autoritativo — nenhum ajuste necessário" });
          break;
        }
        if (!same(residual, pre.expectedAdjustment)) fail(op, `resíduo ${residual.toFixed(2)} ≠ esperado ${pre.expectedAdjustment}`);
        const dup = await tx.balanceAdjustment.findFirst({ where: { accountId: pre.accountId, rawMessage: op.data.rawMessage } });
        if (dup) fail(op, "ajuste de reconciliação equivalente já existe");
        await tx.balanceAdjustment.create({ data: { accountId: pre.accountId, newBalance: op.data.newBalance, note: `Reconciliação (${PLAN_TAG}): ledger ${ledger.toFixed(2)} vs saldo autoritativo ${op.data.newBalance} — resíduo ${residual.toFixed(2)} sem linha real correspondente (RECONCILIATION_ADJUSTMENT; não é Expense/Income).`, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: new Date(op.data.occurredAt) } });
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
    const itau = await tx.account.findFirst({ where: { slug: "itau" } });
    const caju = await tx.account.findFirst({ where: { slug: "vale-alimentacao" } });
    const card = await tx.card.findFirst({ orderBy: { createdAt: "asc" } });
    verification.itau = (await computeAccountBalance(itau.id, { client: tx })).toFixed(2);
    verification.caju = (await computeAccountBalance(caju.id, { client: tx })).toFixed(2);
    verification.cardCalculated = (await computeExpectedCardBillTotal(card, TARGETS.cardBillCycle, { client: tx })).toFixed(2);
    const rec = await tx.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: TARGETS.cardBillCycle }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    verification.additionsSinceObservation = rec ? (await computeAdditionsSinceObservation(card, TARGETS.cardBillCycle, rec, { client: tx })).toFixed(2) : null;
    const problems = [];
    if (!same(verification.itau, TARGETS.itauBank)) problems.push(`Itaú ${verification.itau} ≠ ${TARGETS.itauBank}`);
    if (!same(verification.caju, TARGETS.cajuBank)) problems.push(`Caju ${verification.caju} ≠ ${TARGETS.cajuBank}`);
    if (!same(verification.cardCalculated, TARGETS.cardBillObserved)) problems.push(`fatura calculada ${verification.cardCalculated} ≠ ${TARGETS.cardBillObserved}`);
    if (verification.additionsSinceObservation !== null && !same(verification.additionsSinceObservation, 0)) problems.push(`acréscimos depois da observação = ${verification.additionsSinceObservation} (deveria ser 0)`);
    if (problems.length) throw new CatchupAbort(`verificação final falhou: ${problems.join("; ")}`);
  }
  return { applied: ordered.length - skipped.length, skipped, mutations, verification };
}
