// Fase 10.7 — testes do PLANNER (somente leitura) e do EXECUTOR do catch-up 14/10 → 27/10 (Itaú, Caju, Dinheiro, Cofrinho/Tattoo, cartão, Tattoo 1).
// DEV apenas; cada cenário roda dentro de uma transação interativa que SEMPRE dá rollback.
//
//   node scripts/test-fase107-catchup.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { computeAccountBalance, listAccountsWithBalances } from "../lib/accounts.js";
import { computeAdditionsSinceObservation, getCardBillView } from "../lib/cardBillCalculator.js";
import { computeFreeMoney, computeSafeToSpend } from "../lib/freeMoney.js";
import { getReserveBalance } from "../lib/reserves.js";
import { resolveNextExpectedIncomeFromDb, getNextIncomeInfo } from "../lib/incomeHorizon.js";
import { summarizeInternalReimbursements, settleInternalReimbursement } from "../lib/internalReimbursement.js";
import { buildCatchup107Plan, BANK_EOD_13_10, OBSERVED_AT_POLICY } from "./lib/catchup107Planner.js";
import { executeCatchup107Plan, CatchupAbort } from "./lib/catchup107Executor.js";
import { wipe, seedPost106, Rollback } from "./lib/catchup107Fixture.js";

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
const TABLES = ["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "cardCreditMovement", "confirmedCommitment", "receivable", "reserve", "reserveMovement", "goal", "internalReimbursement", "externalInstallmentPlan", "externalInstallment", "recurringRule", "card", "account", "telegramCorrectionAudit", "dataOperation"];
const dbSignature = async () => JSON.stringify(await Promise.all(TABLES.map((m) => prisma[m].count())));
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedPost106(tx);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 300000, maxWait: 30000 }
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
const num = (v) => Number(v?.toString?.() ?? v);
const NOW = new Date("2026-10-27T15:00:00Z");

