// Fase 9.1 — DOMÍNIO: progresso real de parcelamento, pagar/desfazer parcela (atômico), contas da
// casa (aluguel, variável, faxina 1/2 e 2/2, recorrência), liquidação de compromisso (Expense e
// devolução por Transfer), linha do tempo de alívio, e GET 100% read-only (contagens de linhas
// idênticas antes/depois de ler os read-models). Fixtures sintéticas com MARK; deltas globais.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney, serializeMoney } from "../lib/money.js";
import { createExternalInstallmentPlan, computePlanProgress } from "../lib/externalInstallments.js";
import { payExternalInstallment, undoExternalInstallmentPayment } from "../lib/installmentPayments.js";
import { listHouseBillInstances, payHouseBill, undoHouseBillPayment } from "../lib/houseBills.js";
import { settleCommitment, undoCommitmentSettlement } from "../lib/commitmentSettlement.js";
import { computeReliefTimeline } from "../lib/relief.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { buildCommitmentsModel } from "../lib/compromissosModel.js";
import { buildHomeModel } from "../lib/homeModel.js";
import { resolvePaymentDate, currentMonthKey, monthBounds } from "../lib/paymentDates.js";
import { performPay, performUndo } from "../lib/compromissosActions.js";
import { DomainError } from "../lib/domainErrors.js";

