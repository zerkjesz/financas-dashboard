import { prisma } from "./prisma.js";
import { parseTransaction } from "./parseTransaction.js";
import { commitBotIntent } from "./commitBotIntent.js";
import { resolveDate } from "./naturalDate.js";
import { extractAmount } from "./amountExtractor.js";
import { extractCardFields, extractRecurringBillFields } from "./configExtractors.js";
import { isInWizard, handleWizardText } from "./botWizard.js";

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const YES_RE = /^(s|sim|yes|confirmo|isso|correto|ok)\b/i;
const NO_RE = /^(n|nao|não|no|errado|cancela)\b/i;

// Interpreta e grava uma mensagem de texto livre do Telegram. `chatId` é obrigatório porque
// o fluxo de confirmação (pra mensagens ambíguas) precisa de estado por chat, guardado no
// banco — o webhook de produção roda numa function serverless sem memória entre chamadas.
export async function processTelegramMessage(text, chatId) {
  // O assistente guiado (/contas-novas) tem prioridade — enquanto ativo, toda mensagem do
  // chat pertence a ele, não ao parser normal. Ele mesmo edita/manda a mensagem do Telegram,
  // então não devolve `reply` — o entrypoint não precisa (nem deve) mandar nada de novo.
  if (await isInWizard(chatId)) {
    await handleWizardText(chatId, text);
    return { ok: true, handled: true };
  }

  const pending = await consumePendingIfPresent(chatId, text);
  if (pending) return pending;

  const parsed = await parseTransaction(text);
  if (!parsed) {
    return {
      ok: false,
      reply: 'Não consegui achar um valor nessa mensagem. Tenta algo tipo "50 mercado pix" ou "recebi 200 freela".',
    };
  }

  if (parsed.needsConfirmation) {
    await upsertPending(chatId, parsed);
    return { ok: true, pending: true, reply: parsed.confirmationPrompt };
  }

  const { reply } = await commitBotIntent(parsed.intent, parsed.data, { source: "telegram" });
  return { ok: true, reply };
}

async function upsertPending(chatId, parsed) {
  const payload = JSON.parse(JSON.stringify({ data: parsed.data, pendingSelection: parsed.pendingSelection || null }));
  await prisma.pendingBotMessage.upsert({
    where: { chatId },
    create: {
      chatId,
      intent: parsed.intent,
      parsedPayload: payload,
      promptMessage: parsed.confirmationPrompt,
      rawMessage: parsed.rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
    update: {
      intent: parsed.intent,
      parsedPayload: payload,
      promptMessage: parsed.confirmationPrompt,
      rawMessage: parsed.rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
  });
}

async function consumePendingIfPresent(chatId, text) {
  const pending = await prisma.pendingBotMessage.findUnique({ where: { chatId } });
  if (!pending) return null;

  if (pending.expiresAt <= new Date()) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } }).catch(() => {});
    return null;
  }

  const selection = pending.parsedPayload?.pendingSelection;
  const data = pending.parsedPayload?.data ?? pending.parsedPayload;
  const answer = text.trim();

  if (selection?.type === "provide_date") {
    return resolveProvideDate(pending, data, answer);
  }
  if (selection?.type === "provide_amount") {
    return resolveProvideAmount(pending, data, answer);
  }
  if (selection?.type === "provide_amount_and_date") {
    return resolveProvideAmountAndDate(pending, data, answer);
  }
  if (selection?.type === "choose_bill") {
    return resolveChooseBill(pending, data, selection, answer);
  }
  if (selection?.type === "choose_option") {
    return resolveChooseOption(pending, data, selection, answer);
  }
  if (selection?.type === "provide_card_fields") {
    return resolveProvideCardFields(pending, data, answer);
  }
  if (selection?.type === "provide_recurring_fields") {
    return resolveProvideRecurringFields(pending, data, answer);
  }
  if (selection?.type === "provide_target_amount") {
    return resolveProvideTargetAmount(pending, data, answer);
  }
  if (selection?.type === "choose_goal") {
    return resolveChooseGoal(pending, data, selection, answer);
  }

  return resolveYesNo(pending, data, answer);
}

