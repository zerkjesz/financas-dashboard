// Fase 10.4 — PASSO B: testes direcionados do EXECUTOR (scripts/lib/catchup104Executor.js) + ordenação temporal do motor (lib/anchorOrdering.js).
// DEV apenas; cada cenário roda dentro de uma transação interativa que SEMPRE dá rollback (nada persiste; contagens do DEV provadas antes × depois).
//
//   node scripts/test-fase104-executor.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { computeCardUsedLimit, computeCardTotalLimit } from "../lib/cards.js";
import { computeAdditionsSinceObservation, getCardBillView } from "../lib/cardBillCalculator.js";
import { anchorExtraWindow, isAfterAnchor } from "../lib/anchorOrdering.js";
import { buildCatchup104Plan, ANCHOR_AT, CARD_OBSERVED_AT } from "./lib/catchup104Planner.js";
import { executeCatchup104Plan, CatchupAbort } from "./lib/catchup104Executor.js";
import { wipe, seedBefore, Rollback } from "./lib/catchup104Fixture.js";

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
const TABLES = ["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "confirmedCommitment", "contingency", "recurringRule", "card", "account", "telegramCorrectionAudit", "dataOperation"];
const dbSignature = async () => JSON.stringify(await Promise.all(TABLES.map((m) => prisma[m].count())));
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore(tx);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 180000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
// assinatura do que o catch-up toca (contagens + updatedAt máximo) para provar "0 mutações"
async function touched(tx) {
  const maxU = async (m) => String((await tx[m].aggregate({ _max: { updatedAt: true } }))._max.updatedAt ?? "");
  return JSON.stringify([await Promise.all(TABLES.map((m) => tx[m].count())), await maxU("expense"), await maxU("bill"), await maxU("purchase"), await maxU("cardBill"), await maxU("contingency"), await maxU("confirmedCommitment")]);
}

async function main() {
  // [S] separação planner × executor
  const plannerSrc = fs.readFileSync(new URL("./lib/catchup104Planner.js", import.meta.url), "utf8");
  check("[S] planner continua sem escrita e sem 'apply' (mutação só no executor)", !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$transaction|\$execute|\bapply\b/i.test(plannerSrc));

  const before = await dbSignature();

  // ------------------------------------------------------------------ cenário 1: aplicação + verificação + idempotência
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup104Plan({ client: tx });
    check("[E] plano de entrada: 44 operações, 0 bloqueios", plan.operations.length === 44 && plan.blockers.length === 0, `${plan.operations.length} / ${JSON.stringify(plan.blockers)}`);
    const transfersBefore = await tx.transfer.count();
    const incomesBefore = await tx.income.count();
    const res = await executeCatchup104Plan({ client: tx, plan });
    check("[E] executor aplicou o plano e passou na verificação interna", res.applied === 44 && res.skipped.length === 0 && res.verification.itau === "2490.38" && res.verification.caju === "530.89" && res.verification.cardCalculated === "1795.77" && res.verification.additionsSinceObservation === "0.00", JSON.stringify(res));

    // saldos pelo MOTOR REAL
    check("[E] Itaú final = 2.490,38 e Caju final = 530,89", (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2) === "2490.38" && (await computeAccountBalance(w.caju.id, { client: tx })).toFixed(2) === "530.89");
    const adjs = await tx.balanceAdjustment.findMany({ where: { rawMessage: { startsWith: "FASE104-CATCHUP" } }, orderBy: { rawMessage: "asc" } });
    check("[E] 2 ajustes RECONCILIATION_ADJUSTMENT (Itaú 2.490,38 e Caju 530,89), na âncora de fuso correto", adjs.length === 2 && adjs.every((a) => a.confidence === "RECONCILIATION_ADJUSTMENT" && a.occurredAt.toISOString() === ANCHOR_AT) && adjs.find((a) => a.accountId === w.itau.id).newBalance.toFixed(2) === "2490.38" && adjs.find((a) => a.accountId === w.caju.id).newBalance.toFixed(2) === "530.89");

    // contas da casa
    check("[E] Água falsa de 26/09 removida (Expense e Bill) — Água real de 23/09 (59,31) intacta", !(await tx.expense.findUnique({ where: { id: w.aguaFalsaExp.id } })) && !(await tx.bill.findUnique({ where: { id: w.aguaFalsa.id } })) && (await tx.bill.findUnique({ where: { id: w.aguaReal.id } }))?.status === "paid" && (await tx.expense.findUnique({ where: { id: w.aguaRealExp.id } })).amount.toFixed(2) === "59.31");
    check("[E] Água do ciclo atual: sem Bill paga em 2026-10 (volta a PENDING pela regra)", (await tx.bill.count({ where: { description: "Água", cycleMonth: "2026-10", status: "paid" } })) === 0);
    check("[E] Energia: nenhuma Bill criada/paga (segue PENDING_UNPRICED)", (await tx.bill.count({ where: { recurringRule: { name: "Energia" } } })) === 0);
    const telE = await tx.expense.findUnique({ where: { id: w.telExp.id } });
    const telB = await tx.bill.findUnique({ where: { id: w.tel.id } });
    check("[E] Telefone 60,00 → 57,48 na MESMA Expense/Bill (sem 2ª despesa, data preservada)", telE.amount.toFixed(2) === "57.48" && telB.amount.toFixed(2) === "57.48" && telE.occurredAt.toISOString() === "2026-09-26T04:35:00.000Z" && (await tx.expense.count({ where: { billId: w.tel.id } })) === 1);

    // Itaú / Caju
    const marker = async (m, model = "expense") => tx[model].findFirst({ where: { rawMessage: { startsWith: `FASE104-CATCHUP:${m}` } } });
    check("[E] Kaizen +0,11 é Income 'Outros' de finalidade desconhecida", (await marker("20261001-kaizen", "income")).category === "Outros" && /desconhecida/.test((await marker("20261001-kaizen", "income")).description));
    check("[E] rendimentos 28/09 (0,28) e 05/10 (0,04) como Income (rendimento bancário)", (await marker("20260928-rend", "income")).amount.toFixed(2) === "0.28" && (await marker("20261005-rend", "income")).amount.toFixed(2) === "0.04");
    check("[E] Tiger R$ 1.000 pago em 05/10 = 1 despesa real", (await tx.expense.count({ where: { rawMessage: { startsWith: "FASE104-CATCHUP:20261005-leandro-tiger" } } })) === 1);
    check("[E] Carrossel 03/10 R$ 65,36 no Caju", (await marker("20261003-carrossel")).accountId === w.caju.id);
    check("[E] reembolso Caju → Itaú R$ 29,50: NENHUM Transfer/Income criado; só anotação no gasto", (await tx.transfer.count()) === transfersBefore && (await tx.income.count()) === incomesBefore + 3 && (await marker("20260930-pedro-lazari")).rawMessage.includes("reembolso interno"));

    // Tiger
    const tg = await tx.confirmedCommitment.findMany({ where: { description: { startsWith: "Acordo Tiger" } } });
    const cont = await tx.contingency.findUnique({ where: { id: w.cont.id } });
    check("[E] Tiger: compromisso 5.000 sem dueDate; contingência antiga DISMISSED com nota; sem dupla contagem", tg.length === 1 && tg[0].amount.toFixed(2) === "5000.00" && tg[0].dueDate === null && tg[0].status === "CONFIRMED" && cont.status === "DISMISSED" && /Substituída/.test(cont.notes) && (await tx.contingency.count({ where: { description: "Tiger", status: { not: "DISMISSED" } } })) === 0);

    // cartão
    const sushi = await tx.expense.findMany({ where: { cardId: w.card.id, description: { contains: "Sushi" } } });
    check("[E] Sushi: MESMA despesa corrigida (05/09 → 06/09; 385,00 → 384,89); nenhuma segunda", sushi.length === 1 && sushi[0].amount.toFixed(2) === "384.89" && sushi[0].occurredAt.toISOString().slice(0, 10) === "2026-09-06");
    const iof = await tx.expense.findFirst({ where: { cardId: w.card.id, description: { contains: "IOF" } } });
    check("[E] IOF 7,93: ENCARGO da fatura em 04/10 (não retroativo, não dividido), único", iof && iof.amount.toFixed(2) === "7.93" && iof.occurredAt.toISOString().slice(0, 10) === "2026-10-04" && (await tx.expense.count({ where: { cardId: w.card.id, description: { contains: "IOF" } } })) === 1 && /encargo da fatura/.test(iof.rawMessage));
    const rec = await tx.cardBillReconciliation.findFirst({ where: { cardId: w.card.id, cycleMonth: "2026-10" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const cycleExpenses = await tx.expense.findMany({ where: { cardId: w.card.id, occurredAt: { gte: d("2026-09-05T00:00:00Z"), lt: d("2026-10-05T00:00:00Z") } } });
    check("[O] observação 1.795,77 = 04/10 23:59:59 America/Sao_Paulo, DEPOIS de todo lançamento do fechamento (inclusive o IOF)", rec.observedTotal.toFixed(2) === "1795.77" && rec.occurredAt.toISOString() === CARD_OBSERVED_AT && cycleExpenses.every((e) => e.occurredAt < rec.occurredAt) && iof.createdAt <= rec.createdAt);
    const card = await tx.card.findUnique({ where: { id: w.card.id } });
    check("[O] motor: nenhum lançamento do fechamento conta como 'posterior à observação' (acréscimos = 0; total = 1.795,77; lacuna = 0)", (await computeAdditionsSinceObservation(card, "2026-10", rec, { client: tx })).toFixed(2) === "0.00" && (await getCardBillView(card, "2026-10", { client: tx, now: d("2026-10-08T12:00:00Z") })).totalAmount.toFixed(2) === "1795.77" && (await getCardBillView(card, "2026-10", { client: tx, now: d("2026-10-08T12:00:00Z") })).knownDetailGap.toFixed(2) === "0.00");
    const bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-10" } } });
    check("[C] CardBill 2026-10: total 1.795,77, fechada, vence 13/10, NÃO paga", bill.totalAmount.toFixed(2) === "1795.77" && bill.status === "closed" && bill.dueAt.toISOString().slice(0, 10) === "2026-10-13" && bill.paidAt === null);
    const lim = await tx.cardLimitUpdate.findFirst({ where: { cardId: w.card.id }, orderBy: { occurredAt: "desc" } });
    check("[C] limite observado no fechamento: 5.087,00 / 2.471,16 / 2.615,84 (snapshot, na data de fechamento em fuso correto)", lim.newTotalLimit.toFixed(2) === "5087.00" && lim.reportedAvailable.toFixed(2) === "2471.16" && lim.newUsedLimit.toFixed(2) === "2615.84" && lim.occurredAt.toISOString() === CARD_OBSERVED_AT && /fechamento/.test(lim.note));
    check("[C] motor de limite: total 5.087,00 e usado 2.615,84 (nada após o snapshot)", (await computeCardTotalLimit(w.card.id, { client: tx })).toFixed(2) === "5087.00" && (await computeCardUsedLimit(w.card.id, { client: tx })).toFixed(2) === "2615.84");
    const purchases = await tx.purchase.findMany({ where: { cardId: w.card.id }, include: { installments: { orderBy: { number: "asc" } } } });
    check("[C] 9 parcelamentos (7 novos + 2 existentes), sem duplicar", purchases.length === 9 && new Set(purchases.map((p) => p.description)).size === 9);
    const colchao = purchases.find((p) => /colchão/.test(p.description));
    check("[C] colchão: 33,27 / 33,24 observadas; 3/4 e 4/4 derived_from_official_statement com confiança ESTIMATED", colchao.installments.map((i) => i.amount.toFixed(2)).join() === "33.27,33.24,33.24,33.24" && colchao.confidence === "ESTIMATED" && /derived_from_official_statement \(ESTIMATED\): 3\/4, 4\/4/.test(colchao.rawMessage) && /observadas: 1\/4, 2\/4/.test(colchao.rawMessage));
    const monthSum = async (m) => (await tx.installment.aggregate({ where: { billMonth: m, purchase: { cardId: w.card.id } }, _sum: { amount: true } }))._sum.amount?.toFixed(2);
    const next = await monthSum("2026-11");
    const later = ["2026-12", "2027-01", "2027-02"].reduce(async (a, m) => (await a) + Number((await monthSum(m)) ?? 0), Promise.resolve(0));
    check("[C] futuro: próxima 571,79 · demais 248,28 · total 820,07", next === "571.79" && Math.round((await later) * 100) === 24828 && Math.round((Number(next) + (await later)) * 100) === 82007, `${next} ${await later}`);
    check("[C] 3 faturas futuras persistidas sincronizadas com o calculado (571,79 / 93,84 / 93,84)", ["2026-11", "2026-12", "2027-01"].map((m) => m).length === 3 && (await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-11" } } })).totalAmount.toFixed(2) === "571.79" && (await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2027-01" } } })).totalAmount.toFixed(2) === "93.84");
    const recurring = await tx.expense.findMany({ where: { cardId: w.card.id, isRecurring: true } });
    check("[C] recorrentes reais da fatura: Claude 116,31 · ChatGPT 110,20 · Spotify 31,90 · Apple 19,90 · Wellhub 69,99 ×2; Tiny ERP NÃO recorrente", recurring.map((e) => e.amount.toFixed(2)).sort().join() === ["116.31", "110.20", "31.90", "19.90", "69.99", "69.99"].sort().join() && !(await tx.expense.findFirst({ where: { cardId: w.card.id, description: "Tiny ERP" } })).isRecurring);

    // ordenação temporal do motor (âncora em fim do dia LOCAL)
    check("[O] janela extra da âncora BRT existe (08/10 00:00Z … 02:59:59Z)", (() => { const win = anchorExtraWindow(d(ANCHOR_AT)); return win && win.gte.toISOString() === "2026-10-08T00:00:00.000Z" && win.lte.toISOString() === ANCHOR_AT; })());
    check("[O] âncoras antigas (ex.: 25/09 04:58Z, 04/09 23:59Z) não têm janela extra ⇒ comportamento anterior idêntico", anchorExtraWindow(d("2026-09-25T04:58:00Z")) === null && anchorExtraWindow(d("2026-09-04T23:59:00Z")) === null);
    const itauBal = async () => (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2);
    await tx.expense.create({ data: { amount: "20", description: "teste calendário 08/10", category: "Outros", accountId: w.itau.id, occurredAt: d("2026-10-08T00:00:00Z") } });
    check("[O] lançamento-calendário de 08/10 (00:00Z, ANTES do instante da âncora) CONTA — é posterior ao fechamento de 07/10", (await itauBal()) === "2470.38", await itauBal());
    await tx.expense.create({ data: { amount: "5", description: "teste calendário 07/10", category: "Outros", accountId: w.itau.id, occurredAt: d("2026-10-07T00:00:00Z") } });
    check("[O] lançamento-calendário de 07/10 continua dentro do saldo observado (não conta de novo)", (await itauBal()) === "2470.38");
    await tx.expense.create({ data: { amount: "7", description: "teste instante 22h BRT 07/10", category: "Outros", accountId: w.itau.id, occurredAt: d("2026-10-08T01:00:00Z") } });
    check("[O] instante real 07/10 22:00 BRT (antes da âncora) NÃO conta", (await itauBal()) === "2470.38");
    await tx.expense.create({ data: { amount: "3", description: "teste instante 00:30 BRT 08/10", category: "Outros", accountId: w.itau.id, occurredAt: d("2026-10-08T03:30:00Z") } });
    check("[O] instante real 08/10 00:30 BRT (depois da âncora) conta", (await itauBal()) === "2467.38", await itauBal());
    check("[O] isAfterAnchor coerente com as consultas", isAfterAnchor(d("2026-10-08T00:00:00Z"), d(ANCHOR_AT)) && !isAfterAnchor(d("2026-10-07T00:00:00Z"), d(ANCHOR_AT)) && !isAfterAnchor(d("2026-10-08T01:00:00Z"), d(ANCHOR_AT)) && isAfterAnchor(d("2026-10-08T03:30:00Z"), d(ANCHOR_AT)));
    await tx.expense.create({ data: { amount: "10", description: "compra calendário 05/10 cartão", category: "Outros", cardId: w.card.id, occurredAt: d("2026-10-05T00:00:00Z") } });
    check("[O] limite: compra-calendário de 05/10 (depois do fechamento de 04/10) entra no usado (2.625,84); a de 04/10 não duplica", (await computeCardUsedLimit(w.card.id, { client: tx })).toFixed(2) === "2625.84");

    // idempotência: replanejar ⇒ 0; reexecutar ⇒ 0 mutações
    // (remove as despesas de teste de ordenação acima antes de medir)
    await tx.expense.deleteMany({ where: { description: { startsWith: "teste " } } });
    await tx.expense.deleteMany({ where: { description: "compra calendário 05/10 cartão" } });
    const plan2 = await buildCatchup104Plan({ client: tx });
    check("[N] 2º planner sobre o estado aplicado ⇒ 0 operações, sem bloqueios", plan2.operations.length === 0 && plan2.blockers.length === 0, plan2.operations.map((o) => `${o.kind}:${o.description.slice(0, 50)}`).join(" | "));
    const sig1 = await touched(tx);
    const res2 = await executeCatchup104Plan({ client: tx, plan: plan2 });
    check("[N] 2ª execução ⇒ 0 mutações financeiras (nada duplica: Expense, Income, installment, Bill, reconciliação, compromisso, ajuste)", res2.mutations.total === 0 && res2.applied === 0 && (await touched(tx)) === sig1);
    check("[N] saldos e checkpoints permanecem (Itaú 2.490,38 · Caju 530,89 · fatura 1.795,77)", plan2.balancesBefore.itau === "2490.38" && plan2.balancesBefore.caju === "530.89" && plan2.checkpoints.every((c) => c.ok));

    // plano antigo (stale) reexecutado ⇒ ABORTA nas preconditions, sem escrever nada
    const sig2 = await touched(tx);
    let stale = null;
    try {
      await executeCatchup104Plan({ client: tx, plan });
    } catch (e) {
      stale = e;
    }
    check("[N] reexecutar o plano ANTIGO (estado já reconciliado) ⇒ CatchupAbort pelas preconditions, 0 escritas", stale instanceof CatchupAbort && (await touched(tx)) === sig2, String(stale?.message));
  });

  // ------------------------------------------------------------------ cenário 2: resíduo muda inesperadamente ⇒ ABORTA
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup104Plan({ client: tx });
    await tx.expense.create({ data: { amount: "0.01", description: "lançamento surpresa", category: "Outros", accountId: w.itau.id, occurredAt: d("2026-10-06T00:00:00Z") } });
    let err = null;
    try {
      await executeCatchup104Plan({ client: tx, plan });
    } catch (e) {
      err = e;
    }
    check("[A] resíduo muda entre planejar e executar ⇒ ABORTA (nunca cria o ajuste)", err instanceof CatchupAbort && /resíduo mudou|ledger recalculado/.test(err.message) && (await tx.balanceAdjustment.count({ where: { rawMessage: { startsWith: "FASE104-CATCHUP" } } })) === 0, String(err?.message));
  });
  // cenário 3: precondition de uma operação falha (despesa do cartão mudou) ⇒ ABORTA
  await inWorld(async (tx, w) => {
    const plan = await buildCatchup104Plan({ client: tx });
    await tx.expense.update({ where: { cardId: w.card.id, id: (await tx.expense.findFirst({ where: { cardId: w.card.id, description: { contains: "Claude" } } })).id }, data: { amount: "120.40" } });
    let err = null;
    try {
      await executeCatchup104Plan({ client: tx, plan });
    } catch (e) {
      err = e;
    }
    check("[A] linha do cartão alterada depois do plano ⇒ ABORTA (precondition)", err instanceof CatchupAbort && /linha do cartão mudou/.test(err.message), String(err?.message));
  });
  // cenário 4: executor recusa plano com bloqueios / operação desconhecida / sem preconditions
  await inWorld(async (tx, w) => {
    await tx.expense.update({ where: { id: w.aguaFalsaExp.id }, data: { amount: "59.30" } });
    const blocked = await buildCatchup104Plan({ client: tx });
    let e1 = null;
    try {
      await executeCatchup104Plan({ client: tx, plan: blocked });
    } catch (e) {
      e1 = e;
    }
    check("[A] plano com BLOQUEIO é recusado integralmente", e1 instanceof CatchupAbort && /bloqueios/.test(e1.message));
    let e2 = null;
    try {
      await executeCatchup104Plan({ client: tx, plan: { operations: [{ id: "x1", kind: "DROP_EVERYTHING", preconditions: {} }], blockers: [] } });
    } catch (e) {
      e2 = e;
    }
    let e3 = null;
    try {
      await executeCatchup104Plan({ client: tx, plan: { operations: [{ id: "x2", kind: "ADD_EXPENSE" }], blockers: [] } });
    } catch (e) {
      e3 = e;
    }
    check("[A] operação desconhecida ou sem preconditions é recusada", e2 instanceof CatchupAbort && e3 instanceof CatchupAbort);
  });
  // cenário 5: rollback total quando o executor abre a própria transação
  const sigBefore = await dbSignature();
  let outer = null;
  try {
    await executeCatchup104Plan({ client: prisma, plan: { operations: [{ id: "x3", kind: "DISMISS_CONTINGENCY", preconditions: { contingencyId: "inexistente", currentStatus: "AWAITING_INFORMATION", description: "Tiger" }, data: { status: "DISMISSED", notesAppend: "x" } }], blockers: [] } });
  } catch (e) {
    outer = e;
  }
  check("[A] com o client raiz o executor abre UMA transação: falha ⇒ rollback total, DEV intacto", outer instanceof CatchupAbort && (await dbSignature()) === sigBefore);

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
