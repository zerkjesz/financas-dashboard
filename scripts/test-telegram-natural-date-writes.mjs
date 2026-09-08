// Fase 5.3D — itens 19(J)/20(I)/20(K)/24: pre-snapshot backfill safety,
// retrospective card purchase cycle, transfer date consistency, unauthorized
// read proof. Fixtures 100% sintéticas (MARK="TESTE_NATURALDATE_53D"),
// create+cleanup garantido por finally.
//
// TEMPORARY_SYNTHETIC_TEST_WRITES = YES
// ZERO_REAL_USER_FINANCIAL_WRITES = YES
// FINAL_REAL_FINANCIAL_STATE_DIFF = ZERO
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { commitBotIntent } from "../lib/commitBotIntent.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";

const MARK = "TESTE_NATURALDATE_53D";
const BASE_URL = process.env.SECURITY_TEST_BASE_URL || "http://localhost:3001";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

async function serverReachable() {
  try {
    await fetch(BASE_URL, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("--- Fase 5.3D: pre-snapshot backfill / retrospective purchase / transfer date / unauthorized read ---\n");

  const account = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-acc-${Date.now()}`, name: `${MARK} conta`, type: "checking" } });
  const account2 = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-acc2-${Date.now()}`, name: `${MARK} conta2`, type: "cash" } });
  const card = await prisma.card.create({ data: { slug: `${MARK.toLowerCase()}-card-${Date.now()}`, name: `${MARK} cartão`, totalLimit: money(1000), dueDay: 10 } });

  try {
    // ==========================================================================
    // Item 19/23 — HISTORICAL SNAPSHOT SAFETY: um Expense com occurredAt
    // ANTES do anchor (BalanceAdjustment) não pode alterar o saldo ao vivo —
    // computeAccountBalance é ancorado, nunca soma antes do anchor.
    // ==========================================================================
    console.log("--- Pre-snapshot backfill safety (item 19/23) ---");
    const snapshotAt = new Date("2026-09-04T23:20:26.000Z"); // formato/hora do snapshot real, valor fictício aqui.
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money(1000), source: "manual", occurredAt: snapshotAt } });

    const balanceBeforeBackfill = await computeAccountBalance(account.id);
    check(compareMoney(balanceBeforeBackfill, money(1000)) === 0, "[snapshot] saldo ao vivo = valor do anchor, antes de qualquer backfill", balanceBeforeBackfill.toString());

    const preSnapshotDate = new Date("2026-08-20T12:00:00.000Z"); // antes do anchor.
    await prisma.expense.create({
      data: { amount: money(50), description: `${MARK} backfill pre-snapshot`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED", occurredAt: preSnapshotDate },
    });

    const balanceAfterBackfill = await computeAccountBalance(account.id);
    check(
      compareMoney(balanceAfterBackfill, money(1000)) === 0,
      "[snapshot] Expense com occurredAt ANTES do anchor NÃO altera o saldo ao vivo (ancoragem funciona)",
      `esperado=1000 obtido=${balanceAfterBackfill.toString()}`
    );

    // Contraste: um Expense DEPOIS do anchor SIM afeta o saldo — prova que a
    // ancoragem discrimina corretamente por data, não é "ignora tudo".
    const postSnapshotDate = new Date("2026-09-05T12:00:00.000Z");
    await prisma.expense.create({
      data: { amount: money(30), description: `${MARK} pos-snapshot`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED", occurredAt: postSnapshotDate },
    });
    const balanceAfterPostSnapshot = await computeAccountBalance(account.id);
    check(
      compareMoney(balanceAfterPostSnapshot, money(970)) === 0,
      "[snapshot] Expense DEPOIS do anchor SIM reduz o saldo ao vivo (1000 - 30 = 970) — ancoragem é seletiva, não um bug que ignora tudo",
      balanceAfterPostSnapshot.toString()
    );

    // ==========================================================================
    // Item 20(I)/25 — RETROSPECTIVE CARD PURCHASE: economic date determina o
    // ciclo/mês, nunca `new Date()` incondicional.
    // ==========================================================================
    console.log("\n--- Retrospective card purchase usa o ciclo da data econômica (item 20/25) ---");
    const retroPurchaseDate = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 15)); // ano passado, janeiro — garantidamente um mês diferente de "hoje".
    const expectedCycle = getCardCycleForDate(card, retroPurchaseDate);
    const todayCycle = getCardCycleForDate(card, new Date());
    check(expectedCycle !== todayCycle, "[setup] a data retrospectiva de teste cai num ciclo DIFERENTE de hoje (senão o teste não provaria nada)", `${expectedCycle} vs ${todayCycle}`);

    const { record: purchase } = await commitBotIntent("installment_purchase", {
      amount: 300, installmentCount: 3, category: "Outros", description: `${MARK} compra retroativa`,
      rawMessage: "teste", target: { type: "card", card }, occurredAt: retroPurchaseDate,
    }, { source: "manual" });

    check(purchase.firstInstallmentMonth === expectedCycle, "[retro purchase] firstInstallmentMonth usa o ciclo da data ECONÔMICA, nunca o de hoje", `obtido=${purchase.firstInstallmentMonth} esperado=${expectedCycle}`);
    check(new Date(purchase.purchasedAt).getTime() === retroPurchaseDate.getTime(), "[retro purchase] purchasedAt = data econômica exata, não a data de ingestão da mensagem");

    // ==========================================================================
    // Item 20(K)/28 — TRANSFER: mesma data econômica pros 2 lados (garantido
    // estruturalmente por ser 1 única row, mas testado explicitamente).
    // ==========================================================================
    console.log("\n--- Transfer: mesma data econômica nos 2 lados (item 20/28) ---");
    const transferDate = new Date("2026-08-10T00:00:00.000Z");
    const { record: transfer } = await commitBotIntent("transfer", {
      amount: 25, description: `${MARK} transfer retro`, rawMessage: "sem mencao de conta", target: null, occurredAt: transferDate,
    }, { source: "manual" });
    check(new Date(transfer.occurredAt).getTime() === transferDate.getTime(), "[transfer] occurredAt (comum aos 2 lados, 1 única row) = data econômica exata");

    // ==========================================================================
    // Item 24 — UNAUTHORIZED READ nunca vaza dado financeiro.
    // ==========================================================================
    console.log("\n--- Unauthorized read não vaza dado (item 24) ---");
    if (!WEBHOOK_SECRET || !ALLOWED_USER_ID) {
      console.log("⚠️  TELEGRAM_WEBHOOK_SECRET/TELEGRAM_ALLOWED_USER_ID não configurados — pulando prova HTTP de unauthorized read.");
    } else if (!(await serverReachable())) {
      console.log(`⚠️  Servidor não acessível em ${BASE_URL} — pulando prova HTTP de unauthorized read.`);
    } else {
      const wrongUserId = Number(ALLOWED_USER_ID) + 1;
      const fakeUpdateId = 993_000_000_000 + Date.now();
      const res = await fetch(`${BASE_URL}/api/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
        body: JSON.stringify({ update_id: fakeUpdateId, message: { chat: { id: wrongUserId, type: "private" }, from: { id: wrongUserId }, text: "qual meu saldo?" } }),
      });
      const body = await res.json().catch(() => ({}));
      check(body.status === "rejected_unauthorized_sender", "[unauthorized read] sender errado perguntando 'qual meu saldo?' -> rejected_unauthorized_sender, NUNCA chega no read handler", `status=${body.status}`);
      const bodyText = JSON.stringify(body);
      check(!/R\$|\d{1,3}[.,]\d{2}/.test(bodyText), "[unauthorized read] resposta HTTP não contém nenhum valor monetário formatado (nada vazou)");
    }

    console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  } finally {
    await prisma.installment.deleteMany({ where: { purchase: { description: { contains: MARK } } } });
    await prisma.purchase.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.expense.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.transfer.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.balanceAdjustment.deleteMany({ where: { accountId: account.id } });
    await prisma.card.deleteMany({ where: { id: card.id } });
    await prisma.account.deleteMany({ where: { id: { in: [account.id, account2.id] } } });
    const leftover = await prisma.account.count({ where: { name: { contains: MARK } } });
    console.log(`Limpeza: ${leftover} accounts de teste remanescentes (esperado 0).`);
    await prisma.$disconnect();
    if (failed > 0 || leftover > 0) process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
