// Fase 10.5 — PAGAMENTO INTEGRAL DA FATURA do cartão Itaú (lib/cardBillPayment.js + read-model + helper de UI).
// DEV apenas; cada cenário roda numa transação interativa que SEMPRE reverte (nada persiste; contagens do DEV provadas antes × depois).
// Estado de partida = o de PROD depois do catch-up da 10.4 (Itaú 2.490,38, fatura 2026-10 = 1.795,77 fechada e NÃO paga, vence 13/10).
//
//   node scripts/test-fase105-card-payment.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { computeAccountBalance, listAccountsWithBalances } from "../lib/accounts.js";
import { computeFreeMoney } from "../lib/freeMoney.js";
import { buildItauModel } from "../lib/cardsItau.js";
import { payCardBillInFull, undoCardBillPayment, reconcileBankLineWithCardBillPayment, findCardBillPaymentMatch, PAYMENT_KEY_PREFIX } from "../lib/cardBillPayment.js";
import { DomainError } from "../lib/domainErrors.js";
import { paymentPanelState, dmyLabel } from "../app/components/v5/cartoesView.js";
import { wipe, seedBefore, seedReconciled, Rollback } from "./lib/catchup104Fixture.js";

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
const d = (s) => new Date(s);
const NOW = d("2026-10-08T15:00:00Z"); // 12:00 em Brasília
const TABLES = ["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "confirmedCommitment", "contingency", "recurringRule", "card", "account", "telegramCorrectionAudit", "dataOperation"];
const dbSignature = async () => JSON.stringify(await Promise.all(TABLES.map((m) => prisma[m].count())));
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore(tx);
        await seedReconciled(tx, w); // estado pós-catch-up da 10.4
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 180000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
const counts = async (tx) => Object.fromEntries(await Promise.all(["expense", "income", "transfer", "purchase", "installment", "cardBillReconciliation", "cardLimitUpdate", "balanceAdjustment"].map(async (m) => [m, await tx[m].count()])));
const bal = async (tx, id) => (await computeAccountBalance(id, { client: tx })).toFixed(2);
const fm = async (tx) => computeFreeMoney({ now: NOW, accounts: await listAccountsWithBalances({ client: tx }), nextIncomeDate: d("2026-10-24T00:00:00Z"), client: tx });
const expectDomain = async (fn, code) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof DomainError && (!code || e.code === code) ? e : { unexpected: e };
  }
};

