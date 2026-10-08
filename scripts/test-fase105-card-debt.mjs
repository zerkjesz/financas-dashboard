// Fase 10.5 — REGRA CANÔNICA DA DÍVIDA DE CARTÃO no motor de livre/comprometido (lib/freeMoney.js).
//   INCORRIDA (reduz o livre AGORA, mesmo com vencimento depois da próxima renda): fatura FECHADA não paga + compras REAIS já feitas
//   na fatura aberta (Expense do cartão, 1ª parcela de compra feita no ciclo, valor observado do banco + lançado depois).
//   FUTURA (visível em projeção/Cartões, NÃO reduz o livre hoje): parcelas já contratadas que ainda vão cair na fatura aberta/seguintes.
// DEV apenas; cada cenário numa transação que SEMPRE reverte. Estado de partida = PROD depois do catch-up da 10.4
// (Itaú 2.490,38; fatura 2026-10 = 1.795,77 fechada/não paga, vence 13/10; fatura 2026-11 = 571,79 só de parcelas; renda em 24/10).
//
//   node scripts/test-fase105-card-debt.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import { computeFreeMoney } from "../lib/freeMoney.js";
import { buildItauModel } from "../lib/cardsItau.js";
import { payCardBillInFull } from "../lib/cardBillPayment.js";
import { computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
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
const NOW = d("2026-10-08T15:00:00Z"); // 12:00 em Brasília; renda esperada em 24/10
const NEXT_INCOME = d("2026-10-24T00:00:00Z");
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore(tx);
        await seedReconciled(tx, w);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 180000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
const fm = async (tx, now = NOW) => computeFreeMoney({ now, accounts: await listAccountsWithBalances({ client: tx }), nextIncomeDate: NEXT_INCOME, client: tx });
const cardItems = (f, which) => (which === "incurred" ? f.incurredLiabilitiesItems : f.futureObligationsItems).filter((i) => i.type === "CardBill");
// Simula o caminho de escrita do app (getOrCreateBill): depois de gravar compra/parcela, o total persistido das faturas ABERTAS é recalculado.
async function syncStored(tx, card) {
  for (const b of await tx.cardBill.findMany({ where: { cardId: card.id, status: "open" } })) await tx.cardBill.update({ where: { id: b.id }, data: { totalAmount: await computeExpectedCardBillTotal(card, b.cycleMonth, { client: tx }) } });
}
const sum = (items) => items.reduce((a, i) => a + Math.round(Number(i.amount.toFixed(2)) * 100), 0) / 100;

async function main() {
  await inWorld(async (tx, w) => {
    const f0 = await fm(tx);

    // ---- A. fatura fechada não paga => comprometida inteira
    const inc0 = cardItems(f0, "incurred");
    check("[A] fatura fechada e não paga ⇒ comprometida INTEIRA (1.795,77), mesmo que o vencimento seja depois de hoje", inc0.length === 1 && inc0[0].cycleMonth === "2026-10" && inc0[0].amount.toFixed(2) === "1795.77" && inc0[0].component === "closed_unpaid", JSON.stringify(inc0.map((i) => [i.cycleMonth, i.amount.toFixed(2), i.component])));
    check("[A] cartão comprometido antes = 1.795,77", f0.incurredLiabilities.toFixed(2) === "1795.77");

    // ---- C/F. a fatura seguinte só tem parcelas projetadas => visível, NÃO comprometida
    const fut0 = cardItems(f0, "future");
    check("[C] fatura 2026-11 (só parcelas projetadas) aparece como obrigação FUTURA de 571,79", fut0.some((i) => i.cycleMonth === "2026-11" && i.amount.toFixed(2) === "571.79" && i.component === "future_installments_projected"));
    check("[F] parcela projetada com vencimento (11/11) depois da próxima renda (24/10) ⇒ NÃO comprometida agora", !inc0.some((i) => i.cycleMonth === "2026-11"));
    const model0 = await buildItauModel({ now: NOW, client: tx });

    // ---- B / H. fatura paga ⇒ zero comprometido; pagamento isolado neutro
    await payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
    const f1 = await fm(tx);
    check("[B] fatura fechada e PAGA ⇒ zero comprometido dessa fatura", cardItems(f1, "incurred").length === 0 && f1.incurredLiabilities.toFixed(2) === "0.00");
    check("[H] pagamento integral isolado ⇒ freeMoney delta = 0,00 (caixa −1.795,77; comprometido −1.795,77)", f0.freeMoney.minus(f1.freeMoney).toFixed(2) === "0.00" && f0.unrestrictedCash.minus(f1.unrestrictedCash).toFixed(2) === "1795.77" && f0.incurredLiabilities.minus(f1.incurredLiabilities).toFixed(2) === "1795.77", `${f0.freeMoney} → ${f1.freeMoney}`);
    check("[C] depois de pagar, os 571,79 seguem FUTUROS e visíveis (não comprometidos)", cardItems(f1, "future").some((i) => i.cycleMonth === "2026-11" && i.amount.toFixed(2) === "571.79") && !cardItems(f1, "incurred").length);

    // ---- I. projeções do cartão inalteradas visualmente
    const model1 = await buildItauModel({ now: NOW, client: tx });
    const rowsOf = (m) => m.futureBills.map((r) => `${r.cycleMonth}:${r.total}`).join(" ");
    const fromNov = (m) => m.futureBills.filter((r) => r.cycleMonth >= "2026-11" && r.total > 0).map((r) => `${r.cycleMonth}:${r.total}`).join(" ");
    check("[I] cronograma de faturas futuras (a partir de novembro) IDÊNTICO antes/depois do pagamento: 571,79 · 93,84 · 93,84 · 60,60 — nada some da projeção", fromNov(model0) === fromNov(model1) && fromNov(model1) === "2026-11:571.79 2026-12:93.84 2027-01:93.84 2027-02:60.6" && model1.currentBill.total === 571.79, `${fromNov(model0)} | ${fromNov(model1)}`);

    // ---- D / E. compra REAL pós-fechamento de R$100 (vence na fatura de novembro, depois da próxima renda) ⇒ comprometida já
    await tx.expense.create({ data: { amount: "100", description: "compra real 08/10", category: "Outros", cardId: w.card.id, occurredAt: d("2026-10-08T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
    await syncStored(tx, w.card);
    const f2 = await fm(tx);
    const inc2 = cardItems(f2, "incurred");
    check("[D] compra real pós-fechamento de R$ 100 ⇒ comprometido +100 IMEDIATAMENTE", f2.incurredLiabilities.toFixed(2) === "100.00" && inc2.length === 1 && inc2[0].cycleMonth === "2026-11" && inc2[0].amount.toFixed(2) === "100.00" && inc2[0].component === "post_close_real", JSON.stringify(inc2.map((i) => [i.cycleMonth, i.amount.toFixed(2)])));
    check("[D] freeMoney cai exatamente 100,00 por essa compra", f1.freeMoney.minus(f2.freeMoney).toFixed(2) === "100.00");
    check("[E] ...mesmo com vencimento (11/11) depois da próxima renda (24/10): o corte é a ORIGEM econômica, não o vencimento", inc2[0].dueAt > NEXT_INCOME);
    check("[E] a parte projetada (571,79) continua FUTURA ao lado da compra real (a fatura 2026-11 passa a 671,79 = 100 real + 571,79 projetado)", cardItems(f2, "future").some((i) => i.cycleMonth === "2026-11" && i.amount.toFixed(2) === "571.79") && (await buildItauModel({ now: NOW, client: tx })).currentBill.total === 671.79);

    // ---- E2. compra parcelada REAL feita depois do fechamento: só a 1ª parcela (que cai em novembro) é incorrida agora
    const p = await tx.purchase.create({ data: { description: "compra parcelada real 08/10", totalAmount: "90", installmentCount: 3, installmentValue: "30", category: "Outros", cardId: w.card.id, firstInstallmentMonth: "2026-11", purchasedAt: d("2026-10-08T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
    await tx.installment.createMany({ data: [{ purchaseId: p.id, number: 1, amount: "30", billMonth: "2026-11" }, { purchaseId: p.id, number: 2, amount: "30", billMonth: "2026-12" }, { purchaseId: p.id, number: 3, amount: "30", billMonth: "2027-01" }] });
    await syncStored(tx, w.card);
    const f3 = await fm(tx);
    check("[E2] compra parcelada real pós-fechamento: 1ª parcela (30) entra como incorrida (130 = 100 + 30); as demais seguem futuras", f3.incurredLiabilities.toFixed(2) === "130.00" && sum(cardItems(f3, "incurred")) === 130 && sum(cardItems(f3, "future").filter((i) => i.cycleMonth === "2026-12")) === 123.84, `${f3.incurredLiabilities} | dez futuro=${sum(cardItems(f3, "future").filter((i) => i.cycleMonth === "2026-12"))}`);

    // ---- G. parcela projetada com vencimento ANTES da próxima renda: segue futura (não vira "incurred" só pelo vencimento)
    await tx.expense.deleteMany({ where: { description: "compra real 08/10" } });
    await tx.installment.deleteMany({ where: { purchaseId: p.id } });
    await tx.purchase.delete({ where: { id: p.id } });
    await tx.cardBill.update({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-11" } }, data: { dueAt: d("2026-10-20T00:00:00Z") } });
    await syncStored(tx, w.card);
    const f4 = await fm(tx);
    check("[G] parcela projetada com vencimento ANTES da próxima renda: não é classificada como incorrida só pelo vencimento", f4.incurredLiabilities.toFixed(2) === "0.00" && f1.freeMoney.minus(f4.freeMoney).toFixed(2) === "0.00" && cardItems(f4, "future").some((i) => i.cycleMonth === "2026-11" && i.amount.toFixed(2) === "571.79"));
    await tx.cardBill.update({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-11" } }, data: { dueAt: d("2026-11-11T00:00:00Z") } });

    // ---- observação do banco numa fatura ABERTA: valor observado (+ lançado depois) são compras reais => incorridos (regra anterior preservada)
    await tx.cardBillReconciliation.create({ data: { cardId: w.card.id, cycleMonth: "2026-11", observedTotal: "800", calculatedTotal: "571.79", delta: "228.21", occurredAt: d("2026-10-08T12:00:00Z") } });
    const f5 = await fm(tx);
    check("[obs] fatura ABERTA com valor observado no banco: o observado (800) é compra real ⇒ incorrido", f5.incurredLiabilities.toFixed(2) === "800.00" && f1.freeMoney.minus(f5.freeMoney).toFixed(2) === "800.00", JSON.stringify([f5.incurredLiabilities.toFixed(2), cardItems(f5, "incurred").map((i) => [i.cycleMonth, i.amount.toFixed(2), i.component]), cardItems(f5, "future").map((i) => [i.cycleMonth, i.amount.toFixed(2)])]));
  });

  // ---- A (variação): duas faturas fechadas e não pagas ⇒ AMBAS incorridas (não só a primeira)
  await inWorld(async (tx, w) => {
    const NOV = d("2026-11-10T15:00:00Z");
    const f = await computeFreeMoney({ now: NOV, accounts: await listAccountsWithBalances({ client: tx }), nextIncomeDate: d("2026-11-24T00:00:00Z"), client: tx });
    const inc = cardItems(f, "incurred");
    check("[A] duas faturas fechadas e não pagas (outubro 1.795,77 + novembro 571,79) ⇒ ambas incorridas", inc.length === 2 && f.incurredLiabilities.toFixed(2) === "2367.56" && inc.every((i) => i.component === "closed_unpaid"), JSON.stringify(inc.map((i) => [i.cycleMonth, i.amount.toFixed(2)])));
  });

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
}

try {
  await main();
} catch (e) {
  fail++;
  console.log("❌ erro inesperado:", e);
} finally {
  await prisma.$disconnect();
}
process.exit(fail === 0 ? 0 : 1);
