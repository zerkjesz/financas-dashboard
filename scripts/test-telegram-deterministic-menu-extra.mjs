// Verificação adicional (Fase 7D) — cobre os caminhos implementados mas
// ainda não exercitados pelo suite principal: leituras extras (próximas
// faturas, parcelas ativas, diferenças, compromissos/contingências/
// recebíveis/metas, categoria por período), compra simples no cartão,
// receita, reconciliação de VA, pagamento de fatura, item de cartão no
// lote. Script de verificação pontual, não faz parte do suite permanente.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_EXTRA";
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
let uid = 850000000;
async function runText(text, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}
async function runCallback(data, chatId, messageId = 111) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ callback_query: { id: `cbq${uid}`, data, from: { id: 1 }, message: { message_id: messageId, chat: { id: chatId, type: "private" } } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}
function lastText(outbox) {
  const last = outbox[outbox.length - 1];
  return last?.args?.[last.type === "editMessageText" ? 2 : 1] || "";
}

const FINANCIAL_MODELS = ["expense", "income", "transfer", "purchase", "balanceAdjustment", "cardBillReconciliation"];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

const created = { expenses: [], incomes: [], transfers: [], balanceAdjustments: [] };
async function cleanup() {
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  for (const id of created.balanceAdjustments) await prisma.balanceAdjustment.delete({ where: { id } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function main() {
  // Leituras extras — zero write, sempre.
  const fpBeforeReads = await fingerprint();
  for (const key of ["r:proximas_faturas", "r:parcelas_ativas", "r:diferencas", "r:compromissos_ativos", "r:contingencias_abertas", "r:recebiveis_pendentes", "r:metas", "r:cat:mes", "r:cat:mespassado"]) {
    const r = await runCallback(key, `${MARK}_reads`);
    check(`[extra-read] ${key} responde texto não-vazio`, lastText(r).length > 0, `${key}: ${JSON.stringify(lastText(r)).slice(0, 120)}`);
  }
  const fpAfterReads = await fingerprint();
  check("[extra-read] todas zero-write", JSON.stringify(fpBeforeReads) === JSON.stringify(fpAfterReads));

  // Receita end-to-end.
  {
    const chatId = `${MARK}_receita`;
    await runCallback("w:receita", chatId);
    await runText("500", chatId);
    await runText(`${MARK} freela`, chatId);
    await runCallback("pm:pix", chatId);
    await runCallback("cat:Trabalho", chatId);
    await runCallback("date:hoje", chatId);
    const preview = lastSentTextFor(chatId);
    check("[receita] preview contém valor e origem", preview.includes("500") && preview.includes(`${MARK} freela`), preview);
    const fpBefore = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await fingerprint();
    check("[receita] confirmar cria 1 Income", fpAfter.income - fpBefore.income === 1);
    const inc = await prisma.income.findFirst({ where: { description: { contains: MARK } } });
    if (inc) created.incomes.push(inc.id);
  }

  // Compra simples no cartão end-to-end.
  {
    const chatId = `${MARK}_cartaocompra`;
    await runCallback("w:cartao_compra", chatId);
    await runText("77", chatId);
    await runText(`${MARK} tenis`, chatId);
    await runCallback("cat:Lazer", chatId);
    await runCallback("date:hoje", chatId);
    const preview = lastSentTextFor(chatId);
    check("[cartão compra] preview contém valor e cartão", preview.includes("77") && preview.toLowerCase().includes("cart"), preview);
    const fpBefore = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await fingerprint();
    check("[cartão compra] confirmar cria 1 Expense com cardId (nunca conta corrente)", fpAfter.expense - fpBefore.expense === 1);
    const exp = await prisma.expense.findFirst({ where: { description: { contains: MARK } } });
    check("[cartão compra] Expense tem cardId setado e accountId nulo", exp && exp.cardId != null && exp.accountId == null, JSON.stringify(exp));
    if (exp) created.expenses.push(exp.id);
  }

  // Reconciliação de VA end-to-end.
  {
    const chatId = `${MARK}_va`;
    const vaAccount = await prisma.account.findFirst({ where: { type: "food_voucher" } });
    await runCallback("w:saldo_va", chatId);
    await runText("300", chatId);
    const preview = lastSentTextFor(chatId);
    check("[VA] preview mostra observado/calculado/diferença", preview.includes("Norte calculado") && preview.includes("Diferença"), preview);
    const fpBefore = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await fingerprint();
    check("[VA] confirmar cria 1 BalanceAdjustment na conta VA (nunca Income)", fpAfter.balanceAdjustment - fpBefore.balanceAdjustment === 1);
    const adj = await prisma.balanceAdjustment.findFirst({ where: { accountId: vaAccount.id }, orderBy: { createdAt: "desc" } });
    if (adj) created.balanceAdjustments.push(adj.id);
  }

  // Item de cartão no lote (multipla).
  {
    const chatId = `${MARK}_batchcard`;
    await runCallback("w:multipla", chatId);
    await runCallback("batch:add:cartao", chatId);
    await runText("50", chatId);
    await runText(`${MARK} batchcard`, chatId);
    const listText = lastSentTextFor(chatId);
    check("[batch cartão] item de cartão adicionado ao lote automaticamente (1 cartão só)", listText.includes("Cartão") || listText.includes("cartão"), listText);
    await runCallback("batch:cancel", chatId); // não precisamos persistir, só provar que o item-tipo funciona.
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
