// Fase 7D.1, itens 2-5 — Compromissos/Contingências/Recebíveis/Metas, UI
// completa (criar+listar já existiam; aqui testamos marcar pago/resolvido/
// recebido e editar, sempre via commitBotIntent -> serviço de domínio real,
// nunca Prisma cru).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor, sentMessages } from "../lib/telegramApi.js";

function lastSentButtonsFor(chatId) {
  for (let i = sentMessages.length - 1; i >= 0; i--) {
    if (String(sentMessages[i].chatId) === String(chatId)) return (sentMessages[i].replyMarkup?.inline_keyboard || []).flat().map((b) => b.text);
  }
  return [];
}

const MARK = "TESTE_TG_PLAN";
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
let uid = 880000000;
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
function lastText(outbox) {
  const last = outbox[outbox.length - 1];
  return last?.args?.[last.type === "editMessageText" ? 2 : 1] || "";
}

const created = { commitments: [], contingencies: [], receivables: [], goals: [], expenses: [], incomes: [] };
async function cleanup() {
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  for (const id of created.commitments) await prisma.confirmedCommitment.delete({ where: { id } }).catch(() => {});
  for (const id of created.contingencies) await prisma.contingency.delete({ where: { id } }).catch(() => {});
  for (const id of created.receivables) await prisma.receivable.delete({ where: { id } }).catch(() => {});
  for (const id of created.goals) await prisma.goal.delete({ where: { id } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function main() {
  // ===== COMPROMISSOS =====
  const commitment = await prisma.confirmedCommitment.create({ data: { description: `${MARK} tatuagem`, amount: 300, dueDate: new Date("2026-11-05"), status: "CONFIRMED" } });
  created.commitments.push(commitment.id);

  // Editar (valor).
  {
    const chatId = `${MARK}_cedit`;
    await runCallback("w:compromisso_editar", chatId);
    const buttons = lastSentButtonsFor(chatId);
    check("[compromisso editar] lista mostra o compromisso como botão", buttons.some((b) => b.includes(`${MARK} tatuagem`)), JSON.stringify(buttons));
    await runCallback(`cedit:${commitment.id}`, chatId);
    await runCallback("cfield:amount", chatId);
    await runText("350", chatId);
    const preview = lastSentTextFor(chatId);
    check("[compromisso editar] preview mostra 300 -> 350", preview.includes("300") && preview.includes("350"), preview);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.confirmedCommitment.findUnique({ where: { id: commitment.id } });
    check("[compromisso editar] valor atualizado via updateCommitmentDetails", Number(updated.amount) === 350);
    check("[compromisso editar] status continua CONFIRMED (FUNDED != SETTLED preservado)", updated.status === "CONFIRMED");
  }

  // Marcar como pago.
  {
    const chatId = `${MARK}_cpay`;
    const account = await prisma.account.findFirst({ where: { type: "checking" } });
    await runCallback("w:compromisso_pagar", chatId);
    await runCallback(`cpay:${commitment.id}`, chatId);
    const askAccount = lastSentTextFor(chatId);
    check("[compromisso pagar] pergunta a conta", askAccount.toLowerCase().includes("conta"), askAccount);
    await runCallback(`acct:${account.id}`, chatId);
    const preview = lastSentTextFor(chatId);
    check("[compromisso pagar] preview mostra valor e conta", preview.includes("350") && preview.includes(account.name), preview);
    const fpBefore = await prisma.expense.count();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await prisma.expense.count();
    check("[compromisso pagar] cria exatamente 1 Expense real (settleCommitmentCreatingExpense)", fpAfter - fpBefore === 1);
    const final = await prisma.confirmedCommitment.findUnique({ where: { id: commitment.id } });
    check("[compromisso pagar] status vira SETTLED (só agora, nunca antes)", final.status === "SETTLED");
    check("[compromisso pagar] expenseId vinculado", final.expenseId != null);
    const exp = await prisma.expense.findUnique({ where: { id: final.expenseId } });
    if (exp) created.expenses.push(exp.id);
  }

  // ===== CONTINGÊNCIAS =====
  const contingency = await prisma.contingency.create({ data: { description: `${MARK} conserto carro`, maxAmount: 600, status: "AWAITING_INFORMATION" } });
  created.contingencies.push(contingency.id);

  // Atualizar (maxAmount).
  {
    const chatId = `${MARK}_gedit`;
    await runCallback("w:contingencia_editar", chatId);
    await runCallback(`cgeditpick:${contingency.id}`, chatId);
    await runText("700", chatId);
    const preview = lastSentTextFor(chatId);
    check("[contingência editar] preview mostra novo máximo", preview.includes("700"), preview);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.contingency.findUnique({ where: { id: contingency.id } });
    check("[contingência editar] maxAmount atualizado via updateContingencyAmount", Number(updated.maxAmount) === 700);
  }

  // Resolver (confirmar que aconteceu).
  {
    const chatId = `${MARK}_gresolve`;
    await runCallback("w:contingencia_resolver", chatId);
    await runCallback(`cgpick:${contingency.id}`, chatId);
    const askStatus = lastSentTextFor(chatId);
    check("[contingência resolver] pergunta o que aconteceu", askStatus.toLowerCase().includes("aconteceu"), askStatus);
    await runCallback("cgstatus:CONFIRMED", chatId);
    await runCallback("confirm:yes", chatId);
    const resolved = await prisma.contingency.findUnique({ where: { id: contingency.id } });
    check("[contingência resolver] status vira CONFIRMED via updateContingencyStatus", resolved.status === "CONFIRMED");
  }

  // ===== VALORES A RECEBER =====
  const receivable = await prisma.receivable.create({ data: { description: `${MARK} amigo devendo`, counterparty: "Zé", amount: 150, status: "PENDING" } });
  created.receivables.push(receivable.id);

  // Editar (amount).
  {
    const chatId = `${MARK}_redit`;
    await runCallback("w:recebivel_editar", chatId);
    await runCallback(`reditpick:${receivable.id}`, chatId);
    await runText("180", chatId);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.receivable.findUnique({ where: { id: receivable.id } });
    check("[recebível editar] valor atualizado via updateReceivableDetails", Number(updated.amount) === 180);
    check("[recebível editar] continua PENDING (nunca virou Income antecipadamente)", updated.status === "PENDING");
  }

  // Marcar recebido.
  {
    const chatId = `${MARK}_rreceive`;
    const account = await prisma.account.findFirst({ where: { type: "checking" } });
    await runCallback("w:recebivel_receber", chatId);
    await runCallback(`rpick:${receivable.id}`, chatId);
    await runCallback(`acct:${account.id}`, chatId);
    const fpBefore = await prisma.income.count();
    await runCallback("confirm:yes", chatId);
    const fpAfter = await prisma.income.count();
    check("[recebível receber] cria exatamente 1 Income real (markReceivableReceived)", fpAfter - fpBefore === 1);
    const final = await prisma.receivable.findUnique({ where: { id: receivable.id } });
    check("[recebível receber] status vira RECEIVED", final.status === "RECEIVED");
    check("[recebível receber] incomeId vinculado (nunca dois Income pro mesmo recebível)", final.incomeId != null);
    const inc = await prisma.income.findUnique({ where: { id: final.incomeId } });
    if (inc) created.incomes.push(inc.id);
  }

  // ===== METAS =====
  // Nova meta.
  {
    const chatId = `${MARK}_gnew`;
    await runCallback("w:meta_nova", chatId);
    await runText(`${MARK} Notebook`, chatId);
    await runText("5000", chatId);
    const preview = lastSentTextFor(chatId);
    check("[meta nova] preview mostra nome e valor alvo", preview.includes(`${MARK} Notebook`) && preview.includes("5.000") || preview.includes("5000"), preview);
    await runCallback("confirm:yes", chatId);
    const goal = await prisma.goal.findFirst({ where: { name: `${MARK} Notebook` } });
    check("[meta nova] Goal criada de verdade", goal != null && Number(goal.targetAmount) === 5000);
    if (goal) created.goals.push(goal.id);
  }

  // Editar meta.
  {
    const chatId = `${MARK}_gedit2`;
    const goal = created.goals[0] ? await prisma.goal.findUnique({ where: { id: created.goals[0] } }) : null;
    check("[meta editar] fixture de meta existe", goal != null);
    if (goal) {
      await runCallback("w:meta_editar", chatId);
      await runCallback(`gpick:${goal.id}`, chatId);
      await runText("6000", chatId);
      await runCallback("confirm:yes", chatId);
      const updated = await prisma.goal.findUnique({ where: { id: goal.id } });
      check("[meta editar] targetAmount atualizado via updateGoalTargetAmount", Number(updated.targetAmount) === 6000);
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