async function main() {
  const src = fs.readFileSync(new URL("../lib/cardBillPayment.js", import.meta.url), "utf8");
  check("[S] pagamento da fatura não cria Expense (nenhum expense.create no módulo)", !/expense\.(create|createMany|update)/.test(src));
  check("[S] sem migration: nenhum arquivo de migration novo nesta fase", !fs.readdirSync(new URL("../prisma/migrations/", import.meta.url)).some((m) => /^2026101\d/.test(m) || /fase105|card_?bill_?payment/i.test(m)));

  const before = await dbSignature();

  await inWorld(async (tx, w) => {
    const itauBefore = await bal(tx, w.itau.id);
    check("[0] partida: Itaú 2.490,38; CardBill 2026-10 fechada, NÃO paga, 1.795,77, vence 13/10", itauBefore === "2490.38" && (await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-10" } } })).status === "closed", itauBefore);
    const model0 = await buildItauModel({ now: NOW, client: tx });

    // ---- A. fatura UNPAID ⇒ botão aparece
    check("[A] fatura 2026-10 fechada e não paga ⇒ payment.canPay = true (valor 1.795,77, vence 13/10, conta Itaú, data de hoje)", model0.currentBill.cycleMonth === "2026-10" && model0.currentBill.payment.canPay === true && model0.currentBill.payment.amount === 1795.77 && model0.currentBill.payment.dueAt === "2026-10-13" && model0.currentBill.payment.fromAccount.name === "Itaú" && model0.currentBill.payment.defaultDate === "2026-10-08", JSON.stringify(model0.currentBill.payment));
    check("[A] helper de UI: modo CTA (botão 'Marcar fatura como paga')", paymentPanelState(model0).mode === "cta");
    const lateNight = await buildItauModel({ now: d("2026-10-09T01:30:00Z"), client: tx });
    check("[A] data padrão respeita America/Sao_Paulo (09/10 01:30Z = 08/10 22:30 local ⇒ 2026-10-08)", lateNight.currentBill.payment.defaultDate === "2026-10-08");

    const fmBefore = await fm(tx);
    const cBefore = await counts(tx);

    // ---- B/C/D/E. confirmar pagamento
    const r = await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    check("[B] confirmar ⇒ status PAID e CardBill paga com paidAmount 1.795,77", r.status === "PAID" && r.changed && r.bill.status === "paid" && r.bill.paidAmount === 1795.77, JSON.stringify(r.bill));
    const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-10" } } });
    const tr = await tx.transfer.findFirst({ where: { cardBillId: bill.id, kind: "card_bill_payment" } });
    check("[C] paidAt = data do pagamento (2026-10-08) na fatura e no pagamento", bill.paidAt.toISOString().slice(0, 10) === "2026-10-08" && tr.occurredAt.toISOString() === "2026-10-08T00:00:00.000Z");
    check("[D] saldo do Itaú cai EXATAMENTE o valor pago (2.490,38 → 694,61; Δ = −1.795,77)", (await bal(tx, w.itau.id)) === "694.61" && r.balanceAfter === 694.61, await bal(tx, w.itau.id));
    check("[D] pagamento = Transfer card_bill_payment conta → cartão, ligado à fatura, com chave de conciliação", tr.fromAccountId === w.itau.id && tr.toCardId === w.card.id && tr.cardBillId === bill.id && tr.amount.toFixed(2) === "1795.77" && tr.rawMessage.startsWith(PAYMENT_KEY_PREFIX) && tr.rawMessage.includes(`bill=${bill.id}`) && tr.rawMessage.includes("amount=1795.77") && tr.rawMessage.includes(`acct=${w.itau.id}`) && tr.rawMessage.includes("day=2026-10-08"));
    const cAfter = await counts(tx);
    check("[E] NENHUM Expense/Income criado; só +1 Transfer", cAfter.expense === cBefore.expense && cAfter.income === cBefore.income && cAfter.transfer === cBefore.transfer + 1);
    check("[E] compras, parcelas, reconciliação da fatura e limite intactos", cAfter.purchase === cBefore.purchase && cAfter.installment === cBefore.installment && cAfter.cardBillReconciliation === cBefore.cardBillReconciliation && cAfter.cardLimitUpdate === cBefore.cardLimitUpdate);

    // ---- F. free money: pagamento integral isolado é NEUTRO (nova regra canônica do cartão — Fase 10.5)
    const fmAfter = await fm(tx);
    const cashDelta = fmBefore.unrestrictedCash.minus(fmAfter.unrestrictedCash).toFixed(2);
    check("[F] caixa cai exatamente 1.795,77 (uma vez)", cashDelta === "1795.77", cashDelta);
    check("[F] passivo da fatura paga sai UMA vez: comprometido 1.795,77 → 0,00 (as parcelas de novembro são FUTURAS, não incorridas)", fmBefore.incurredLiabilities.toFixed(2) === "1795.77" && fmAfter.incurredLiabilities.toFixed(2) === "0.00", `${fmBefore.incurredLiabilities} → ${fmAfter.incurredLiabilities}`);
    check("[F] CARD_PAYMENT_DOUBLE_COUNT = NO: freeMoney inalterado pelo pagamento isolado (delta 0,00)", fmBefore.freeMoney.minus(fmAfter.freeMoney).toFixed(2) === "0.00", `${fmBefore.freeMoney} → ${fmAfter.freeMoney}`);
    const nov = fmAfter.futureObligationsItems.filter((i) => i.type === "CardBill");
    check("[F] os R$ 571,79 seguem como obrigação FUTURA do cartão (visível, não comprometida agora)", nov.some((i) => i.cycleMonth === "2026-11" && i.amount.toFixed(2) === "571.79" && i.component === "future_installments_projected"), JSON.stringify(nov.map((i) => [i.cycleMonth, i.amount.toFixed(2)])));

    // ---- J. fatura paga ⇒ CTA não aparece; estado '✓ Fatura paga'
    const modelPaid = await buildItauModel({ now: NOW, client: tx });
    check("[J] fatura paga ⇒ nenhum CTA de pagamento (a fatura atual passa a ser a seguinte, em andamento)", modelPaid.currentBill.cycleMonth === "2026-11" && modelPaid.currentBill.payment.canPay === false && paymentPanelState(modelPaid).mode !== "cta");
    check("[J] estado pago: ✓ Fatura de outubro paga · 08/10/2026 · R$ 1.795,77 · Itaú, com 'Desfazer pagamento' disponível", (() => { const s = paymentPanelState(modelPaid); return s.mode === "paid" && s.paidBill.monthLong === "outubro" && s.paidBill.paidAt === "2026-10-08" && s.paidBill.amount === 1795.77 && s.paidBill.accountName === "Itaú" && s.paidBill.undoable === true && dmyLabel(s.paidBill.paidAt) === "08/10/2026"; })());

    // ---- G. idempotência
    const sigPaid = JSON.stringify([await counts(tx), await bal(tx, w.itau.id)]);
    const again = await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    check("[G] confirmar de novo ⇒ ALREADY_PAID, sem nova alteração financeira", again.status === "ALREADY_PAID" && again.changed === false && JSON.stringify([await counts(tx), await bal(tx, w.itau.id)]) === sigPaid);
    const againById = await payCardBillInFull({ cardBillId: bill.id, now: NOW, client: tx });
    check("[G] idem pelo id da fatura", againById.status === "ALREADY_PAID" && (await counts(tx)).transfer === cBefore.transfer + 1);

    // ---- H. desfazer
    const u = await undoCardBillPayment({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    const billU = await tx.cardBill.findUnique({ where: { id: bill.id } });
    check("[H] desfazer ⇒ UNDONE; fatura volta a 'closed' (não paga), sem paidAt, paidAmount 0", u.status === "UNDONE" && billU.status === "closed" && billU.paidAt === null && billU.paidAmount.toFixed(2) === "0.00");
    check("[H] saldo revertido (2.490,38) e o Transfer do pagamento removido", (await bal(tx, w.itau.id)) === itauBefore && (await counts(tx)).transfer === cBefore.transfer);
    const cU = await counts(tx);
    check("[H] ZERO compra apagada: despesas, parcelas, compras, reconciliação e limite idênticos", JSON.stringify(cU) === JSON.stringify(cBefore));
    check("[H] auditoria registrada (pagar + desfazer)", (await tx.telegramCorrectionAudit.count({ where: { model: "cardBill", recordId: bill.id, action: { in: ["pay_card_bill", "undo_pay_card_bill"] } } })) === 2);
    check("[H] a fatura reaparece como pagável depois de desfazer", (await buildItauModel({ now: NOW, client: tx })).currentBill.payment.canPay === true);
    const notPaid = await expectDomain(() => undoCardBillPayment({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx }), "NOT_PAID");
    check("[H] desfazer sem pagamento ⇒ NOT_PAID", notPaid && !notPaid.unexpected);

    // ---- I. linha bancária futura ⇒ concilia, não duplica
    await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    const cPaid = await counts(tx);
    const balPaid = await bal(tx, w.itau.id);
    const miss = await reconcileBankLineWithCardBillPayment({ accountId: w.itau.id, amount: "1795.00", date: "2026-10-09", reference: "OUTRA LINHA", client: tx });
    check("[I] linha com valor diferente NÃO concilia (e não cria nada)", miss.matched === false && (await counts(tx)).transfer === cPaid.transfer);
    check("[I] localizador: linha 1.795,77 em 09/10 corresponde ao pagamento registrado em 08/10", (await findCardBillPaymentMatch({ accountId: w.itau.id, amount: "1795.77", date: "2026-10-09", client: tx })).length === 1);
    const rec = await reconcileBankLineWithCardBillPayment({ accountId: w.itau.id, amount: "1795.77", date: "2026-10-09", reference: "PAGTO FATURA ITAU 09/10", client: tx });
    check("[I] linha do extrato ⇒ concilia o pagamento existente: 0 Transfer/Expense novos, saldo e fatura inalterados", rec.matched && rec.alreadyReconciled === false && rec.created === 0 && JSON.stringify(await counts(tx)) === JSON.stringify(cPaid) && (await bal(tx, w.itau.id)) === balPaid);
    const trR = await tx.transfer.findFirst({ where: { cardBillId: bill.id, kind: "card_bill_payment" } });
    check("[I] a referência bancária fica ligada ao pagamento", trR.rawMessage.includes("|bank=PAGTO FATURA ITAU 09/10|bankDay=2026-10-09"));
    const rec2 = await reconcileBankLineWithCardBillPayment({ accountId: w.itau.id, amount: "1795.77", date: "2026-10-09", reference: "PAGTO FATURA ITAU 09/10", client: tx });
    check("[I] importar a MESMA linha de novo ⇒ já conciliada, sem duplicar", rec2.matched && rec2.alreadyReconciled === true && JSON.stringify(await counts(tx)) === JSON.stringify(cPaid));
    const modelRec = paymentPanelState(await buildItauModel({ now: NOW, client: tx }));
    check("[I] depois de conciliado: aparece 'conferido com o extrato' e o desfazer deixa de ser oferecido", modelRec.mode === "paid" && modelRec.paidBill.reconciledWithBank === true && modelRec.paidBill.undoable === false);
    const blocked = await expectDomain(() => undoCardBillPayment({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx }), "BLOCKED_RECONCILED_PAYMENT");
    check("[I] pagamento conciliado com o extrato não pode ser desfeito por aqui", blocked && !blocked.unexpected && (await counts(tx)).transfer === cPaid.transfer);

    // ---- K. fatura posterior paga normalmente, sem conflito com a anterior
    const NOV = d("2026-11-10T15:00:00Z");
    const modelNov = await buildItauModel({ now: NOV, client: tx });
    check("[K] 10/11: a fatura 2026-11 (fechada em 04/11) é a atual e pagável; a de outubro continua paga", modelNov.currentBill.cycleMonth === "2026-11" && modelNov.currentBill.payment.canPay === true && modelNov.currentBill.payment.amount === 571.79 && paymentPanelState(modelNov).mode === "cta");
    const rNov = await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-11", paidAt: "2026-11-10", now: NOV, client: tx });
    const octAfter = await tx.cardBill.findUnique({ where: { id: bill.id } });
    check("[K] pagar a fatura seguinte ⇒ PAID (571,79) sem tocar a anterior (continua paga, 1 pagamento)", rNov.status === "PAID" && rNov.payment.amount === 571.79 && octAfter.status === "paid" && octAfter.paidAmount.toFixed(2) === "1795.77" && (await tx.transfer.count({ where: { kind: "card_bill_payment", cardBillId: bill.id } })) === 1 && (await tx.transfer.count({ where: { kind: "card_bill_payment" } })) === 2);
    check("[K] saldo: Itaú cai 1.795,77 + 571,79 desde a âncora (2.490,38 → 122,82)", (await bal(tx, w.itau.id)) === "122.82", await bal(tx, w.itau.id));
  });

  // ------------------------------------------------------------------ bordas / validações
  await inWorld(async (tx, w) => {
    const vaErr = await expectDomain(() => payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", fromAccountId: w.caju.id, now: NOW, client: tx }), "INVALID");
    check("[V] não paga fatura com o vale-alimentação (Caju)", vaErr && !vaErr.unexpected);
    const futErr = await expectDomain(() => payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", paidAt: "2026-10-20", now: NOW, client: tx }), "INVALID");
    check("[V] data futura recusada", futErr && !futErr.unexpected);
    const badErr = await expectDomain(() => payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", paidAt: "08/10/2026", now: NOW, client: tx }), "INVALID");
    check("[V] data em formato inválido recusada", badErr && !badErr.unexpected);
    const openErr = await expectDomain(() => payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-11", now: NOW, client: tx }), "INVALID");
    check("[V] fatura que ainda não fechou não pode ser quitada", openErr && !openErr.unexpected);
    check("[V] nenhuma recusa deixou efeito (0 Transfer de pagamento, fatura intacta)", (await tx.transfer.count({ where: { kind: "card_bill_payment" } })) === 0 && (await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-10" } } })).status === "closed");
    const early = await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", paidAt: "2026-10-05", now: NOW, client: tx });
    check("[V] pagamento em dia anterior ao último saldo conferido: registrado, com aviso (o saldo já o incluía)", early.status === "PAID" && early.warnings.includes("PAYMENT_BEFORE_LAST_BALANCE_CHECK") && (await bal(tx, w.itau.id)) === "2490.38");
  });
  // pagamento por Telegram (legado) não é desfeito por este fluxo
  await inWorld(async (tx, w) => {
    const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-10" } } });
    await tx.transfer.create({ data: { amount: "1795.77", description: "Pagamento fatura (Telegram)", fromAccountId: w.itau.id, toCardId: w.card.id, cardBillId: bill.id, kind: "card_bill_payment", source: "telegram", occurredAt: d("2026-10-08T00:00:00Z") } });
    await tx.cardBill.update({ where: { id: bill.id }, data: { status: "paid", paidAmount: "1795.77", paidAt: d("2026-10-08T00:00:00Z") } });
    const e = await expectDomain(() => undoCardBillPayment({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx }), "INVALID");
    const again = await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    check("[V] pagamento feito por outro caminho (Telegram) não é desfeito aqui, e pagar de novo ⇒ ALREADY_PAID", e && !e.unexpected && again.status === "ALREADY_PAID" && (await tx.transfer.count({ where: { kind: "card_bill_payment" } })) === 1);
  });

  check("[W] isolamento: contagens do DEV idênticas antes × depois (rollback em todos os cenários)", before === (await dbSignature()));
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
