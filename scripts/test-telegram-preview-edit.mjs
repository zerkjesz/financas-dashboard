// Fase 7D.1, item 7 — "✏️ Editar" no preview de despesa/receita/cartão
// simples/compra parcelada/transferência: altera UM campo sem reiniciar o
// wizard, volta pro preview completo, e a confirmação grava os valores
// editados (nunca os originais).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_EDIT";
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
let uid = 910000000;
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
async function stepOf(chatId) {
  return (await prisma.botWizardSession.findUnique({ where: { chatId } }))?.step;
}

const created = { expenses: [], transfers: [], purchases: [] };
async function cleanup() {
  for (const id of created.purchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id } }).catch(() => {});
  }
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  const stray = await prisma.purchase.findMany({ where: { description: { contains: MARK } } });
  for (const p of stray) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  await prisma.transfer.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function main() {
  // ===== DESPESA (regressão do fluxo original de edição) =====
  {
    const chatId = `${MARK}_gasto`;
    await runCallback("w:gasto", chatId);
    await runText("10", chatId);
    await runText(`${MARK} despesa`, chatId);
    await runCallback("pm:pix", chatId);
    await runCallback("cat:Transporte", chatId);
    await runCallback("date:hoje", chatId);
    await runCallback("editmenu:gasto", chatId);
    await runCallback("editfield:categoria", chatId);
    await runCallback("cat:Lazer", chatId);
    const preview = lastSentTextFor(chatId);
    check("[despesa] editar categoria volta pro preview com Lazer e o resto intacto", preview.includes("Lazer") && preview.includes(`${MARK} despesa`) && preview.includes("10,00"), preview);
    check("[despesa] step voltou pra confirmar", (await stepOf(chatId)) === "confirmar");
    await runCallback("confirm:yes", chatId);
    const exp = await prisma.expense.findFirst({ where: { description: `${MARK} despesa` } });
    check("[despesa] Expense gravada com a categoria EDITADA", exp?.category === "Lazer", exp?.category);
  }

  // ===== CARTÃO SIMPLES =====
  {
    const chatId = `${MARK}_cartao`;
    await runCallback("w:cartao_compra", chatId);
    await runText("77", chatId);
    await runText(`${MARK} tenis`, chatId);
    await runCallback("cat:Lazer", chatId);
    await runCallback("date:hoje", chatId);
    check("[cartão] preview tem botão Editar", (await prisma.botWizardSession.findUnique({ where: { chatId } })) != null);

    await runCallback("editmenu:cartao_compra", chatId);
    await runCallback("editfield:valor", chatId);
    await runText("90", chatId);
    let preview = lastSentTextFor(chatId);
    check("[cartão] editar valor: novo preview mostra R$ 90 e mantém descrição/categoria", preview.includes("90,00") && preview.includes(`${MARK} tenis`) && preview.includes("Lazer"), preview);
    check("[cartão] editar valor: wizard NÃO reiniciou (step=confirmar)", (await stepOf(chatId)) === "confirmar");

    await runCallback("editmenu:cartao_compra", chatId);
    await runCallback("editfield:descricao", chatId);
    await runText(`${MARK} tenis novo`, chatId);
    preview = lastSentTextFor(chatId);
    check("[cartão] editar descrição", preview.includes(`${MARK} tenis novo`) && preview.includes("90,00"), preview);

    await runCallback("editmenu:cartao_compra", chatId);
    await runCallback("editfield:categoria", chatId);
    await runCallback("cat:Saúde", chatId);
    preview = lastSentTextFor(chatId);
    check("[cartão] editar categoria", preview.includes("Saúde"), preview);

    await runCallback("editmenu:cartao_compra", chatId);
    await runCallback("editfield:data", chatId);
    await runCallback("date:ontem", chatId);
    preview = lastSentTextFor(chatId);
    const yesterday = new Date(Date.now() - 86400000);
    check("[cartão] editar data (ontem)", preview.includes(yesterday.toLocaleDateString("pt-BR", { timeZone: "UTC" })), preview);

    await runCallback("editmenu:cartao_compra", chatId);
    await runCallback("editfield:cartao", chatId);
    check("[cartão] editar cartão (só existe 1) volta pro preview sem quebrar", (await stepOf(chatId)) === "confirmar");

    await runCallback("confirm:yes", chatId);
    const exp = await prisma.expense.findFirst({ where: { description: `${MARK} tenis novo` } });
    check("[cartão] Expense final tem TODOS os valores editados (90 / descrição nova / Saúde / cardId)", exp && Number(exp.amount) === 90 && exp.category === "Saúde" && exp.cardId != null && exp.accountId == null, JSON.stringify(exp));
  }

  // ===== PARCELADO (exemplo real do pedido, editado) =====
  {
    const chatId = `${MARK}_parcela`;
    await runCallback("w:parcela", chatId);
    await runText("118,34", chatId);
    await runText(`${MARK} controle do portão`, chatId);
    await runText("Mercado Livre", chatId);
    await runCallback("qtd:2", chatId);
    await runCallback("cat:Outros", chatId);
    await runCallback("date:hoje", chatId);
    let preview = lastSentTextFor(chatId);
    check("[parcela] preview original: 2x de R$ 59,17", preview.includes("2x de") && preview.includes("59,17"), preview);

    await runCallback("editmenu:parcela", chatId);
    await runCallback("editfield:valor", chatId);
    await runText("200", chatId);
    preview = lastSentTextFor(chatId);
    check("[parcela] editar valor total: 200 em 2x de R$ 100,00", preview.includes("200,00") && preview.includes("2x de") && preview.includes("100,00"), preview);

    await runCallback("editmenu:parcela", chatId);
    await runCallback("editfield:parcelas", chatId);
    await runCallback("qtd:4", chatId);
    preview = lastSentTextFor(chatId);
    check("[parcela] editar parcelas: 4x de R$ 50,00", preview.includes("4x de") && preview.includes("50,00"), preview);

    await runCallback("editmenu:parcela", chatId);
    await runCallback("editfield:merchant", chatId);
    await runText("Amazon", chatId);
    preview = lastSentTextFor(chatId);
    check("[parcela] editar loja: Amazon aparece no título", preview.includes("Amazon") && !preview.includes("Mercado Livre"), preview);

    await runCallback("editmenu:parcela", chatId);
    await runCallback("editfield:descricao", chatId);
    await runText(`${MARK} fone`, chatId);
    preview = lastSentTextFor(chatId);
    check("[parcela] editar descrição", preview.includes(`${MARK} fone`), preview);

    await runCallback("editmenu:parcela", chatId);
    await runCallback("editfield:data", chatId);
    await runCallback("date:outra", chatId);
    await runText("08/09/2026", chatId);
    preview = lastSentTextFor(chatId);
    check("[parcela] editar data: 08/09/2026", preview.includes("08/09/2026"), preview);
    check("[parcela] wizard não reiniciou (step=confirmar)", (await stepOf(chatId)) === "confirmar");

    const before = { p: await prisma.purchase.count(), i: await prisma.installment.count() };
    await runCallback("confirm:yes", chatId);
    const after = { p: await prisma.purchase.count(), i: await prisma.installment.count() };
    check("[parcela] confirmar cria 1 Purchase e 4 Installments (valores EDITADOS)", after.p - before.p === 1 && after.i - before.i === 4, JSON.stringify({ before, after }));
    const purchase = await prisma.purchase.findFirst({ where: { description: { contains: `${MARK} fone` } } });
    if (purchase) created.purchases.push(purchase.id);
    check("[parcela] Purchase.totalAmount=200 e installmentCount=4", purchase && Number(purchase.totalAmount) === 200 && purchase.installmentCount === 4, JSON.stringify(purchase));
  }

  // ===== TRANSFERÊNCIA =====
  {
    const chatId = `${MARK}_transf`;
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    check("[transf] fixture tem >= 3 contas (pra trocar origem/destino)", accounts.length >= 3, String(accounts.length));
    if (accounts.length >= 3) {
      const [a, b, c] = accounts;
      await runCallback("w:transferencia", chatId);
      await runText("30", chatId);
      await runCallback(`acct:${a.id}`, chatId);
      await runCallback(`acct:${b.id}`, chatId);
      await runText(`${MARK} transf original`, chatId);
      await runCallback("date:hoje", chatId);

      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:valor", chatId);
      await runText("55", chatId);
      let preview = lastSentTextFor(chatId);
      check("[transf] editar valor", preview.includes("55,00") && preview.includes(a.name) && preview.includes(b.name), preview);

      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:origem", chatId);
      await runCallback(`acct:${c.id}`, chatId);
      preview = lastSentTextFor(chatId);
      check("[transf] editar origem", preview.includes(`${c.name} → ${b.name}`), preview);

      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:destino", chatId);
      await runCallback(`acct:${a.id}`, chatId);
      preview = lastSentTextFor(chatId);
      check("[transf] editar destino", preview.includes(`${c.name} → ${a.name}`), preview);

      // origem = destino é rejeitado (stale click).
      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:origem", chatId);
      await runCallback(`acct:${a.id}`, chatId);
      check("[transf] origem == destino rejeitada (continua esperando escolha)", (await stepOf(chatId)) === "origem");
      await runCallback(`acct:${b.id}`, chatId);

      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:descricao", chatId);
      await runText(`${MARK} transf editada`, chatId);
      preview = lastSentTextFor(chatId);
      check("[transf] editar descrição", preview.includes(`${MARK} transf editada`), preview);

      await runCallback("editmenu:transferencia", chatId);
      await runCallback("editfield:data", chatId);
      await runCallback("date:ontem", chatId);
      check("[transf] editar data mantém step=confirmar", (await stepOf(chatId)) === "confirmar");

      const before = { t: await prisma.transfer.count(), e: await prisma.expense.count() };
      await runCallback("confirm:yes", chatId);
      const after = { t: await prisma.transfer.count(), e: await prisma.expense.count() };
      check("[transf] confirmar cria exatamente 1 Transfer (nunca Expense)", after.t - before.t === 1 && after.e === before.e);
      const tr = await prisma.transfer.findFirst({ where: { description: `${MARK} transf editada` } });
      if (tr) created.transfers.push(tr.id);
      check("[transf] Transfer final com valor/origem/destino EDITADOS (55, b -> a)", tr && Number(tr.amount) === 55 && tr.fromAccountId === b.id && tr.toAccountId === a.id, JSON.stringify(tr));
    }
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