async function main() {
  const plannerSrc = fs.readFileSync(new URL("./lib/catchup107Planner.js", import.meta.url), "utf8");
  check("[S] planner 10.7 sem escrita (mutação só no executor)", !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$transaction|\$execute|\bapply\b/i.test(plannerSrc));
  const before = await dbSignature();

  await inWorld(async (tx, w) => {
    const cofrinho = await tx.account.findFirst({ where: { slug: "cofrinho-itau" } });
    const plan = await buildCatchup107Plan({ client: tx });
    check("[P] estado-base 10.6: Itaú 12,28 · Caju 248,46 · Dinheiro 181,00 · Cofrinho 150,00", plan.balancesBefore.itau === "12.28" && plan.balancesBefore.caju === "248.46" && plan.balancesBefore.dinheiro === "181.00" && plan.balancesBefore.cofrinho === "150.00", JSON.stringify(plan.balancesBefore));
    check("[P] plano: 0 bloqueios, checkpoints OK, 44 operações", plan.blockers.length === 0 && plan.checkpoints.every((c) => c.ok) && plan.operations.length === 44, `${plan.operations.length} ${JSON.stringify(plan.blockers)}`);
    check("[P] Itaú: ledger projetado 4.918,52 com resíduo 0,00 (nenhum ajuste de Itaú planejado); Caju resíduo +0,40; Dinheiro −181,00; Cofrinho +43,00", plan.balancesProjected.itauLedger === "4918.52" && plan.balancesProjected.itauAdjustment === "0.00" && plan.balancesProjected.cajuLedger === "858.81" && plan.balancesProjected.cajuAdjustment === "0.40" && plan.balancesProjected.dinheiroAdjustment === "-181.00" && plan.balancesProjected.cofrinhoAdjustment === "43.00");
    check("[P] nenhum evento futuro no plano: sem Tattoo 2, sem casaco, sem R$438/Transfer", !plan.operations.some((o) => /1\.650|casaco|438/i.test(o.description) || (o.kind === "ADD_TRANSFER")) && plan.tattoo.tattoo2Created === false && plan.tattoo.casacoReceivableCreated === false && plan.tattoo.future438PaymentCreated === false);

    const nextBefore = JSON.stringify(await resolveNextExpectedIncomeFromDb({ now: NOW, client: tx }));
    const tStart = new Date();
    const res = await executeCatchup107Plan({ client: tx, plan });
    const tEnd = new Date();
    check("[E] executor aplicou o plano e passou na verificação interna (Itaú 4.918,52 · Caju 859,21 · Dinheiro 0,00 · Cofrinho/Reserve/Meta 193,00 · obs 1.480,88 · repasses 100,50)", res.applied === 44 && res.skipped.length === 0 && res.verification.itau === "4918.52" && res.verification.caju === "859.21" && res.verification.dinheiro === "0.00" && res.verification.cofrinho === "193.00" && res.verification.tattooReserve === "193.00" && res.verification.tattooGoalSaved === "193.00" && res.verification.novObserved === "1480.88" && res.verification.additionsSinceNovObservation === "0.00" && res.verification.reimbursementsPending === "100.50", JSON.stringify(res));
    check("[E] saldos pelo MOTOR REAL: Itaú 4.918,52 · Caju 859,21 · Dinheiro 0,00 · Cofrinho 193,00", (await bal(tx, w.itau.id)) === "4918.52" && (await bal(tx, w.caju.id)) === "859.21" && (await bal(tx, w.dinheiro.id)) === "0.00" && (await bal(tx, cofrinho.id)) === "193.00");

    // ---- âncoras
    const itauAnchors = await tx.balanceAdjustment.findMany({ where: { accountId: w.itau.id }, orderBy: { occurredAt: "asc" } });
    const rev = itauAnchors.at(-1);
    check("[A] Itaú: revisão de 13/10 = nova âncora 15,21 no FIM do dia 13/10 BRT (o extrato é fim de dia); a âncora anterior de 12,28 segue no histórico", rev.newBalance.toFixed(2) === "15.21" && rev.occurredAt.toISOString() === BANK_EOD_13_10 && itauAnchors.some((a) => a.newBalance.toFixed(2) === "12.28") && itauAnchors.length === 3 && /preservada/.test(rev.note));
    const eod = (x) => x.getUTCHours() === 2 && x.getUTCMinutes() === 59 && x.getUTCSeconds() === 59;
    const newAnchors = await tx.balanceAdjustment.findMany({ where: { rawMessage: { startsWith: "FASE107-CATCHUP" }, NOT: { rawMessage: { startsWith: "FASE107-CATCHUP:itau-13" } } } });
    check("[A] Caju (+0,40), Dinheiro (−181,00) e Cofrinho (+43,00): âncoras RECONCILIATION_ADJUSTMENT no INSTANTE real da execução (nenhuma 'fim do dia' fabricada); nunca Expense/Income", newAnchors.length === 3 && newAnchors.every((a) => a.confidence === "RECONCILIATION_ADJUSTMENT" && a.occurredAt >= tStart && a.occurredAt <= tEnd && !eod(a.occurredAt)) && newAnchors.map((a) => a.newBalance.toFixed(2)).sort().join() === "0.00,193.00,859.21");
    check("[A] política de âncora explícita e fontes do usuário nas notas (o sistema não releu os arquivos)", OBSERVED_AT_POLICY === "EXECUTION_INSTANT" && newAnchors.every((a) => /INSTANTE real da reconciliação/.test(a.note) && /não releu os arquivos/.test(a.note)) && /não releu os arquivos/.test(rev.note));
    check("[A] linhas de 13/10 (+2,92 / +0,04) registradas como Income extraordinária, não recorrente, não salário; já refletidas no saldo revisado (sem double count)", await (async () => { const i = await tx.income.findMany({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261013" } } }); return i.length === 2 && i.every((x) => !x.isRecurring && !x.recurringRuleId && x.category === "Outros") && /apostas/.test(i.find((x) => x.amount.toFixed(2) === "2.92").description); })());

    // ---- salário / hora extra / extras
    const sal = await tx.income.findFirst({ where: { recurringRuleId: w.salaryRule.id, recurringOccurrenceDate: new Date("2026-10-24T00:00:00Z") } });
    const ot = await tx.income.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261023-hora-extra" } } });
    check("[R] crédito 5.309,15 = salário-base 4.937,18 (ocorrência recorrente 24/10, banco 23/10) + hora extra 371,97 (extraordinária, sem regra, NÃO recorrente); sem duplicar o total", sal.amount.toFixed(2) === "4937.18" && sal.isRecurring === true && sal.occurredAt.toISOString().slice(0, 10) === "2026-10-23" && ot.amount.toFixed(2) === "371.97" && ot.isRecurring === false && ot.recurringRuleId === null && ot.recurringOccurrenceDate === null && (num(sal.amount) + num(ot.amount)).toFixed(2) === "5309.15" && (await tx.income.count({ where: { rawMessage: { contains: "crédito bancário único" } } })) === 2);
    const nextAfter = await resolveNextExpectedIncomeFromDb({ now: NOW, client: tx });
    const nextB = JSON.parse(nextBefore);
    console.log("   ↳ próxima renda antes:", JSON.stringify(nextB), "| depois:", JSON.stringify(nextAfter));
    check("[R] próxima renda: ocorrência de 24/10 realizada ⇒ avança para 24/11 com 4.937,18 (NÃO sobe para 5.309,15; hora extra não altera o salário esperado)", String(nextB.expectedDate).startsWith("2026-10-24") && new Date(nextAfter.expectedDate).toISOString().startsWith("2026-11-24") && num((await getNextIncomeInfo({ now: NOW, client: tx })).amount).toFixed(2) === "4937.18", JSON.stringify(nextAfter));
    const aff = await tx.income.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261014-afiliado" } } });
    const gamb = await tx.income.findMany({ where: { description: { contains: "casa de apostas" } } });
    check("[R] afiliado 130,20 e créditos de apostas (2,92 + 0,12) NÃO são recorrentes, NÃO são salário, sem regra recorrente (não entram na próxima renda)", aff.amount.toFixed(2) === "130.20" && !aff.isRecurring && !aff.recurringRuleId && gamb.length === 2 && gamb.every((g) => !g.isRecurring && !g.recurringRuleId));
    const rech = await tx.income.findFirst({ where: { recurringRuleId: w.rechargeRule.id, recurringOccurrenceDate: new Date("2026-10-21T00:00:00Z") } });
    check("[R] recarga do Caju 1.300,00 (23/10, ocorrência 21/10 da regra) é Income do Caju, NÃO salário e não entra no caixa irrestrito", rech.amount.toFixed(2) === "1300.00" && rech.accountId === w.caju.id && rech.occurredAt.toISOString().slice(0, 10) === "2026-10-23");
    const pedro = await tx.expense.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261024-pedro-churrasco" } } });
    check("[R] Pedro churrasco 40,00: data econômica 24/10 com lançamento bancário de 26/10 preservado na nota; Carlos 190 = gasto real, SEM Receivable", pedro.occurredAt.toISOString().slice(0, 10) === "2026-10-24" && /26\/10|2026-10-26/.test(pedro.rawMessage) && (await tx.receivable.count()) === 2 && (await tx.receivable.count({ where: { description: { contains: "pneu", mode: "insensitive" } } })) === 0);
    const carr = await tx.expense.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261014-carrossel" } } });
    const aleve = await tx.expense.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:card-aleve" } } });
    const dan = await tx.expense.findFirst({ where: { rawMessage: { startsWith: "FASE107-CATCHUP:20261023-daniel" } } });
    check("[R] confiança: Carrossel 55,22 ESTIMATED; Aleve Farma 11,68 UNCERTAIN (sem inventar remédio); Daniel Nogueira 55,00 UNCERTAIN no Caju", carr.confidence === "ESTIMATED" && carr.category === "Alimentação" && aleve.confidence === "UNCERTAIN" && /não identificada/.test(aleve.description) && dan.confidence === "UNCERTAIN" && dan.accountId === w.caju.id);

    // ---- Tattoo
    const reserve = await tx.reserve.findFirst({ where: { name: "Tattoo" } });
    const mv = await tx.reserveMovement.findMany({ where: { reserveId: reserve.id }, orderBy: { occurredAt: "asc" } });
    const goal = await tx.goal.findUnique({ where: { id: w.goal.id } });
    check("[T] Cofrinho/Tattoo 193,00: Reserve = 150 (ALLOCATE) + 43 (ADJUST_INCREASE, origem não detalhada); Meta guardada 193,00; sem Income inventada; sem baixa da Reserve", (await getReserveBalance(reserve.id, { client: tx })).toFixed(2) === "193.00" && mv.length === 2 && mv.map((m) => m.kind).join() === "ALLOCATE,ADJUST_INCREASE" && goal.savedAmount.toFixed(2) === "193.00" && (await tx.income.count({ where: { description: { contains: "Cofrinho" } } })) === 0 && !mv.some((m) => m.kind === "RELEASE"));
    const p1 = await tx.externalInstallmentPlan.findFirst({ where: { description: "Tattoo — parte 1" }, include: { installments: { orderBy: { number: "asc" } } } });
    check("[T] Tattoo 1: plano ACTIVE com a Mãe, R$ 1.450 = 10 × R$ 145,00, 10 parcelas PENDING, 0 pagas, sem data de calendário inventada (AFTER_NEXT_INCOME como os demais planos da mãe)", p1 && p1.creditor === "Mãe" && p1.status === "ACTIVE" && p1.installmentCount === 10 && p1.installmentValue.toFixed(2) === "145.00" && p1.installments.length === 10 && p1.installments.every((i) => i.status === "PENDING" && i.amount.toFixed(2) === "145.00" && i.dueDate === null && i.paidAt === null && i.expenseId === null) && p1.dueTiming === "AFTER_NEXT_INCOME" && p1.firstDueDate === null);
    check("[T] Tattoo 2 NÃO existe; venda do casaco NÃO existe (nenhum Receivable novo); R$ 438 NÃO existe (nenhum Transfer para a mãe/Cofrinho depois de 08/10, Reserve não baixada)", (await tx.externalInstallmentPlan.count({ where: { description: { contains: "Tattoo" } } })) === 1 && (await tx.receivable.count({ where: { description: { contains: "casaco", mode: "insensitive" } } })) === 0 && (await tx.transfer.count({ where: { occurredAt: { gt: new Date("2026-10-09T00:00:00Z") }, kind: { not: "card_bill_payment" } } })) === 0);

    // ---- cartão
    const card = await tx.card.findUnique({ where: { id: w.card.id } });
    const recs = await tx.cardBillReconciliation.findMany({ where: { cycleMonth: "2026-11" }, orderBy: [{ createdAt: "asc" }] });
    const rec = recs.at(-1);
    check("[C] novembro: nova observação 1.480,88 (anterior 1.060,46 preservada); calculado 1.476,77; delta 4,11 (mesmo gap da 10.6); novos lançamentos 320,42; delta total 420,42", recs.length === 2 && recs[0].observedTotal.toFixed(2) === "1060.46" && rec.observedTotal.toFixed(2) === "1480.88" && rec.calculatedTotal.toFixed(2) === "1476.77" && rec.delta.toFixed(2) === "4.11");
    check("[C] motor: acréscimo depois da observação = 0,00 ⇒ o Rei do Pernil (100,00) NÃO é mais 'pendente fora do observado'; aparece UMA vez (1 despesa, dentro do observado)", (await computeAdditionsSinceObservation(card, "2026-11", rec, { client: tx })).toFixed(2) === "0.00" && (await tx.expense.count({ where: { cardId: w.card.id, description: { contains: "Rei do Pernil" } } })) === 1 && num((await getCardBillView(card, "2026-11", { client: tx })).totalAmount).toFixed(2) === "1480.88");
    const newCard = await tx.expense.findMany({ where: { cardId: w.card.id, rawMessage: { startsWith: "FASE107-CATCHUP:card-" } } });
    const chat = newCard.find((e) => /ChatGPT — assinatura/.test(e.description));
    const iof = newCard.find((e) => /IOF/.test(e.description));
    check("[C] 7 lançamentos novos = 320,42; ChatGPT 106,60 recorrente; IOF 3,73 como encargo (não compra independente); Wellhub Ana Beatriz recorrente; Cicaplast/pet/gasolina nas categorias do app", newCard.length === 7 && newCard.reduce((a, e) => a + num(e.amount), 0).toFixed(2) === "320.42" && chat.isRecurring && chat.amount.toFixed(2) === "106.60" && iof.amount.toFixed(2) === "3.73" && !iof.isRecurring && newCard.find((e) => /Wellhub/.test(e.description)).isRecurring && newCard.find((e) => /Cicaplast/.test(e.description)).category === "Saúde" && newCard.find((e) => /Casa do Criador/.test(e.description)).category === "Saúde" && newCard.find((e) => /Posto/.test(e.description)).category === "Transporte");
    const sums = async (m) => (await tx.installment.aggregate({ where: { billMonth: m, purchase: { cardId: w.card.id } }, _sum: { amount: true } }))._sum.amount?.toFixed(2);
    const bills = Object.fromEntries((await tx.cardBill.findMany({ where: { cardId: w.card.id } })).map((b) => [b.cycleMonth, b.totalAmount.toFixed(2)]));
    check("[C] parcelas futuras PRESERVADAS: dez 200,36 · jan 200,36 · fev 60,60; fatura persistida de novembro = calculado 1.476,77; nenhum Purchase novo", (await sums("2026-12")) === "200.36" && (await sums("2027-01")) === "200.36" && (await sums("2027-02")) === "60.60" && bills["2026-11"] === "1476.77" && (await tx.purchase.count()) === 7);
    check("[C] limite: nenhum snapshot novo (último de 13/10 preservado: 4 snapshots)", (await tx.cardLimitUpdate.count()) === 4);

    // ---- preservados
    const reimb = await tx.internalReimbursement.findMany();
    const tiny = await tx.receivable.findFirst({ where: { notes: { startsWith: "FASE106-CATCHUP:tiny" } } });
    const cnpj = await tx.confirmedCommitment.findUnique({ where: { id: w.cnpj.id } });
    check("[K] preservados: repasses 29,50 + 71,00 = 100,50 PENDING (sem Transfer; Caju real 859,21; após repasses 758,71); Tiny 65,90 PENDING; CNPJ 1.335 CONFIRMED não-funded", reimb.length === 2 && reimb.every((r) => r.status === "PENDING" && r.transferId === null) && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 0 && (await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx })).availableAfterPending === 758.71 && tiny.status === "PENDING" && cnpj.status === "CONFIRMED" && cnpj.fundingAccountId === null && cnpj.amount.toFixed(2) === "1335.00");

    // ---- motor: decomposição
    const accs = await listAccountsWithBalances({ client: tx });
    const cashOnly = accs.filter((a) => a.type === "checking" || a.type === "cash").reduce((s, a) => s + num(a.balance), 0);
    const fm = await computeFreeMoney({ now: NOW, accounts: accs, nextIncomeDate: new Date("2026-11-24T00:00:00Z"), client: tx });
    check("[F] caixa irrestrito = Itaú 4.918,52 + Dinheiro 0,00 = 4.918,52 (Caju 859,21 e Cofrinho 193,00 FORA); protegido 0 (Tattoo no Cofrinho: sem dupla contagem)", Math.abs(num(fm.unrestrictedCash) - cashOnly) < 0.005 && num(fm.unrestrictedCash).toFixed(2) === "4918.52" && num(fm.protectedMoney) === 0, `${fm.unrestrictedCash} / ${fm.protectedMoney}`);
    check("[F] dívida de cartão incorrida = observado 1.480,88 − parcelas já contratadas de novembro 571,79 = 909,09 (Rei do Pernil UMA vez; sem 'pendente' extra)", num(fm.incurredLiabilities).toFixed(2) === "909.09", String(fm.incurredLiabilities));
    console.log("   ↳ freeMoney:", JSON.stringify({ unrestrictedCash: String(fm.unrestrictedCash), protectedMoney: String(fm.protectedMoney), incurred: String(fm.incurredLiabilities), currentHorizon: String(fm.currentHorizonObligations), nextIncomeWindow: String(fm.nextIncomeWindowCommitment), future: String(fm.futureObligations), free: String(fm.freeMoney), safe: JSON.stringify(computeSafeToSpend(fm.freeMoney, 10)) }));
    const tattooInWindow = (fm.nextIncomeWindowCommitmentItems ?? []).filter((i) => JSON.stringify(i).includes("Tattoo"));
    check("[F] Tattoo 1: apenas a PRIMEIRA parcela (145,00) é compromisso da janela da próxima renda; as outras 9 são futuras; Tattoo 2 e casaco não existem no motor", tattooInWindow.length === 1 && tattooInWindow.reduce((s, i) => s + num(i.amount), 0).toFixed(2) === "145.00" && !JSON.stringify(fm).includes("1650") && !JSON.stringify(fm).includes("245"), JSON.stringify(tattooInWindow));

    // ---- liquidação de repasse DEPOIS do catch-up (mesma semântica da 10.6): altera o saldo
    const pend = await tx.internalReimbursement.findMany({ orderBy: { amount: "asc" } });
    const s1 = await settleInternalReimbursement({ id: pend[0].id, now: new Date(tEnd.getTime() + 60000), client: tx });
    check("[Z] liquidar um repasse depois do catch-up altera os saldos (Caju 859,21 → 829,71) — âncoras de instante real", s1.status === "SETTLED" && (await bal(tx, w.caju.id)) === "829.71" && (await bal(tx, w.itau.id)) === "4948.02");

    // ---- sem duplicidade + idempotência (com repasse liquidado e movimento legítimo posterior)
    await tx.expense.create({ data: { amount: "12.00", description: "gasto legítimo depois do catch-up", category: "Alimentação", accountId: w.caju.id, occurredAt: new Date(tEnd.getTime() + 3600000) } });
    const dupExp = await tx.expense.groupBy({ by: ["accountId", "cardId", "amount", "occurredAt", "description"], _count: { _all: true }, having: { id: { _count: { gt: 1 } } } });
    const dupInc = await tx.income.groupBy({ by: ["accountId", "amount", "occurredAt", "description"], _count: { _all: true }, having: { id: { _count: { gt: 1 } } } });
    check("[D] nenhuma duplicata de despesa/renda", dupExp.length === 0 && dupInc.length === 0);
    const plan2 = await buildCatchup107Plan({ client: tx });
    check("[N] 2º planner ⇒ 0 operações, 0 bloqueios, checkpoints OK", plan2.operations.length === 0 && plan2.blockers.length === 0 && plan2.checkpoints.every((c) => c.ok), plan2.operations.map((o) => `${o.kind}:${o.description.slice(0, 60)}`).join(" | ") + JSON.stringify(plan2.blockers));
    const sig1 = await touched(tx);
    const res2 = await executeCatchup107Plan({ client: tx, plan: plan2 });
    check("[N] 2ª execução ⇒ 0 mutações", res2.mutations.total === 0 && res2.applied === 0 && (await touched(tx)) === sig1);
    const sig2 = await touched(tx);
    let stale = null;
    try {
      await executeCatchup107Plan({ client: tx, plan });
    } catch (e) {
      stale = e;
    }
    check("[N] reexecutar o plano ANTIGO ⇒ CatchupAbort por preconditions, 0 escritas", stale instanceof CatchupAbort && (await touched(tx)) === sig2, String(stale?.message));
  });

  // resíduo muda entre planejar e executar ⇒ ABORTA
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup107Plan({ client: tx });
    await tx.expense.create({ data: { amount: "0.01", description: "lançamento surpresa", category: "Outros", accountId: w.itau.id, occurredAt: new Date("2026-10-20T00:00:00Z") } });
    let err = null;
    try {
      await executeCatchup107Plan({ client: tx, plan });
    } catch (e) {
      err = e;
    }
    check("[A] estado muda entre planejar e executar ⇒ ABORTA (nunca cria ajuste cego)", err instanceof CatchupAbort, String(err?.message));
  });
  // possível duplicata sem marcador ⇒ BLOQUEIO
  await inWorld(async (tx, w) => {
    await tx.expense.create({ data: { amount: "30.00", description: "Posto (já lançado à mão)", category: "Transporte", accountId: w.itau.id, occurredAt: new Date("2026-10-14T00:00:00Z") } });
    const blocked = await buildCatchup107Plan({ client: tx });
    check("[A] linha equivalente já lançada à mão (sem marcador) ⇒ BLOQUEIO 'possível duplicata' (nunca importa em silêncio)", blocked.blockers.some((b) => /duplicata/i.test(b)));
    let e1 = null;
    try {
      await executeCatchup107Plan({ client: tx, plan: blocked });
    } catch (e) {
      e1 = e;
    }
    check("[A] plano com bloqueio é recusado integralmente", e1 instanceof CatchupAbort && /bloqueios/.test(e1.message));
  });
  // Tattoo 2 já existente ⇒ BLOQUEIO
  await inWorld(async (tx) => {
    await tx.externalInstallmentPlan.create({ data: { description: "Tattoo — parte 2", creditor: "Mãe", installmentValue: "165", installmentCount: 10, dueTiming: "AFTER_NEXT_INCOME" } });
    const blocked = await buildCatchup107Plan({ client: tx });
    check("[A] segunda tattoo existente ⇒ BLOQUEIO (não foi realizada)", blocked.blockers.some((b) => /Tattoo/.test(b)));
  });
  // client raiz: falha ⇒ rollback total
  const sigBefore = await dbSignature();
  let outer = null;
  try {
    await executeCatchup107Plan({ client: prisma, plan: { operations: [{ id: "x3", kind: "UPDATE_GOAL_SAVED", preconditions: { goalId: "inexistente", currentSaved: "0" }, to: { savedAmount: "1" } }], blockers: [] } });
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
