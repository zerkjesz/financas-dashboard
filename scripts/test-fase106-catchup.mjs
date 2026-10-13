// Fase 10.6 — testes direcionados do PLANNER (somente leitura) e do EXECUTOR do catch-up 08/10 → 13/10.
// DEV apenas; cada cenário roda dentro de uma transação interativa que SEMPRE dá rollback.
//
//   node scripts/test-fase106-catchup.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { computeAccountBalance, listAccountsWithBalances } from "../lib/accounts.js";
import { computeCardUsedLimit, computeCardTotalLimit } from "../lib/cards.js";
import { computeAdditionsSinceObservation, getCardBillView } from "../lib/cardBillCalculator.js";
import { computeFreeMoney } from "../lib/freeMoney.js";
import { getReserveBalance } from "../lib/reserves.js";
import { summarizeInternalReimbursements } from "../lib/internalReimbursement.js";
import { buildCatchup106Plan, ANCHOR_AT } from "./lib/catchup106Planner.js";
import { executeCatchup106Plan, CatchupAbort } from "./lib/catchup106Executor.js";
import { wipe, seedBefore106, Rollback } from "./lib/catchup106Fixture.js";

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}
const TABLES = ["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "cardCreditMovement", "confirmedCommitment", "receivable", "reserve", "reserveMovement", "goal", "internalReimbursement", "recurringRule", "card", "account", "telegramCorrectionAudit", "dataOperation"];
const dbSignature = async () => JSON.stringify(await Promise.all(TABLES.map((m) => prisma[m].count())));
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore106(tx);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 180000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
const touched = async (tx) => {
  const maxU = async (m) => String((await tx[m].aggregate({ _max: { updatedAt: true } }))._max.updatedAt ?? "");
  return JSON.stringify([await Promise.all(TABLES.map((m) => tx[m].count())), await maxU("expense"), await maxU("transfer"), await maxU("cardBill"), await maxU("goal"), await maxU("confirmedCommitment")]);
};
const bal = async (tx, id) => (await computeAccountBalance(id, { client: tx })).toFixed(2);

async function main() {
  const plannerSrc = fs.readFileSync(new URL("./lib/catchup106Planner.js", import.meta.url), "utf8");
  check("[S] planner 10.6 sem escrita (mutação só no executor)", !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$transaction|\$execute|\bapply\b/i.test(plannerSrc));
  const before = await dbSignature();

  await inWorld(async (tx, w) => {
    const plan = await buildCatchup106Plan({ client: tx });
    check("[P] estado de partida: Itaú 694,61 · Caju 530,89 · Dinheiro 335,00", plan.balancesBefore.itau === "694.61" && plan.balancesBefore.caju === "530.89" && plan.balancesBefore.dinheiro === "335.00", JSON.stringify(plan.balancesBefore));
    check("[P] plano: 0 bloqueios e todos os checkpoints OK", plan.blockers.length === 0 && plan.checkpoints.every((c) => c.ok), JSON.stringify(plan.blockers));
    check("[P] plano: 52 operações", plan.operations.length === 52, String(plan.operations.length));
    check("[P] saldos projetados: Itaú 12,34 (+ajuste −0,06) · Caju 248,87 (−0,41) · Dinheiro 335,00 (−154,00)", plan.balancesProjected.itauLedger === "12.34" && plan.balancesProjected.itauAdjustment === "-0.06" && plan.balancesProjected.cajuLedger === "248.87" && plan.balancesProjected.cajuAdjustment === "-0.41" && plan.balancesProjected.dinheiroAdjustment === "-154.00", JSON.stringify(plan.balancesProjected));
    check("[P] novembro: observado 1.060,46 · calculado na observação 1.056,35 · lacuna 4,11 · futuras 461,32", plan.card.novObservedTarget === "1060.46" && plan.card.novCalculatedAtObservation === "1056.35" && plan.card.novKnownGap === "4.11" && plan.card.futureTotal === "461.32");

    const transfersBefore = await tx.transfer.count();
    const res = await executeCatchup106Plan({ client: tx, plan });
    check("[E] executor aplicou o plano e passou na verificação interna", res.applied === 52 && res.skipped.length === 0 && res.verification.itau === "12.28" && res.verification.caju === "248.46" && res.verification.dinheiro === "181.00" && res.verification.cofrinho === "150.00", JSON.stringify(res));

    // saldos pelo MOTOR REAL
    check("[E] Itaú 12,28 · Caju 248,46 · Dinheiro 181,00", (await bal(tx, w.itau.id)) === "12.28" && (await bal(tx, w.caju.id)) === "248.46" && (await bal(tx, w.dinheiro.id)) === "181.00");
    const adjs = await tx.balanceAdjustment.findMany({ where: { rawMessage: { startsWith: "FASE106-CATCHUP" } } });
    check("[E] 3 ajustes RECONCILIATION_ADJUSTMENT na âncora 13/10 23:59:59 BRT (nunca Expense/Income)", adjs.length === 3 && adjs.every((a) => a.confidence === "RECONCILIATION_ADJUSTMENT" && a.occurredAt.toISOString() === ANCHOR_AT) && adjs.map((a) => a.newBalance.toFixed(2)).sort().join() === "12.28,181.00,248.46");
    check("[E] ANCHOR_AT = 2026-10-14T02:59:59Z (13/10 23:59:59 BRT)", ANCHOR_AT === "2026-10-14T02:59:59.000Z");

    // Cofrinho / Tattoo
    const cof = await tx.account.findFirst({ where: { slug: "cofrinho-itau" } });
    const reserve = await tx.reserve.findFirst({ where: { name: "Tattoo" } });
    const goal = await tx.goal.findUnique({ where: { id: w.goal.id } });
    const tr = await tx.transfer.findFirst({ where: { toAccountId: cof.id } });
    check("[T] Cofrinho: conta savings com 150,00; Transfer Itaú→Cofrinho (não é despesa); Reserve Tattoo 150 (ALLOCATE) ; Goal 150/2.635", cof.type === "savings" && (await bal(tx, cof.id)) === "150.00" && tr.fromAccountId === w.itau.id && tr.amount.toFixed(2) === "150.00" && (await getReserveBalance(reserve.id, { client: tx })).toFixed(2) === "150.00" && goal.savedAmount.toFixed(2) === "150.00" && goal.targetAmount.toFixed(2) === "2635.00" && (await tx.transfer.count()) === transfersBefore + 1 /* cofrinho */ + 0);
    check("[T] nenhuma Expense 'Tattoo'/'Cofrinho' foi criada", (await tx.expense.count({ where: { OR: [{ description: { contains: "Cofrinho" } }, { description: { contains: "Tattoo" } }] } })) === 0);

    // fatura de outubro
    const pay = await tx.transfer.findUnique({ where: { id: w.payment.id } });
    const oct = await tx.cardBill.findUnique({ where: { id: w.oct.id } });
    check("[C] outubro: pagamento corrigido 1.795,77 → 1.677,43 (MESMO Transfer), conciliado com a linha bancária, fatura PAID com total/pago 1.795,77", pay.amount.toFixed(2) === "1677.43" && /\|bank=/.test(pay.rawMessage) && /amount=1677\.43/.test(pay.rawMessage) && oct.status === "paid" && oct.totalAmount.toFixed(2) === "1795.77" && oct.paidAmount.toFixed(2) === "1795.77" && (await tx.transfer.count({ where: { kind: "card_bill_payment" } })) === 1);
    const credits = await tx.cardCreditMovement.findMany({ where: { cardId: w.card.id }, orderBy: { kind: "asc" } });
    check("[C] crédito do estorno: CREDIT_APPLIED + CREDIT_GRANTED de 118,34 (saldo credor 0); compra/parcelas do portão intactas", credits.length === 2 && credits.every((c) => c.amount.toFixed(2) === "118.34") && credits.map((c) => c.kind).sort().join() === "CREDIT_APPLIED,CREDIT_GRANTED" && (await tx.installment.count({ where: { purchaseId: w.portao.id } })) === 2 && (await tx.purchase.findUnique({ where: { id: w.portao.id } })).totalAmount.toFixed(2) === "118.34");
    const oldObs = await tx.cardBillReconciliation.count({ where: { cycleMonth: "2026-10" } });
    check("[C] observações antigas de outubro preservadas (2)", oldObs === 2);

    // novembro
    const rec = await tx.cardBillReconciliation.findFirst({ where: { cardId: w.card.id, cycleMonth: "2026-11" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    check("[N] observação de novembro 1.060,46 (11/10 23:59:59 BRT), calculado 1.056,35, delta 4,11", rec.observedTotal.toFixed(2) === "1060.46" && rec.calculatedTotal.toFixed(2) === "1056.35" && rec.delta.toFixed(2) === "4.11" && rec.occurredAt.toISOString() === "2026-10-12T02:59:59.000Z");
    const card = await tx.card.findUnique({ where: { id: w.card.id } });
    check("[N] motor: acréscimo depois da observação = 100,00 (Rei do Pernil, incorrido e fora do observado)", (await computeAdditionsSinceObservation(card, "2026-11", rec, { client: tx })).toFixed(2) === "100.00");
    const view = await getCardBillView(card, "2026-11", { client: tx });
    check("[N] visão da fatura de novembro: total = 1.060,46 + 100,00 = 1.160,46", Number(view.totalAmount).toFixed(2) === "1160.46", String(view.totalAmount));
    const rei = await tx.expense.findFirst({ where: { cardId: w.card.id, description: { contains: "Rei do Pernil" } } });
    check("[N] Rei do Pernil: 100,00, 12/10, cartão, categoria Alimentação; 1 só", rei && rei.amount.toFixed(2) === "100.00" && rei.occurredAt.toISOString().slice(0, 10) === "2026-10-12" && rei.category === "Alimentação");
    const duc = await tx.purchase.findFirst({ where: { description: { contains: "Ducati" } }, include: { installments: { orderBy: { number: "asc" } } } });
    check("[N] Ducati 3×106,52 em 2026-11/2026-12/2027-01 (total 319,56)", duc.totalAmount.toFixed(2) === "319.56" && duc.installments.map((i) => `${i.amount.toFixed(2)}@${i.billMonth}`).join() === "106.52@2026-11,106.52@2026-12,106.52@2027-01");
    const tinyExp = await tx.expense.findFirst({ where: { cardId: w.card.id, description: { contains: "Tiny" } } });
    check("[N] Tiny 65,90 no cartão NÃO recorrente", tinyExp.amount.toFixed(2) === "65.90" && tinyExp.isRecurring === false);
    const sums = async (m) => (await tx.installment.aggregate({ where: { billMonth: m, purchase: { cardId: w.card.id } }, _sum: { amount: true } }))._sum.amount?.toFixed(2);
    check("[N] futuras: dez 200,36 · jan 200,36 · fev 60,60 = 461,32", (await sums("2026-12")) === "200.36" && (await sums("2027-01")) === "200.36" && (await sums("2027-02")) === "60.60");
    const bills = Object.fromEntries((await tx.cardBill.findMany({ where: { cardId: w.card.id } })).map((b) => [b.cycleMonth, b.totalAmount.toFixed(2)]));
    check("[N] faturas persistidas sincronizadas (nov 1.156,35 calculado · dez 200,36 · jan 200,36 · fev 60,60)", bills["2026-11"] === "1156.35" && bills["2026-12"] === "200.36" && bills["2027-01"] === "200.36" && bills["2027-02"] === "60.60", JSON.stringify(bills));
    const lim = await tx.cardLimitUpdate.findFirst({ where: { cardId: w.card.id }, orderBy: { occurredAt: "desc" } });
    check("[N] limite 13/10: total 5.087,00 · disponível 3.465,22 · usado 1.621,78 (histórico preservado: 4 snapshots)", lim.newTotalLimit.toFixed(2) === "5087.00" && lim.reportedAvailable.toFixed(2) === "3465.22" && lim.newUsedLimit.toFixed(2) === "1621.78" && (await tx.cardLimitUpdate.count()) === 4 && (await computeCardTotalLimit(w.card.id, { client: tx })).toFixed(2) === "5087.00" && (await computeCardUsedLimit(w.card.id, { client: tx })).toFixed(2) === "1621.78", (await computeCardUsedLimit(w.card.id, { client: tx })).toFixed(2));

    // Energia
    const en = await tx.bill.findFirst({ where: { description: "Energia", cycleMonth: "2026-10" }, include: { expense: true } });
    check("[H] Energia 2026-10 PAGA 359,96 pelo caminho do app (Bill + 1 despesa ligada)", en?.status === "paid" && en.amount.toFixed(2) === "359.96" && en.expense?.amount.toFixed(2) === "359.96" && (await tx.expense.count({ where: { description: "Energia" } })) === 1);

    // CNPJ + recebíveis
    const c = await tx.confirmedCommitment.findUnique({ where: { id: w.cnpj.id } });
    check("[R] CNPJ 1.335,00: CONFIRMED, sem funding, sem dueDate, NÃO liquidado", c.status === "CONFIRMED" && c.fundingAccountId === null && c.fundedAt === null && c.dueDate === null && c.amount.toFixed(2) === "1335.00" && c.settledAt === null && c.settledTransferId === null);
    const tiny = await tx.receivable.findFirst({ where: { notes: { startsWith: "FASE106-CATCHUP:tiny-65.90" } } });
    const bia = await tx.receivable.findFirst({ where: { notes: { startsWith: "FASE106-CATCHUP:bia-29" } }, include: { income: true } });
    check("[R] recebível Tiny 65,90 PENDING (sem Income; não netado com os 1.335)", tiny.status === "PENDING" && tiny.amount.toFixed(2) === "65.90" && tiny.incomeId === null && tiny.expectedDate === null);
    check("[R] Bia 29,00: Receivable RECEIVED + 1 Income 'Reembolso' de 12/10 no Itaú", bia.status === "RECEIVED" && bia.income.amount.toFixed(2) === "29.00" && /Reembolso/.test(bia.income.description) && bia.income.accountId === w.itau.id && bia.income.occurredAt.toISOString().slice(0, 10) === "2026-10-12");

    // repasses
    const caju = await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx });
    check("[Z] Repasses do Caju: 29,50 + 71,00 = 100,50 PENDENTES; saldo real 248,46; após repasses 147,96", caju.pendingTotal === 100.5 && caju.accountBalance === 248.46 && caju.availableAfterPending === 147.96 && caju.items.map((i) => i.amount).sort().join() === "29.5,71");
    const lazari = await tx.internalReimbursement.findFirst({ where: { amount: "29.50" } });
    check("[Z] repasse Lazari ligado ao gasto de 30/09; repasse Rei ligado à compra de 12/10; nenhum Transfer/Income gerado pelos repasses", lazari.sourceExpenseId !== null && (await tx.internalReimbursement.findFirst({ where: { amount: "71.00" } })).sourceExpenseId === rei.id && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 0);

    // dinheiro livre / protegido
    const accounts = await listAccountsWithBalances({ client: tx });
    const fm = await computeFreeMoney({ now: new Date("2026-10-13T20:00:00Z"), accounts, nextIncomeDate: new Date("2026-10-24T00:00:00Z"), client: tx });
    const num = (v) => Number(v?.toString?.() ?? v);
    check("[F] motor: dinheiro irrestrito = Itaú 12,28 + Dinheiro 181,00 = 193,28 (Caju e Cofrinho FORA)", num(fm.unrestrictedCash).toFixed(2) === "193.28", String(fm.unrestrictedCash));
    check("[F] protegido = 0: a reserva Tattoo vive no Cofrinho (fora do caixa) ⇒ não é subtraída de novo (sem dupla contagem)", num(fm.protectedMoney) === 0, String(fm.protectedMoney));
    check("[F] dívida incorrida de cartão inclui a compra de 12/10 (100,00) e o resultado é finito", num(fm.incurredLiabilities) >= 100 && Number.isFinite(num(fm.freeMoney)), `${fm.incurredLiabilities} / ${fm.freeMoney}`);
    console.log("   ↳ freeMoney:", JSON.stringify({ unrestrictedCash: String(fm.unrestrictedCash), protectedMoney: String(fm.protectedMoney), incurred: String(fm.incurredLiabilities), currentHorizon: String(fm.currentHorizonObligations), future: String(fm.futureObligations), free: String(fm.freeMoney) }));

    // sem duplicidades
    const dupExp = await tx.expense.groupBy({ by: ["accountId", "amount", "occurredAt", "description"], _count: { _all: true }, having: { id: { _count: { gt: 1 } } } });
    check("[D] nenhuma despesa duplicada (conta+valor+data+descrição)", dupExp.length === 0);

    // idempotência
    const plan2 = await buildCatchup106Plan({ client: tx });
    check("[N] 2º planner sobre o estado aplicado ⇒ 0 operações, sem bloqueios, checkpoints OK", plan2.operations.length === 0 && plan2.blockers.length === 0 && plan2.checkpoints.every((c2) => c2.ok), plan2.operations.map((o) => `${o.kind}:${o.description.slice(0, 60)}`).join(" | "));
    const sig1 = await touched(tx);
    const res2 = await executeCatchup106Plan({ client: tx, plan: plan2 });
    check("[N] 2ª execução ⇒ 0 mutações", res2.mutations.total === 0 && res2.applied === 0 && (await touched(tx)) === sig1);
    const sig2 = await touched(tx);
    let stale = null;
    try {
      await executeCatchup106Plan({ client: tx, plan });
    } catch (e) {
      stale = e;
    }
    check("[N] reexecutar o plano ANTIGO ⇒ CatchupAbort por preconditions, 0 escritas", stale instanceof CatchupAbort && (await touched(tx)) === sig2, String(stale?.message));
  });

  // resíduo muda ⇒ ABORTA
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup106Plan({ client: tx });
    await tx.expense.create({ data: { amount: "0.01", description: "lançamento surpresa", category: "Outros", accountId: w.itau.id, occurredAt: new Date("2026-10-12T00:00:00Z") } });
    let err = null;
    try {
      await executeCatchup106Plan({ client: tx, plan });
    } catch (e) {
      err = e;
    }
    check("[A] resíduo muda entre planejar e executar ⇒ ABORTA (nunca cria o ajuste)", err instanceof CatchupAbort && /ledger recalculado|resíduo|precondition|equivalente/.test(err.message), String(err?.message));
  });
  // pagamento já conciliado ⇒ plano com bloqueio/aborto
  await inWorld(async (tx, w) => {
    await tx.transfer.update({ where: { id: w.payment.id }, data: { amount: "1700.00" } });
    const blocked = await buildCatchup106Plan({ client: tx });
    check("[A] pagamento da fatura com valor inesperado ⇒ BLOQUEIO no planner", blocked.blockers.some((b) => /valor inesperado/.test(b)));
    let e1 = null;
    try {
      await executeCatchup106Plan({ client: tx, plan: blocked });
    } catch (e) {
      e1 = e;
    }
    check("[A] plano com bloqueio é recusado integralmente", e1 instanceof CatchupAbort && /bloqueios/.test(e1.message));
    let e2 = null;
    try {
      await executeCatchup106Plan({ client: tx, plan: { operations: [{ id: "x1", kind: "DROP_EVERYTHING", preconditions: {} }], blockers: [] } });
    } catch (e) {
      e2 = e;
    }
    check("[A] operação desconhecida é recusada", e2 instanceof CatchupAbort);
  });
  // compromisso CNPJ já liquidado ⇒ não mexe
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup106Plan({ client: tx });
    await tx.confirmedCommitment.update({ where: { id: w.cnpj.id }, data: { settledAt: new Date("2026-10-12T00:00:00Z") } });
    let err = null;
    try {
      await executeCatchup106Plan({ client: tx, plan });
    } catch (e) {
      err = e;
    }
    check("[A] compromisso CNPJ liquidado depois do plano ⇒ ABORTA", err instanceof CatchupAbort && /CNPJ/.test(err.message), String(err?.message));
  });
  // client raiz ⇒ 1 transação, rollback total
  const sigBefore = await dbSignature();
  let outer = null;
  try {
    await executeCatchup106Plan({ client: prisma, plan: { operations: [{ id: "x3", kind: "UPDATE_GOAL_SAVED", preconditions: { goalId: "inexistente", currentSaved: "0" }, to: { savedAmount: "1" } }], blockers: [] } });
  } catch (e) {
    outer = e;
  }
  check("[A] client raiz: falha ⇒ rollback total, DEV intacto", outer instanceof CatchupAbort && (await dbSignature()) === sigBefore);
  check("[W] isolamento: contagens do DEV idênticas antes × depois", before === (await dbSignature()));
}

try {
  await main();
} catch (e) {
  fail++;
  console.log("❌ erro inesperado:", e);
} finally {
  await prisma.$disconnect();
}
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail === 0 ? 0 : 1);