const MARK = "TESTE_F91";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (a, b) => compareMoney(money(a), money(b)) === 0;
const num = (x) => Number(serializeMoney(x));
async function code(fn) { try { await fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${e.message.split("\n").pop().slice(0, 80)}`; } }

const NOW = new Date("2026-09-25T15:00:00.000Z"); // controlado: 25/09/2026 12:00 (-03)
const MONTH = currentMonthKey(NOW); // 2026-09
const created = { accounts: [], plans: [], rules: [], commitments: [] };

async function counts() {
  const [bills, rules, expenses, transfers, installments, commitments, audits] = await Promise.all([prisma.bill.count(), prisma.recurringRule.count(), prisma.expense.count(), prisma.transfer.count(), prisma.externalInstallment.count(), prisma.confirmedCommitment.count(), prisma.telegramCorrectionAudit.count()]);
  return JSON.stringify({ bills, rules, expenses, transfers, installments, commitments, audits });
}

async function mkAccount(slug, type, balance) {
  const a = await prisma.account.create({ data: { slug: `teste-f91-${slug}`, name: `${MARK} ${slug}`, type } });
  created.accounts.push(a.id);
  await prisma.balanceAdjustment.create({ data: { accountId: a.id, newBalance: balance, note: MARK, source: "manual", occurredAt: new Date("2026-01-01T00:00:00Z") } });
  return a;
}
async function mkRule(data) {
  const r = await prisma.recurringRule.create({ data: { kind: "expense", isActive: true, category: "Moradia", ...data, name: `${MARK} ${data.name}` } });
  created.rules.push(r.id);
  return r;
}

async function cleanup() {
  const planIds = created.plans;
  const insts = await prisma.externalInstallment.findMany({ where: { planId: { in: planIds } }, select: { id: true } });
  const bills = await prisma.bill.findMany({ where: { recurringRuleId: { in: created.rules } }, select: { id: true } });
  await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: { in: [...insts.map((i) => i.id), ...bills.map((b) => b.id), ...created.commitments] } } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { model: { in: ["bill", "externalInstallment", "confirmedCommitment"] }, rawMessage: "web", createdAt: { gte: START } } }).catch(() => {});
  for (const c of created.commitments) await prisma.confirmedCommitment.update({ where: { id: c }, data: { expenseId: null, settledTransferId: null } }).catch(() => {});
  await prisma.externalInstallment.updateMany({ where: { planId: { in: planIds } }, data: { expenseId: null } });
  await prisma.expense.deleteMany({ where: { OR: [{ description: { contains: MARK } }, { accountId: { in: created.accounts } }] } }).catch(() => {});
  await prisma.transfer.deleteMany({ where: { OR: [{ fromAccountId: { in: created.accounts } }, { toAccountId: { in: created.accounts } }] } }).catch(() => {});
  await prisma.bill.deleteMany({ where: { recurringRuleId: { in: created.rules } } }).catch(() => {});
  await prisma.recurringRule.deleteMany({ where: { id: { in: created.rules } } }).catch(() => {});
  await prisma.confirmedCommitment.deleteMany({ where: { id: { in: created.commitments } } }).catch(() => {});
  await prisma.externalInstallment.deleteMany({ where: { planId: { in: planIds } } }).catch(() => {});
  await prisma.externalInstallmentPlan.deleteMany({ where: { id: { in: planIds } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: created.accounts } } }).catch(() => {});
  const left = await Promise.all([prisma.account.count({ where: { slug: { contains: "teste-f91" } } }), prisma.recurringRule.count({ where: { name: { contains: MARK } } }), prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } }), prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((n) => n === 0), JSON.stringify(left));
}
const START = new Date();

async function main() {
  const itau = await mkAccount("itau", "checking", 5000);
  const dinheiro = await mkAccount("dinheiro", "cash", 500);
  const va = await mkAccount("va", "food_voucher", 500);

  // ============ [A] progresso real (histórico anterior ao Norte)
  const plan = await createExternalInstallmentPlan({ description: `${MARK} Impressora`, creditor: "Mãe", installmentValue: 297.9, installmentCount: 10, alreadyPaidCount: 6, dueTiming: "AFTER_NEXT_INCOME" });
  created.plans.push(plan.id);
  const prog = computePlanProgress(plan.installments, { installmentCount: 10 });
  check("[A] impressora 3D: 6/10 pagas, próxima #7, 4 pendentes (nunca 0/4)", prog.paidCount === 6 && prog.totalCount === 10 && prog.nextNumber === 7 && prog.pendingCount === 4 && prog.historicalPaidCount === 6, JSON.stringify(prog));
  check("[A] sem installmentCount o comportamento anterior é inalterado", computePlanProgress(plan.installments).totalCount === 4);

  // ============ [B] pagar parcela — Itaú (cria Expense + PAID + vínculo + auditoria, atômico)
  const first = plan.installments.find((i) => i.number === 7);
  const before = await computeAccountBalance(itau.id);
  const r1 = await payExternalInstallment(first.id, { accountId: itau.id, when: "hoje", now: NOW });
  check("[B] parcela #7 vira PAID com paidAt (25/09) e expenseId vinculado", r1.installment.status === "PAID" && r1.installment.paidAt.toISOString().slice(0, 10) === "2026-09-25" && r1.installment.expenseId === r1.expense.id);
  check("[B] Expense: valor da parcela, conta Itaú, descrição 'parcela 7/10', data econômica", eq(r1.expense.amount, 297.9) && r1.expense.accountId === itau.id && /parcela 7\/10/.test(r1.expense.description) && r1.expense.occurredAt.toISOString().slice(0, 10) === "2026-09-25");
  check("[B] saldo da conta caiu exatamente o valor da parcela (sem 2º lançamento manual)", eq(await computeAccountBalance(itau.id), num(before) - 297.9));
  const audit1 = await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: first.id, action: "pay_installment" } });
  check("[B] auditoria append-only gravada (preimage + campos)", !!audit1 && audit1.model === "externalInstallment" && audit1.preimage.status === "PENDING");
  const progAfter = computePlanProgress((await prisma.externalInstallment.findMany({ where: { planId: plan.id } })), { installmentCount: 10 });
  check("[B] progresso após pagar: 7/10, próxima #8", progAfter.paidCount === 7 && progAfter.nextNumber === 8 && progAfter.pendingCount === 3);

  // ============ [C] duplicado, ordem, saldo, VA, atomicidade
  const cntBefore = await counts();
  check("[C] pagamento duplicado → ALREADY_PAID e ZERO escrita", (await code(() => payExternalInstallment(first.id, { accountId: itau.id, now: NOW }))) === "ALREADY_PAID" && (await counts()) === cntBefore);
  const inst9 = (await prisma.externalInstallment.findMany({ where: { planId: plan.id }, orderBy: { number: "asc" } }));
  check("[C] pagar #9 antes da #8 → OUT_OF_ORDER e ZERO escrita", (await code(() => payExternalInstallment(inst9.find((i) => i.number === 9).id, { accountId: itau.id, now: NOW }))) === "OUT_OF_ORDER" && (await counts()) === cntBefore);
  const c8 = inst9.find((i) => i.number === 8);
  check("[C] VA (restrito) recusado como origem → INVALID, ZERO escrita", (await code(() => payExternalInstallment(c8.id, { accountId: va.id, now: NOW }))) === "INVALID" && (await counts()) === cntBefore);
  const poor = await mkAccount("poor", "checking", 10);
  check("[C] saldo insuficiente → INSUFFICIENT_FUNDS, ZERO escrita", (await code(() => payExternalInstallment(c8.id, { accountId: poor.id, now: NOW }))) === "INSUFFICIENT_FUNDS" && (await counts()) === cntBefore);
  check("[C] sem conta → INVALID", (await code(() => payExternalInstallment(c8.id, { now: NOW }))) === "INVALID");
  check("[C] data futura recusada", (await code(() => payExternalInstallment(c8.id, { accountId: itau.id, when: "2099-01-01", now: NOW }))) === "INVALID");
  const bad = await code(() => payExternalInstallment(c8.id, { accountId: itau.id, paidAt: "data-invalida", now: NOW }));
  const c8After = await prisma.externalInstallment.findUnique({ where: { id: c8.id } });
  check("[C] ATOMICIDADE: falha no meio (data inválida) → Expense NÃO fica, parcela continua PENDING", bad !== null && c8After.status === "PENDING" && !c8After.expenseId && (await counts()) === cntBefore, String(bad));

  // ============ [D] pagar parcela — Dinheiro, data ontem, e "já paguei antes" (sem despesa)
  const r8 = await payExternalInstallment(c8.id, { accountId: dinheiro.id, when: "ontem", now: NOW });
  check("[D] parcela #8 paga em Dinheiro, data ontem (24/09), saldo do Dinheiro cai o valor", r8.expense.accountId === dinheiro.id && r8.installment.paidAt.toISOString().slice(0, 10) === "2026-09-24" && eq(await computeAccountBalance(dinheiro.id), 202.1), String(num(await computeAccountBalance(dinheiro.id))) + " paidAt=" + r8.installment.paidAt.toISOString() + " acc=" + (r8.expense.accountId === dinheiro.id));
  const c9 = (await prisma.externalInstallment.findMany({ where: { planId: plan.id }, orderBy: { number: "asc" } })).find((i) => i.number === 9);
  const expBefore = await prisma.expense.count();
  const rNoExp = await payExternalInstallment(c9.id, { recordExpense: false, now: NOW });
  check("[D] 'já paguei antes': PAID sem Expense e sem escolher conta", rNoExp.installment.status === "PAID" && !rNoExp.installment.expenseId && (await prisma.expense.count()) === expBefore);

  // ============ [E] desfazer
  const undo9 = await undoExternalInstallmentPayment(c9.id, { expectedUpdatedAt: rNoExp.installment.updatedAt.toISOString() });
  check("[E] desfazer (sem despesa): volta PENDING, paidAt null", undo9.installment.status === "PENDING" && undo9.installment.paidAt === null);
  check("[E] desfazer duas vezes → NOT_PAID (idempotência explícita)", (await code(() => undoExternalInstallmentPayment(c9.id))) === "NOT_PAID");
  const balBeforeUndo = await computeAccountBalance(itau.id);
  const undo7 = await undoExternalInstallmentPayment(first.id, { expectedUpdatedAt: r1.installment.updatedAt.toISOString() });
  const afterUndo7 = await prisma.externalInstallment.findUnique({ where: { id: first.id } });
  check("[E] desfazer #7: PENDING, paidAt/expenseId limpos, Expense REMOVIDA", afterUndo7.status === "PENDING" && !afterUndo7.paidAt && !afterUndo7.expenseId && (await prisma.expense.findUnique({ where: { id: r1.expense.id } })) === null);
  check("[E] saldo do Itaú volta ao valor original", eq(await computeAccountBalance(itau.id), num(balBeforeUndo) + 297.9));
  check("[E] auditoria do desfazer com o preimage da despesa removida", !!(await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: first.id, action: "undo_pay_installment" } }))?.fieldChanges?.removedExpense);
  const r7b = await payExternalInstallment(first.id, { accountId: itau.id, now: NOW });
  check("[E] STALE: desfazer com updatedAt antigo → STALE e nada muda", (await code(() => undoExternalInstallmentPayment(first.id, { expectedUpdatedAt: r1.installment.updatedAt.toISOString() }))) === "STALE" && (await prisma.externalInstallment.findUnique({ where: { id: first.id } })).status === "PAID");
  await undoExternalInstallmentPayment(first.id, { expectedUpdatedAt: r7b.installment.updatedAt.toISOString() });
  await undoExternalInstallmentPayment(c8.id);

  // ============ [F] contas da casa
  const aluguel = await mkRule({ name: "Aluguel", amount: 1000, dayOfMonth: 5, accountId: itau.id });
  const energia = await mkRule({ name: "Energia", amount: null, amountKind: "VARIABLE", dayOfMonth: null, referenceMin: 400, referenceMax: 450 });
  const internet = await mkRule({ name: "Internet", amount: 114.9, dayOfMonth: null });
  const telefone = await mkRule({ name: "Telefone", amount: 60, amountKind: "APPROXIMATE", dayOfMonth: null, category: "Outros" });
  const faxina = await mkRule({ name: "Faxina", amount: 260, partsPerCycle: 2, cadence: "BIWEEKLY" });
  const billsBefore = await prisma.bill.count();
  const inst = await listHouseBillInstances({ cycleMonth: MONTH, now: NOW });
  const mine = inst.filter((i) => i.name.startsWith(MARK));
  check("[F] GET/lista NÃO grava nada (Bill count idêntico) — projetadas em memória", (await prisma.bill.count()) === billsBefore && mine.every((i) => i.billId === null));
  check("[F] 6 instâncias (aluguel, energia, internet, telefone, faxina x2 partes)", mine.length === 6);
  const iAlu = mine.find((i) => i.name.endsWith("Aluguel"));
  check("[F] aluguel: 1000, vence dia 5 (2026-09-05), ATRASADA em 25/09 se não paga", eq(iAlu.partAmount, 1000) && iAlu.dueDate.toISOString().slice(0, 10) === "2026-09-05" && iAlu.overdue === true);
  const iEn = mine.find((i) => i.name.endsWith("Energia"));
  check("[F] energia: valor variável → aguardando valor, vencimento desconhecido (null), faixa 400–450", iEn.partAmount === null && iEn.awaitingValue && iEn.dueDate === null && num(iEn.referenceMin) === 400 && num(iEn.referenceMax) === 450);
  check("[F] internet: vencimento desconhecido nunca é inventado", mine.find((i) => i.name.endsWith("Internet")).dueDate === null && mine.find((i) => i.name.endsWith("Internet")).overdue === false);
  check("[F] faxina: 2 partes de R$130 (260/2)", mine.filter((i) => i.name === `${MARK} Faxina`).length === 2 && mine.filter((i) => i.name === `${MARK} Faxina`).every((i) => eq(i.partAmount, 130)));

  const expCount0 = await prisma.expense.count();
  check("[F] energia: pagar SEM informar valor → INVALID, zero escrita", (await code(() => payHouseBill({ ruleId: energia.id, cycleMonth: MONTH, accountId: itau.id, now: NOW }))) === "INVALID" && (await prisma.expense.count()) === expCount0 && (await prisma.bill.count()) === billsBefore);
  const balItau0 = await computeAccountBalance(itau.id);
  const pAlu = await payHouseBill({ ruleId: aluguel.id, cycleMonth: MONTH, accountId: itau.id, when: "hoje", now: NOW });
  check("[F] pagar aluguel: Bill paga + Expense 1000 vinculada (billId) na conta escolhida", pAlu.bill.status === "paid" && eq(pAlu.expense.amount, 1000) && pAlu.expense.billId === pAlu.bill.id && pAlu.expense.accountId === itau.id && eq(await computeAccountBalance(itau.id), num(balItau0) - 1000));
  check("[F] aluguel pago duas vezes → ALREADY_PAID", (await code(() => payHouseBill({ ruleId: aluguel.id, cycleMonth: MONTH, accountId: itau.id, now: NOW }))) === "ALREADY_PAID");
  const pEn = await payHouseBill({ ruleId: energia.id, cycleMonth: MONTH, accountId: itau.id, amount: 431.5, now: NOW });
  check("[F] energia com valor informado (431,50): só agora cria Expense; NÃO usa 482,43 fixo", eq(pEn.expense.amount, 431.5) && eq(pEn.bill.amount, 431.5));
  const pTel = await payHouseBill({ ruleId: telefone.id, cycleMonth: MONTH, accountId: itau.id, amount: 63.2, now: NOW });
  check("[F] telefone aproximado: aceita ajustar o valor real ao pagar (63,20)", eq(pTel.expense.amount, 63.2));
  const pInt = await payHouseBill({ ruleId: internet.id, cycleMonth: MONTH, accountId: itau.id, amount: 999, now: NOW });
  check("[F] fixo (internet 114,90) ignora valor divergente informado", eq(pInt.expense.amount, 114.9));

  // faxina 1/2 e 2/2
  const f1 = await payHouseBill({ ruleId: faxina.id, cycleMonth: MONTH, part: 1, accountId: itau.id, now: NOW });
  check("[F] faxina visita 1: Expense R$130 e a conta continua parcialmente pendente", eq(f1.expense.amount, 130));
  const instMid = (await listHouseBillInstances({ cycleMonth: MONTH, now: NOW })).filter((i) => i.name === `${MARK} Faxina`);
  check("[F] faxina 1 de 2: parte 1 PAID, parte 2 PENDING", instMid.find((i) => i.part === 1).status === "PAID" && instMid.find((i) => i.part === 2).status === "PENDING");
  let model = await buildCommitmentsModel({ now: NOW });
  const mFax = model.items.find((i) => i.name === `${MARK} Faxina`);
  check("[F] modelo: faxina pendente com partsPaid=1/2, restante R$130, próxima parte 2", mFax.state === "pending" && mFax.casa.partsPaid === 1 && mFax.casa.partsTotal === 2 && mFax.casa.remainingAmount === 130 && mFax.pay.part === 2);
  const f2 = await payHouseBill({ ruleId: faxina.id, cycleMonth: MONTH, part: 2, accountId: dinheiro.id, now: NOW });
  check("[F] faxina 2 de 2: competência concluída", (await listHouseBillInstances({ cycleMonth: MONTH, now: NOW })).filter((i) => i.name === `${MARK} Faxina`).every((i) => i.status === "PAID"));
  model = await buildCommitmentsModel({ now: NOW });
  check("[F] modelo: faxina 'done' (2 de 2 visitas pagas), total pago R$260", model.items.find((i) => i.name === `${MARK} Faxina`).state === "done" && model.items.find((i) => i.name === `${MARK} Faxina`).done.value === 260);
  // desfazer a 2ª visita → volta a 1/2 e a Bill some (projetada)
  await undoHouseBillPayment(f2.bill.id, { expectedUpdatedAt: f2.bill.updatedAt.toISOString() });
  check("[F] desfazer visita 2: Bill removida (projetada de novo) e Expense removida", (await prisma.bill.findUnique({ where: { id: f2.bill.id } })) === null && (await prisma.expense.findUnique({ where: { id: f2.expense.id } })) === null);
  check("[F] desfazer conta já desfeita → NOT_FOUND", (await code(() => undoHouseBillPayment(f2.bill.id))) === "NOT_FOUND");
  const iNoExp = await payHouseBill({ ruleId: faxina.id, cycleMonth: MONTH, part: 2, recordExpense: false, now: NOW });
  check("[F] 'já paguei antes' na casa: Bill paga SEM Expense", iNoExp.expense === null && iNoExp.bill.status === "paid");
  await undoHouseBillPayment(iNoExp.bill.id);

  // recorrência: outra competência é independente
  const nextMonth = "2026-10";
  const instNext = (await listHouseBillInstances({ cycleMonth: nextMonth, now: NOW })).filter((i) => i.name.startsWith(MARK));
  check("[F] recorrência: outubro nasce projetado e PENDENTE (o pagamento de setembro não vaza)", instNext.length === 6 && instNext.every((i) => i.status === "PENDING" && i.billId === null) && instNext.find((i) => i.name.endsWith("Aluguel")).dueDate.toISOString().slice(0, 10) === "2026-10-05");
  check("[F] competência inválida → INVALID", (await code(() => listHouseBillInstances({ cycleMonth: "2026-13", now: NOW }))) === "INVALID");

  // ============ [G] compromissos: devolução por Transfer (não é despesa) e Expense
  const cnpj = await prisma.confirmedCommitment.create({ data: { description: `${MARK} Devolver ao CNPJ`, amount: 500, dueDate: null, status: "FUNDED", fundedAt: NOW, fundingAccountId: itau.id, settlementMode: "EXTERNAL_TRANSFER", shortLabel: "CNPJ" } });
  created.commitments.push(cnpj.id);
  const expC0 = await prisma.expense.count();
  const balC0 = await computeAccountBalance(itau.id);
  const sRet = await settleCommitment(cnpj.id, { accountId: itau.id, when: "hoje", now: NOW });
  check("[G] devolução: Transfer (Itaú → fora), status SETTLED, ZERO Expense criada", sRet.transfer.fromAccountId === itau.id && sRet.transfer.toAccountId === null && sRet.commitment.status === "SETTLED" && sRet.commitment.settledTransferId === sRet.transfer.id && (await prisma.expense.count()) === expC0);
  check("[G] saldo cai o valor devolvido", eq(await computeAccountBalance(itau.id), num(balC0) - 500));
  check("[G] devolver de novo → ALREADY_PAID", (await code(() => settleCommitment(cnpj.id, { accountId: itau.id, now: NOW }))) === "ALREADY_PAID");
  await undoCommitmentSettlement(cnpj.id, { expectedUpdatedAt: sRet.commitment.updatedAt.toISOString() });
  const cAfter = await prisma.confirmedCommitment.findUnique({ where: { id: cnpj.id } });
  check("[G] desfazer: volta FUNDED (earmark preservado), Transfer removida, saldo restaurado", cAfter.status === "FUNDED" && !cAfter.settledTransferId && eq(await computeAccountBalance(itau.id), num(balC0)));
  const plain = await prisma.confirmedCommitment.create({ data: { description: `${MARK} Compromisso comum`, amount: 40, dueDate: null, status: "CONFIRMED" } });
  created.commitments.push(plain.id);
  const sExp = await settleCommitment(plain.id, { accountId: itau.id, now: NOW });
  check("[G] compromisso comum (EXPENSE): cria Expense vinculada e liquida", !!sExp.expense && sExp.commitment.expenseId === sExp.expense.id);
  await undoCommitmentSettlement(plain.id);
  check("[G] desfazer compromisso comum: CONFIRMED e Expense removida", (await prisma.confirmedCommitment.findUnique({ where: { id: plain.id } })).status === "CONFIRMED" && (await prisma.expense.findUnique({ where: { id: sExp.expense.id } })) === null);

  // ============ [H] linha do tempo de alívio (pura, mês controlado)
  const { start, end } = monthBounds("2026-09");
  const mk = (id, name, value, count, pendingFrom) => ({ id, description: name, installmentValue: value, installmentCount: count, installments: Array.from({ length: count - pendingFrom + 1 }, (_, i) => ({ number: pendingFrom + i, status: "PENDING", paidAt: null })) });
  const tl = computeReliefTimeline([mk("a", "Curto", 200, 2, 2), mk("b", "Médio", 100, 5, 2), mk("c", "Longo", 50, 12, 3)], { monthKey: "2026-09", monthStart: start, monthEnd: end });
  check("[H] hoje por mês = soma das parcelas ativas (350)", tl.todayMonthly === 350);
  check("[H] 1º marco em OUT/26: libera R$200/mês (Curto termina), depois 350→150", tl.milestones[0].monthKey === "2026-10" && tl.milestones[0].label === "OUT/26" && tl.milestones[0].released === 200 && tl.milestones[0].plans[0].name === "Curto" && tl.milestones[0].after === 150);
  check("[H] meses reais consecutivos com rótulos SET/OUT/NOV (nenhum hardcode)", tl.months.slice(0, 3).map((m) => m.labelShort).join(",") === "SET/26,OUT/26,NOV/26" && tl.months[0].label === "AGORA");
  check("[H] zera no mês certo (Longo: 10 parcelas restantes → JUL/27)", tl.zeroMonth.monthKey === "2027-07" && tl.zeroMonth.longLabel === "julho de 2027");
  const shifted = computeReliefTimeline([mk("a", "Curto", 200, 2, 2)], { monthKey: "2027-01", monthStart: monthBounds("2027-01").start, monthEnd: monthBounds("2027-01").end });
  check("[H] muda o mês-base → muda tudo (2027-01 → FEV/27)", shifted.milestones[0].label === "FEV/27");
  const paidThis = [{ id: "p", description: "Pago no mês", installmentValue: 100, installmentCount: 3, installments: [{ number: 2, status: "PAID", paidAt: new Date("2026-09-10T00:00:00Z") }, { number: 3, status: "PENDING", paidAt: null }] }];
  const tp = computeReliefTimeline(paidThis, { monthKey: "2026-09", monthStart: start, monthEnd: end });
  check("[H] parcela deste mês já paga ainda conta no mês corrente (2 meses restantes: SET e OUT)", tp.todayMonthly === 100 && tp.milestones[0].monthKey === "2026-11");

  // ============ [I] ações (dispatch usado pela API)
  const plan2 = await createExternalInstallmentPlan({ description: `${MARK} Curso`, creditor: "Mãe", installmentValue: 30, installmentCount: 3, alreadyPaidCount: 1, dueTiming: "AFTER_NEXT_INCOME" });
  created.plans.push(plan2.id);
  const i2 = plan2.installments.find((i) => i.number === 2);
  const act = await performPay({ kind: "installment", installmentId: i2.id, accountId: itau.id, when: "hoje" }, { now: NOW });
  check("[I] performPay(installment) devolve o token de desfazer com updatedAt", act.undo.kind === "installment" && !!act.undo.expectedUpdatedAt);
  await performUndo(act.undo);
  check("[I] performUndo restaura a parcela", (await prisma.externalInstallment.findUnique({ where: { id: i2.id } })).status === "PENDING");
  check("[I] kind inválido → INVALID", (await code(() => performPay({ kind: "x" }))) === "INVALID");

  // ============ [J] GET read-only: modelos não escrevem nada
  const c0 = await counts();
  await buildCommitmentsModel({ now: NOW });
  const home = await buildHomeModel({ now: NOW });
  await listHouseBillInstances({ now: NOW });
  check("[J] buildCommitmentsModel + buildHomeModel + lista da casa: contagens de linhas IDÊNTICAS (zero escrita em GET)", (await counts()) === c0);
  check("[J] Home: cash − comprometido − protegido = livre", Math.abs(home.hero.cash - home.hero.committed - home.hero.protectedMoney - home.hero.free) < 0.02, JSON.stringify([home.hero.cash, home.hero.committed, home.hero.free]));
  check("[J] Home: por dia = floor(seguro / dias até a renda)", home.hero.daysLeft == null || home.hero.perDay === (home.hero.safe > 0 ? Math.floor(home.hero.safe / home.hero.daysLeft) : null));
  check("[J] Home: atenção nunca traz renda futura/VA", home.attention.every((a) => !/salário|recarga|vale/i.test(a.name)));
  check("[J] Home: últimas movimentações ≤ 5, datas dd/mm", home.moves.length <= 5 && home.moves.every((m) => /^\d{2}\/\d{2}$/.test(m.date)));
  check("[J] resumo do mês: resolvidos + pendentes = total", model.summary.resolved + model.summary.pending === model.summary.total);
  check("[J] datas: resolvePaymentDate(hoje/ontem) na timezone do app", resolvePaymentDate("hoje", NOW).toISOString().slice(0, 10) === "2026-09-25" && resolvePaymentDate("ontem", NOW).toISOString().slice(0, 10) === "2026-09-24");

  // ============ [K] âncora criada HOJE (caso real do Itaú em 25/09): pagar "Hoje" tem que baixar o saldo
  const anch = await mkAccount("ancora-hoje", "checking", 1000);
  await prisma.balanceAdjustment.create({ data: { accountId: anch.id, newBalance: 1000, note: MARK, source: "manual", occurredAt: new Date("2026-09-25T13:00:00.000Z") } });
  const planK = await createExternalInstallmentPlan({ description: `${MARK} Plano âncora`, creditor: "X", installmentValue: 100, installmentCount: 3, alreadyPaidCount: 0, dueTiming: "AFTER_NEXT_INCOME" });
  created.plans.push(planK.id);
  const k1 = planK.installments.find((i) => i.number === 1);
  const kPay = await payExternalInstallment(k1.id, { accountId: anch.id, when: "hoje", now: NOW });
  check("[K] pagar 'Hoje' com âncora posterior a 00:00 baixa o saldo (1000 → 900)", eq(await computeAccountBalance(anch.id), 900), String(await computeAccountBalance(anch.id)));
  check("[K] occurredAt de 'hoje' é o instante real, no mesmo dia local", kPay.expense.occurredAt.getTime() === NOW.getTime());
  await undoExternalInstallmentPayment(k1.id, { expectedUpdatedAt: kPay.installment.updatedAt.toISOString() });
  check("[K] desfazer devolve o saldo (900 → 1000)", eq(await computeAccountBalance(anch.id), 1000));
  const kYest = await payExternalInstallment(k1.id, { accountId: anch.id, when: "ontem", now: NOW });
  check("[K] 'ontem' segue à meia-noite (já refletido na âncora posterior — saldo intacto)", kYest.expense.occurredAt.toISOString() === "2026-09-24T00:00:00.000Z" && eq(await computeAccountBalance(anch.id), 1000));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
