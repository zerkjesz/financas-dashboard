// Fase 7D.1, item 6/14-D/14-E — lote (multipla) com os 5 tipos de item
// (despesa/receita/cartão/parcelado/transferência), sucesso atômico E falha
// atômica (zero persistência quando qualquer item falha).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_BATCH5";
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
let uid = 890000000;
async function runText(text, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}
async function runCallback(data, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ callback_query: { id: `c${uid}`, data, from: { id: 1 }, message: { message_id: 1, chat: { id: chatId, type: "private" } } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}

const FINANCIAL_MODELS = ["expense", "income", "transfer", "purchase", "installment"];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

const created = { expenses: [], incomes: [], transfers: [], purchases: [] };
async function cleanup() {
  for (const id of created.purchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id } }).catch(() => {});
  }
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  const strayPurchases = await prisma.purchase.findMany({ where: { description: { contains: MARK } } });
  for (const p of strayPurchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function buildMixedBatch(chatId) {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  await runCallback("w:multipla", chatId);
  // 1. despesa
  await runCallback("batch:add:despesa", chatId);
  await runText("10", chatId);
  await runText(`${MARK} item1 despesa`, chatId);
  await runCallback("bpm:pix", chatId);
  // 2. receita
  await runCallback("batch:add:receita", chatId);
  await runText("20", chatId);
  await runText(`${MARK} item2 receita`, chatId);
  await runCallback("bpm:pix", chatId);
  // 3. cartão
  await runCallback("batch:add:cartao", chatId);
  await runText("30", chatId);
  await runText(`${MARK} item3 cartao`, chatId);
  // 4. parcelado
  await runCallback("batch:add:parcelado", chatId);
  await runText("100", chatId);
  await runText(`${MARK} item4 parcelado`, chatId);
  await runCallback("bqtd:2", chatId);
  // 5. transferência
  await runCallback("batch:add:transferencia", chatId);
  await runText("40", chatId);
  await runText(`${MARK} item5 transferencia`, chatId);
  await runCallback(`acct:${accounts[0].id}`, chatId);
  await runCallback(`acct:${accounts[1].id}`, chatId);
  return lastSentTextFor(chatId);
}

async function main() {
  // D. Lote misto de 5 tipos -> sucesso atômico.
  {
    const chatId = `${MARK}_ok`;
    const listText = await buildMixedBatch(chatId);
    check("[D] lista final mostra os 5 itens", listText.includes("5"), listText);
    check("[D] lista descreve o item parcelado (2x)", listText.includes("2x"), listText);
    check("[D] lista descreve o item transferência (→)", listText.includes("→"), listText);

    await runCallback("batch:review", chatId);
    const reviewText = lastSentTextFor(chatId);
    check("[D] revisão mostra o total (10+20+30+100+40=200)", reviewText.includes("200"), reviewText);

    const fpBefore = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await fingerprint();
    check("[D] Expense +2 (despesa + cartão)", fpAfter.expense - fpBefore.expense === 2, JSON.stringify({ before: fpBefore, after: fpAfter }));
    check("[D] Income +1 (receita)", fpAfter.income - fpBefore.income === 1);
    check("[D] Transfer +1", fpAfter.transfer - fpBefore.transfer === 1);
    check("[D] Purchase +1 (parcelado)", fpAfter.purchase - fpBefore.purchase === 1);
    check("[D] Installment +2 (2x, usa Purchase+Installment oficiais)", fpAfter.installment - fpBefore.installment === 2);

    const purchase = await prisma.purchase.findFirst({ where: { description: { contains: `${MARK} item4` } } });
    if (purchase) created.purchases.push(purchase.id);
    const transfer = await prisma.transfer.findFirst({ where: { description: { contains: `${MARK} item5` } } });
    if (transfer) created.transfers.push(transfer.id);
    const expenses = await prisma.expense.findMany({ where: { description: { contains: MARK } } });
    created.expenses.push(...expenses.map((e) => e.id));
    const incomes = await prisma.income.findMany({ where: { description: { contains: MARK } } });
    created.incomes.push(...incomes.map((i) => i.id));
  }

  // E. Lote misto com erro no ÚLTIMO item (transferência com toAccountId inválido) -> zero writes.
  {
    const chatId = `${MARK}_fail`;
    await buildMixedBatch(chatId);
    // Corrompe o item 5 (transferência, o último) pra forçar erro real no commit.
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    const items = [...session.data.items];
    items[items.length - 1] = { ...items[items.length - 1], toAccountId: "id-invalido-nao-existe" };
    await prisma.botWizardSession.update({ where: { id: session.id }, data: { data: { ...session.data, items } } });

    await runCallback("batch:review", chatId);
    const fpBefore = await fingerprint();
    try {
      await runCallback("confirm:yes", chatId);
    } catch {
      /* esperado: commitBotIntent("transfer",...) lança ao não achar a conta destino */
    }
    const fpAfter = await fingerprint();
    check("[E] ZERO Expense persistida (itens 1/3 do lote, apesar de válidos)", fpAfter.expense === fpBefore.expense, JSON.stringify({ before: fpBefore, after: fpAfter }));
    check("[E] ZERO Income persistida (item 2)", fpAfter.income === fpBefore.income);
    check("[E] ZERO Purchase/Installment persistida (item 4, parcelado)", fpAfter.purchase === fpBefore.purchase && fpAfter.installment === fpBefore.installment);
    check("[E] ZERO Transfer persistida (item 5, o que falhou)", fpAfter.transfer === fpBefore.transfer);
    // Nota: não checa "nenhum item1 no banco" por nome — o caso [D] (rodado
    // antes, no mesmo processo) já criou legitimamente um item1 com essa
    // descrição; o fingerprint scoped acima já prova atomicidade real.
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("💥 Erro:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
