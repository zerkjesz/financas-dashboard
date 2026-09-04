// Fase 4.1.2, item 1 — teste de integração (branch dev) do cenário EXATO do
// pedido, ponta a ponta via getIncurredLiabilities/getFutureObligations reais
// (não só a função pura resolveCurrentRelevantCardBillId). Cartão SINTÉTICO —
// NUNCA o cartão real. assertTestEnvironment() + cleanup total.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, addMoney, money } from "../lib/money.js";
import { getIncurredLiabilities, getFutureObligations } from "../lib/freeMoney.js";
import { getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";
import { getCardCreditBalance } from "../lib/cardCredit.js";

const MARK = "TESTE_FASE412";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

const created = { cards: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.cards) await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  const leftover = await prisma.card.count({ where: { slug: { contains: "teste-fase412" } } });
  check("cleanup: zero dado de teste restante no banco", leftover === 0, `contagem: ${leftover}`);
}

const NOW = new Date("2026-09-04T00:00:00.000Z"); // exatamente "as of" do pedido
const CARD_CONFIG = { closingDay: 4, dueDay: 11 };

async function run() {
  console.log("--- Teste de integração: Card Liability Gate, cenário exato do pedido (branch dev) — Fase 4.1.2 ---\n");

  const card = await prisma.card.create({
    data: { slug: "teste-fase412-cartao", name: `[${MARK}] Cartão`, totalLimit: 4027, dueDay: CARD_CONFIG.dueDay, closingDay: CARD_CONFIG.closingDay },
  });
  created.cards.push(card.id);

  const cycles = [
    { key: "2026-09", totalAmount: 1859.01, paidAmount: 1859.01, status: "paid" }, // Setembro, PAID
    { key: "2026-10", totalAmount: 716.97, paidAmount: 0, status: "closed" }, // Outubro, unpaid
    { key: "2026-11", totalAmount: 479.38, paidAmount: 0, status: "open" }, // Novembro, unpaid
    { key: "2026-12", totalAmount: 60.6, paidAmount: 0, status: "open" }, // Dezembro, unpaid
    { key: "2027-01", totalAmount: 60.6, paidAmount: 0, status: "open" }, // Janeiro, unpaid
    { key: "2027-02", totalAmount: 60.6, paidAmount: 0, status: "open" }, // Fevereiro, unpaid
  ];
  const billIds = {};
  for (const cycle of cycles) {
    const bill = await prisma.cardBill.create({
      data: {
        cardId: card.id,
        cycleMonth: cycle.key,
        closesAt: getCardBillClosesAt(CARD_CONFIG, cycle.key),
        dueAt: getCardBillDueDate(CARD_CONFIG, cycle.key),
        totalAmount: cycle.totalAmount,
        paidAmount: cycle.paidAmount,
        status: cycle.status,
      },
    });
    billIds[cycle.key] = bill.id;
  }

  const nextIncomeDate = new Date("2026-09-24T00:00:00.000Z"); // irrelevante pra CardBill, mas exigido pela função

  const incurred = await getIncurredLiabilities({ now: NOW, nextIncomeDate });
  const future = await getFutureObligations({ now: NOW, nextIncomeDate });

  // O branch dev tem 1 cartão real com CardBill materializadas reais (ver
  // cabeçalho de teste da Fase 4.1) — em vez de medir por delta, isolamos
  // diretamente os itens que pertencem ao NOSSO cartão sintético (cardId),
  // mais simples e igualmente correto aqui.
  const ourIncurredItems = incurred.items.filter((i) => i.cardId === card.id);
  const ourFutureItems = future.items.filter((i) => i.cardId === card.id);

  check(
    "incurredLiabilities em 04/09/2026 = exatamente 716.97 (a fatura de outubro, não a de setembro paga nem a soma de tudo)",
    ourIncurredItems.length === 1 && ourIncurredItems[0].id === billIds["2026-10"] && eq(ourIncurredItems[0].amount, 716.97),
    JSON.stringify(ourIncurredItems.map((i) => ({ cycleMonth: i.cycleMonth, amount: i.amount.toString() })))
  );

  const futureAmount = ourFutureItems.reduce((sum, i) => addMoney(sum, i.amount), money(0));
  const futureCycles = ourFutureItems.map((i) => i.cycleMonth).sort();
  check(
    "futureObligations inclui novembro (479.38) + dezembro/janeiro/fevereiro (60.60 cada)",
    futureCycles.join(",") === "2026-11,2026-12,2027-01,2027-02" && eq(futureAmount, "661.18"),
    `cycles=${futureCycles.join(",")}, total=${futureAmount.toString()}`
  );

  // Item 4/5: used card limit (1378.15 no cenário real) != incurredLiabilities.
  // Aqui replicamos a distinção com os números do cenário sintético: soma de
  // TODAS as faturas não liquidadas (716.97+479.38+60.60*3 = 1378.15) é o
  // "limite usado" conceitual — bem diferente de incurredLiabilities (716.97).
  const totalUnsettled = addMoney(money(716.97), futureAmount);
  check(
    "soma de TODAS as faturas não liquidadas (~'limite usado', 1378.15) é diferente de incurredLiabilities (716.97) — nunca confundir os dois",
    eq(totalUnsettled, 1378.15) && !eq(totalUnsettled, ourIncurredItems[0].amount),
    `totalNaoLiquidado=${totalUnsettled.toString()}, incurred=${ourIncurredItems[0].amount.toString()}`
  );

  // Item 5: CardCreditMovement não integrado — saldo credor deve ser 0 no
  // cenário (nenhum CardCreditMovement foi criado pra este cartão de teste).
  const creditBalance = await getCardCreditBalance(card.id);
  check("CardCredit balance = 0 no cenário de teste (CardCreditMovement não integrado nesta fase, documentado)", eq(creditBalance, 0), creditBalance.toString());
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checagem(ns) passaram.`);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  exitCode = 1;
}
process.exit(exitCode);