async function resolveYesNo(pending, data, answer) {
  if (YES_RE.test(answer)) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
    const { reply } = await commitBotIntent(pending.intent, data, { source: "telegram" });
    return { ok: true, reply };
  }
  if (NO_RE.test(answer)) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
    return { ok: false, reply: "Beleza, cancelei o registro. Manda de novo com mais detalhes." };
  }
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  return null; // nem sim nem não: assume que mudou de assunto, processa a mensagem nova
}

async function resolveProvideDate(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const dueDate = await resolveDate(answer);
  if (!dueDate) {
    return { ok: false, reply: "Não entendi a data. Tenta de novo do zero, tipo \"preciso pagar X dia 20\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, dueDate }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveProvideAmount(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  if (amount === null) {
    return { ok: false, reply: "Não entendi o valor. Tenta de novo do zero." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, amount }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveProvideAmountAndDate(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  const dueDate = await resolveDate(answer);
  if (amount === null || !dueDate) {
    return { ok: false, reply: "Não entendi valor e/ou data. Tenta de novo do zero, tipo \"preciso pagar 300 dia 20\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, amount, dueDate }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveProvideCardFields(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const fields = extractCardFields(answer);
  if (fields.totalLimit == null || fields.dueDay == null) {
    return { ok: false, reply: "Ainda faltou o limite e/ou o vencimento. Tenta de novo do zero, tipo \"criar cartão Nubank, limite 5000, vencimento dia 10\"." };
  }
  const merged = { ...data, totalLimit: fields.totalLimit, dueDay: fields.dueDay, closingDay: fields.closingDay ?? data.closingDay };
  const { reply } = await commitBotIntent(pending.intent, merged, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveProvideRecurringFields(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const fields = extractRecurringBillFields(answer);
  if (fields.amount == null || fields.dayOfMonth == null) {
    return { ok: false, reply: "Ainda faltou o valor e/ou o dia. Tenta de novo do zero, tipo \"internet, 117 reais, todo dia 10\"." };
  }
  const merged = { ...data, recurringAmount: fields.amount, dayOfMonth: fields.dayOfMonth };
  const { reply } = await commitBotIntent(pending.intent, merged, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveProvideTargetAmount(pending, data, answer) {
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  if (amount === null) {
    return { ok: false, reply: "Não entendi o valor. Tenta de novo do zero." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, targetAmount: amount }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveChooseGoal(pending, data, selection, answer) {
  const index = parseInt(answer, 10);
  const candidate = Number.isInteger(index) ? selection.candidates[index - 1] : null;
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  if (!candidate) {
    return { ok: false, reply: "Não entendi qual meta. Manda de novo, tipo \"guardei mais 100 pra meta notebook\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, goalId: candidate.id }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveChooseBill(pending, data, selection, answer) {
  const index = parseInt(answer, 10);
  const candidate = Number.isInteger(index) ? selection.candidates[index - 1] : null;
  if (!candidate) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
    return { ok: false, reply: "Não entendi qual conta. Manda de novo, tipo \"paguei aqueles 300 da minha mãe\"." };
  }
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  const { reply } = await commitBotIntent(pending.intent, { ...data, billId: candidate.id }, { source: "telegram" });
  return { ok: true, reply };
}

async function resolveChooseOption(pending, data, selection, answer) {
  const normalized = answer.toLowerCase();
  const index = parseInt(answer, 10);
  const byIndex = Number.isInteger(index) ? selection.options[index - 1] : null;
  const byKeyword = selection.options.find((o) => {
    if (normalized.includes(o.key)) return true;
    const labelWords = o.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return labelWords.some((w) => normalized.includes(w));
  });
  const chosen = byIndex || byKeyword;

  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  if (!chosen) {
    return { ok: false, reply: "Não entendi a opção. Manda de novo com mais detalhes." };
  }

  if (chosen.key === "expense") {
    const { reply } = await commitBotIntent("expense", data, { source: "telegram" });
    return { ok: true, reply };
  }
  const { reply } = await commitBotIntent("pay_bill", { ...data, billId: null }, { source: "telegram" });
  return { ok: true, reply };
}
