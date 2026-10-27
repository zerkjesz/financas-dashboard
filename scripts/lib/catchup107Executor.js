// Fase 10.7 — EXECUTOR do catch-up 14/10 → 27/10. Separado do planner (scripts/lib/catchup107Planner.js, 100% somente leitura).
//
//   buildCatchup107Plan({ client })            => somente leitura (planner)
//   executeCatchup107Plan({ client, plan })    => aplica o plano JÁ VALIDADO, com guardas; qualquer precondition falha => ABORTA e reverte tudo
//
// O executor NÃO recalcula decisões financeiras: cada operação traz as `preconditions` que o planner observou. Única "decisão" em tempo de
// execução: os ajustes de reconciliação de saldo só são gravados depois que TODAS as linhas reais foram aplicadas e o ledger recalculado deixa
// EXATAMENTE o resíduo esperado (diferente ⇒ ABORTA; zero ⇒ não grava). Âncoras sem horário bancário conhecido ficam no INSTANTE real da execução.
// ORDEM: a observação da fatura de novembro é gravada DEPOIS de todas as compras novas do cartão (createdAt explícito e crescente).
// Transação única (tudo-ou-nada) quando `client` é o cliente raiz.
import { money, subtractMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { computeExpectedCardBillTotal, computeAdditionsSinceObservation } from "../../lib/cardBillCalculator.js";
import { getReserveBalance } from "../../lib/reserves.js";
import { serializeRecord } from "../../lib/telegramAi/correctionService.js";
import { PLAN_TAG, TARGETS, OBSERVED_AT_POLICY, LATEST_LINE_DAY, BANK_EOD_13_10, SOURCES_NOTE } from "./catchup107Planner.js";

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const same = (a, b) => money(a).minus(money(b)).abs().lt("0.005");
const KNOWN = new Set(["ADD_BANK_BALANCE_REVISION", "ADD_INCOME", "ADD_EXPENSE", "ADD_RECURRING_INCOME", "ADD_CARD_EXPENSE", "RECORD_CARD_BILL_OBSERVATION", "SYNC_CARD_BILL_ROW", "ADD_EXTERNAL_INSTALLMENT_PLAN", "ADD_BALANCE_RECONCILIATION", "ADD_RESERVE_MOVEMENT", "UPDATE_GOAL_SAVED"]);

export class CatchupAbort extends Error {
  constructor(message, opId) {
    super(`CATCH-UP 10.7 ABORTADO${opId ? ` (${opId})` : ""}: ${message}`);
    this.name = "CatchupAbort";
    this.opId = opId;
  }
}

export async function executeCatchup107Plan({ client, plan } = {}) {
  if (!client || !plan) throw new Error("client e plan são obrigatórios");
  const run = (tx) => runPlan(tx, plan);
  return typeof client.$transaction === "function" ? client.$transaction(run, { timeout: 180000, maxWait: 20000 }) : run(client);
}

function rank(op) {
  switch (op.kind) {
    case "ADD_BANK_BALANCE_REVISION": return 0;
    case "ADD_CARD_EXPENSE": return 3;
    case "RECORD_CARD_BILL_OBSERVATION": return 4;
    case "ADD_EXTERNAL_INSTALLMENT_PLAN": return 5;
    case "SYNC_CARD_BILL_ROW": return 7;
    case "ADD_RESERVE_MOVEMENT": return 8;
    case "UPDATE_GOAL_SAVED": return 8;
    case "ADD_BALANCE_RECONCILIATION": return 9;
    default: return 1;
  }
}

async function runPlan(tx, plan) {
  if (plan.blockers?.length) throw new CatchupAbort(`o plano tem bloqueios: ${plan.blockers.join(" | ")}`);
  const ops = plan.operations ?? [];
  const observedAt = new Date(); // INSTANTE real da reconciliação (política das âncoras sem horário bancário conhecido)
  if (observedAt <= day(LATEST_LINE_DAY)) throw new CatchupAbort(`relógio (${observedAt.toISOString()}) não é posterior às linhas do plano (${LATEST_LINE_DAY})`);
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
  const audit = (model, recordId, action, preimage, fieldChanges, op) => tx.telegramCorrectionAudit.create({ data: { model, recordId, action, preimage, fieldChanges, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: `${PLAN_TAG}:${op.id}` } });
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1000);
    return new Date(lastStamp);
  };

  const ordered = ops.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
  for (const op of ordered) {
    const pre = op.preconditions;
    switch (op.kind) {
      case "ADD_BANK_BALANCE_REVISION": {
        const latest = await tx.balanceAdjustment.findFirst({ where: { accountId: pre.accountId }, orderBy: { occurredAt: "desc" } });
        if (!latest || latest.id !== pre.previousAnchorId || !same(latest.newBalance, pre.previousAnchorBalance)) fail(op, "a última âncora do Itaú mudou desde o plano");
        if (latest.occurredAt >= new Date(op.data.occurredAt)) fail(op, "a âncora de fim de dia 13/10 não seria a mais recente");
        if (op.data.occurredAt !== BANK_EOD_13_10) fail(op, "instante da revisão bancária inesperado");
        if (await tx.balanceAdjustment.findFirst({ where: { accountId: pre.accountId, rawMessage: op.data.rawMessage } })) fail(op, "revisão de 13/10 já existe");
        const residual = subtractMoney(subtractMoney(op.data.newBalance, pre.previousAnchorBalance), pre.explained);
        if (!same(residual, pre.expectedResidual)) fail(op, `resíduo da revisão ${residual.toFixed(2)} ≠ esperado ${pre.expectedResidual}`);
        // a âncora anterior NÃO é alterada nem apagada: histórico append-only
        await tx.balanceAdjustment.create({ data: { accountId: pre.accountId, newBalance: op.data.newBalance, note: op.data.note, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: new Date(op.data.occurredAt) } });
        bump("created", "balanceAdjustment");
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
      case "ADD_RECURRING_INCOME": {
        const rule = await tx.recurringRule.findUnique({ where: { id: pre.ruleId } });
        if (!rule || rule.kind !== "income") fail(op, "regra recorrente de renda mudou");
        if (rule.accountId != null && rule.accountId !== op.target.accountId) fail(op, "a regra está configurada para outra conta");
        if (await tx.income.findFirst({ where: { recurringRuleId: rule.id, recurringOccurrenceDate: day(pre.absentOccurrence) } })) fail(op, "a ocorrência recorrente já foi realizada");
        const { occurredAt, recurringOccurrenceDate, ...rest } = op.data;
        await tx.income.create({ data: { ...rest, accountId: op.target.accountId, recurringRuleId: rule.id, recurringOccurrenceDate: day(recurringOccurrenceDate), isRecurring: true, occurredAt: day(occurredAt) } });
        bump("created", "income");
        break;
      }
      case "ADD_CARD_EXPENSE": {
        await assertAbsentEntry(op, { ...pre.absent, model: "expense" });
        const { occurredAt, ...rest } = op.data;
        await tx.expense.create({ data: { ...rest, cardId: op.target.cardId, occurredAt: day(occurredAt) } });
        bump("created", "expense");
        break;
      }
      case "RECORD_CARD_BILL_OBSERVATION": {
        if (await tx.cardBillReconciliation.findFirst({ where: { cardId: pre.cardId, cycleMonth: pre.cycleMonth, rawMessage: op.data.rawMessage } })) fail(op, "observação da fase já existe");
        if (op.data.observedAt !== OBSERVED_AT_POLICY) fail(op, "política de instante da observação inesperada");
        const card = await tx.card.findUnique({ where: { id: pre.cardId } });
        const calc = await computeExpectedCardBillTotal(card, pre.cycleMonth, { client: tx });
        if (!same(calc, op.data.calculatedTotal)) fail(op, `total calculado da fatura (${calc.toFixed(2)}) difere do projetado pelo plano (${op.data.calculatedTotal}) — alguma compra do cartão não foi aplicada como esperado`);
        const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: pre.cardId, cycleMonth: pre.cycleMonth } } });
        await tx.cardBillReconciliation.create({ data: { cardBillId: bill?.id ?? null, cardId: pre.cardId, cycleMonth: pre.cycleMonth, observedTotal: op.data.observedTotal, calculatedTotal: calc, delta: subtractMoney(op.data.observedTotal, calc), note: op.data.note, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: observedAt, createdAt: stamp() } });
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
      case "ADD_EXTERNAL_INSTALLMENT_PLAN": {
        const d = op.data;
        if (await tx.externalInstallmentPlan.findFirst({ where: { description: d.description, creditor: d.creditor } })) fail(op, "plano Tattoo — parte 1 já existe");
        if (await tx.externalInstallmentPlan.findFirst({ where: { description: { contains: "Tattoo", mode: "insensitive" } } })) fail(op, "já existe um plano 'Tattoo' — a segunda tattoo não pode existir");
        if (d.dueTiming !== "CALENDAR_DATE" || d.firstDueDate !== "2026-10-27") fail(op, "Tattoo 1: a 1ª parcela deve ser compromisso do ciclo atual (CALENDAR_DATE, 27/10)");
        const first = day(d.firstDueDate);
        const addMonthsUtc = (base, n) => {
          const y = base.getUTCFullYear() + Math.floor((base.getUTCMonth() + n) / 12);
          const m = (base.getUTCMonth() + n) % 12;
          return new Date(Date.UTC(y, m, base.getUTCDate()));
        };
        const plan1 = await tx.externalInstallmentPlan.create({ data: { description: d.description, creditor: d.creditor, installmentValue: d.installmentValue, installmentCount: d.installmentCount, firstDueDate: first, dueTiming: "CALENDAR_DATE", status: "ACTIVE", confidence: d.confidence, notes: d.notes } });
        await tx.externalInstallment.createMany({ data: Array.from({ length: d.installmentCount }, (_, i) => ({ planId: plan1.id, number: i + 1, amount: d.installmentValue, dueDate: addMonthsUtc(first, i) })) });
        bump("created", "externalInstallmentPlan");
        bump("created", "externalInstallment", d.installmentCount);
        break;
      }
      case "ADD_RESERVE_MOVEMENT": {
        const reserve = await tx.reserve.findUnique({ where: { id: pre.reserveId } });
        if (!reserve) fail(op, "reserva Tattoo não existe");
        if (!same(await getReserveBalance(reserve.id, { client: tx }), pre.currentBalance)) fail(op, "saldo da reserva Tattoo mudou desde o plano");
        if (await tx.reserveMovement.findFirst({ where: { reserveId: reserve.id, note: { startsWith: pre.absentNotePrefix } } })) fail(op, "movimento de ajuste da reserva já existe");
        await tx.reserveMovement.create({ data: { reserveId: reserve.id, amount: op.data.amount, kind: op.data.kind, occurredAt: observedAt, note: op.data.note, confidence: "RECONCILIATION_ADJUSTMENT" } });
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
      case "ADD_BALANCE_RECONCILIATION": {
        const ledger = await computeAccountBalance(pre.accountId, { client: tx });
        if (!same(ledger, pre.expectedLedgerAfterLines)) fail(op, `ledger recalculado ${ledger.toFixed(2)} ≠ esperado ${pre.expectedLedgerAfterLines} — o resíduo mudou inesperadamente`);
        const residual = subtractMoney(pre.targetBalance, ledger);
        if (residual.isZero()) {
          skipped.push({ id: op.id, reason: "ledger já igual ao saldo autoritativo — nenhum ajuste necessário" });
          break;
        }
        if (!same(residual, pre.expectedAdjustment)) fail(op, `resíduo ${residual.toFixed(2)} ≠ esperado ${pre.expectedAdjustment}`);
        if (op.data.observedAt !== OBSERVED_AT_POLICY) fail(op, "política de instante da observação inesperada");
        if (await tx.balanceAdjustment.findFirst({ where: { accountId: pre.accountId, rawMessage: op.data.rawMessage } })) fail(op, "ajuste de reconciliação equivalente já existe");
        await tx.balanceAdjustment.create({ data: { accountId: pre.accountId, newBalance: op.data.newBalance, note: `${op.data.note} Ledger ${ledger.toFixed(2)} vs saldo autoritativo ${op.data.newBalance} — resíduo ${residual.toFixed(2)} (RECONCILIATION_ADJUSTMENT; não é Expense/Income).`, source: "manual", confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: op.data.rawMessage, occurredAt: observedAt } });
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
    verification.cofrinho = (await computeAccountBalance(cofrinho.id, { client: tx })).toFixed(2);
    const reserve = await tx.reserve.findFirst({ where: { accountId: cofrinho.id, name: "Tattoo" } });
    verification.tattooReserve = (await getReserveBalance(reserve.id, { client: tx })).toFixed(2);
    verification.tattooGoalSaved = money((await tx.goal.findFirst({ where: { name: { contains: "Tattoo", mode: "insensitive" } } })).savedAmount).toFixed(2);
    const rec = await tx.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: "2026-11" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    verification.novObserved = rec ? money(rec.observedTotal).toFixed(2) : null;
    verification.additionsSinceNovObservation = rec ? (await computeAdditionsSinceObservation(card, "2026-11", rec, { client: tx })).toFixed(2) : null;
    verification.reimbursementsPending = (await tx.internalReimbursement.findMany({ where: { status: "PENDING" } })).reduce((a, r) => a.plus(money(r.amount)), money(0)).toFixed(2);
    const problems = [];
    if (!same(verification.itau, TARGETS.itau)) problems.push(`Itaú ${verification.itau} ≠ ${TARGETS.itau}`);
    if (!same(verification.caju, TARGETS.caju)) problems.push(`Caju ${verification.caju} ≠ ${TARGETS.caju}`);
    if (!same(verification.dinheiro, TARGETS.dinheiro)) problems.push(`Dinheiro ${verification.dinheiro} ≠ ${TARGETS.dinheiro}`);
    if (!same(verification.cofrinho, TARGETS.cofrinho)) problems.push(`Cofrinho ${verification.cofrinho} ≠ ${TARGETS.cofrinho}`);
    if (!same(verification.tattooReserve, TARGETS.cofrinho)) problems.push(`Reserve Tattoo ${verification.tattooReserve} ≠ ${TARGETS.cofrinho}`);
    if (!same(verification.tattooGoalSaved, TARGETS.cofrinho)) problems.push(`Meta Tattoo ${verification.tattooGoalSaved} ≠ ${TARGETS.cofrinho}`);
    if (!same(verification.novObserved, TARGETS.novObserved)) problems.push(`observação de novembro ${verification.novObserved} ≠ ${TARGETS.novObserved}`);
    if (!same(verification.additionsSinceNovObservation, "0.00")) problems.push(`acréscimos depois da observação de novembro = ${verification.additionsSinceNovObservation} (esperado 0,00 — o Rei do Pernil já está no observado)`);
    if (!same(verification.reimbursementsPending, TARGETS.cajuReimbursements)) problems.push(`repasses PENDING ${verification.reimbursementsPending} ≠ ${TARGETS.cajuReimbursements}`);
    if (problems.length) throw new CatchupAbort(`verificação final falhou: ${problems.join("; ")}`);
  }
  return { applied: ordered.length - skipped.length, skipped, mutations, verification, sources: SOURCES_NOTE };
}
