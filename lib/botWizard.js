import { prisma } from "./prisma.js";
import { CATEGORIES } from "./categoryRules.js";
import { extractAmount } from "./amountExtractor.js";
import { resolveDate } from "./naturalDate.js";
import { createBill } from "./bills.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { sendMessage, editMessageText, buildInlineKeyboard, chunk } from "./telegramApi.js";

const WIZARD_TTL_MS = 20 * 60 * 1000;

const QUICK_DUE_OPTIONS = [
  { text: "Hoje", value: "hoje" },
  { text: "Amanhã", value: "amanha" },
  { text: "Dia 10", value: "dia 10" },
  { text: "Dia 15", value: "dia 15" },
  { text: "Dia 20", value: "dia 20" },
  { text: "Fim do mês", value: "fim do mes" },
];

export async function isInWizard(chatId) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  if (session.expiresAt <= new Date()) {
    await prisma.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    return false;
  }
  return true;
}

export async function startWizard(chatId, flow) {
  if (flow !== "nova_conta") throw new Error(`Fluxo de assistente desconhecido: ${flow}`);

  await prisma.botWizardSession.deleteMany({ where: { chatId } });
  const session = await prisma.botWizardSession.create({
    data: { chatId, flow, step: "categoria", data: {}, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });

  const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
  const sent = await sendMessage(chatId, "Nova conta a pagar 📋\n\nQue categoria?", { replyMarkup: keyboard });
  if (sent?.result?.message_id) {
    await prisma.botWizardSession.update({ where: { id: session.id }, data: { messageId: sent.result.message_id } });
  }
}

async function updateStep(session, step, dataPatch) {
  const data = { ...session.data, ...dataPatch };
  await prisma.botWizardSession.update({
    where: { id: session.id },
    data: { step, data, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });
  session.step = step;
  session.data = data;
  return session;
}

async function finishToConfirm(session) {
  const dueDate = session.data.pendingDate ? new Date(session.data.pendingDate) : null;
  if (!dueDate) {
    await updateStep(session, "vencimento_texto", {});
    await editMessageText(session.chatId, session.messageId, "Não entendi essa data. Digite de novo (ex: \"dia 25\", \"mês que vem\"):");
    return;
  }
  await updateStep(session, "confirmar", { dueDateISO: dueDate.toISOString() });
  const summary = [
    "Confirma?",
    "",
    `📋 ${session.data.description}`,
    `💰 ${formatMoney(session.data.amount)}`,
    `📅 ${formatDate(dueDate)}`,
    `🏷️ ${session.data.category}`,
  ].join("\n");
  const keyboard = buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]);
  await editMessageText(session.chatId, session.messageId, summary, { replyMarkup: keyboard });
}

export async function handleWizardCallback(chatId, callbackData) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return;

  if (session.step === "categoria" && callbackData.startsWith("cat:")) {
    const category = callbackData.slice(4);
    await updateStep(session, "descricao", { category });
    await editMessageText(chatId, session.messageId, `Categoria: ${category}\n\nQual a descrição? (ex: Internet, aluguel...)`);
    return;
  }

  if (session.step === "vencimento" && callbackData.startsWith("due:")) {
    const value = callbackData.slice(4);
    if (value === "outra") {
      await updateStep(session, "vencimento_texto", {});
      await editMessageText(chatId, session.messageId, "Digite a data (ex: \"dia 25\", \"mês que vem\"):");
      return;
    }
    const dueDate = await resolveDate(value);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null });
    await finishToConfirm(session);
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:yes") {
    const bill = await createBill({
      description: session.data.description,
      amount: session.data.amount,
      category: session.data.category,
      dueDate: new Date(session.data.dueDateISO),
      source: "telegram",
      rawMessage: "/contas-novas (assistente guiado)",
    });
    await prisma.botWizardSession.delete({ where: { id: session.id } });
    await editMessageText(chatId, session.messageId, `✅ Conta "${bill.description}" criada: ${formatMoney(bill.amount)}, vence em ${formatDate(bill.dueDate)}.`);
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:no") {
    await prisma.botWizardSession.delete({ where: { id: session.id } });
    await editMessageText(chatId, session.messageId, "Cancelado.");
    return;
  }
}

export async function handleWizardText(chatId, text) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;

  if (session.step === "descricao") {
    await updateStep(session, "valor", { description: text.trim() });
    await editMessageText(chatId, session.messageId, `Descrição: ${text.trim()}\n\nQuanto é?`);
    return true;
  }

  if (session.step === "valor") {
    const { amount } = extractAmount(text);
    if (amount == null) {
      await sendMessage(chatId, "Não entendi o valor. Manda só o número, tipo \"117,30\".");
      return true;
    }
    await updateStep(session, "vencimento", { amount });
    const keyboard = buildInlineKeyboard([
      ...chunk(QUICK_DUE_OPTIONS.map((o) => ({ text: o.text, data: `due:${o.value}` })), 2),
      [{ text: "Outra data", data: "due:outra" }],
    ]);
    await editMessageText(chatId, session.messageId, `Valor: ${formatMoney(amount)}\n\nVence quando?`, { replyMarkup: keyboard });
    return true;
  }

  if (session.step === "vencimento_texto") {
    const dueDate = await resolveDate(text);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null });
    await finishToConfirm(session);
    return true;
  }

  return true; // dentro do assistente mas num passo que só aceita botão — ignora o texto
}
