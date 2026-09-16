// ============================================================================
// Fase 7.0 — contexto de conversa. REUTILIZA PendingBotMessage (não criou
// model novo — item 3 do pedido: "só criar migration/schema novo se for
// realmente necessário", e este cabe perfeitamente: chatId único, payload
// JSON livre, já tem expiresAt). intent="financial_ai_plan" identifica que
// o pending pertence a ESTE pipeline (nunca colide com os intents do
// parser antigo — wizard/pending de outros tipos continuam intocados).
// ============================================================================
import { prisma } from "../prisma.js";

const PENDING_INTENT = "financial_ai_plan";
const PENDING_TTL_MS = 15 * 60 * 1000;
const RECENT_APPLIED_LIMIT = 5;
const RECENT_APPLIED_WINDOW_HOURS = 24;

export async function loadPendingPlan(chatId, { client = prisma } = {}) {
  const pending = await client.pendingBotMessage.findUnique({ where: { chatId } });
  if (!pending || pending.intent !== PENDING_INTENT) return null;
  if (pending.expiresAt < new Date()) return null;
  return pending;
}

export async function savePendingPlan(chatId, { plan, rawMessage, promptMessage, confirmationReason }, { client = prisma } = {}) {
  return client.pendingBotMessage.upsert({
    where: { chatId },
    create: {
      chatId,
      intent: PENDING_INTENT,
      parsedPayload: { plan, confirmationReason },
      promptMessage,
      rawMessage,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    },
    update: {
      intent: PENDING_INTENT,
      parsedPayload: { plan, confirmationReason },
      promptMessage,
      rawMessage,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    },
  });
}

export async function clearPendingPlan(chatId, { client = prisma } = {}) {
  await client.pendingBotMessage.deleteMany({ where: { chatId, intent: PENDING_INTENT } });
}

// Fase 7.0.1, item 3 — mesma linha/intent que um pending de plano (chatId é
// @unique, então só existe UM pending por vez — nunca colide com um plano
// pendente), só que `parsedPayload` guarda um descritor de correção/exclusão/
// desfazer em vez de um `plan`. handlePendingConfirmationShortcut (pipeline.js)
// distingue os dois formatos e despacha pro fluxo certo. Limpa com a MESMA
// clearPendingPlan (ela só filtra por chatId+intent, funciona pros dois formatos).
export async function savePendingCorrection(chatId, { correction, rawMessage, promptMessage }, { client = prisma } = {}) {
  return client.pendingBotMessage.upsert({
    where: { chatId },
    create: { chatId, intent: PENDING_INTENT, parsedPayload: { correction }, promptMessage, rawMessage, expiresAt: new Date(Date.now() + PENDING_TTL_MS) },
    update: { intent: PENDING_INTENT, parsedPayload: { correction }, promptMessage, rawMessage, expiresAt: new Date(Date.now() + PENDING_TTL_MS) },
  });
}

// Candidatos a "o último lançamento" pra correções sem pending ativo (ex.:
// "o último gasto foi 31, não 13" depois que o plano anterior já foi
// aplicado). Só olha os criados por ESTE pipeline ou pelo parser antigo via
// Telegram (source telegram/telegram_ai) — nunca um registro manual do
// dashboard, que o usuário não estava "acabando de falar" no chat.
export async function loadRecentAppliedRecords({ client = prisma } = {}) {
  const since = new Date(Date.now() - RECENT_APPLIED_WINDOW_HOURS * 3600 * 1000);
  const [expenses, incomes, transfers] = await Promise.all([
    client.expense.findMany({ where: { source: { in: ["telegram", "telegram_ai"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: RECENT_APPLIED_LIMIT }),
    client.income.findMany({ where: { source: { in: ["telegram", "telegram_ai"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: RECENT_APPLIED_LIMIT }),
    client.transfer.findMany({ where: { source: { in: ["telegram", "telegram_ai"] }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: RECENT_APPLIED_LIMIT }),
  ]);
  const tag = (rows, model) => rows.map((r) => ({ model, id: r.id, amount: r.amount.toString(), description: r.description, occurredAt: r.occurredAt, createdAt: r.createdAt }));
  return [...tag(expenses, "expense"), ...tag(incomes, "income"), ...tag(transfers, "transfer")].sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT_APPLIED_LIMIT);
}

export async function buildConversationContext(chatId, { client = prisma } = {}) {
  const pending = await loadPendingPlan(chatId, { client });
  const recentApplied = await loadRecentAppliedRecords({ client });
  return {
    hasPending: Boolean(pending),
    pendingAction: pending ? pending.parsedPayload?.plan?.actions?.[0] : null,
    // Fase 7.0.1, item 3 — um pending pode ser um plano OU um descritor de
    // correção/exclusão/desfazer (savePendingCorrection); pendingKind deixa
    // explícito qual formato pipeline.js deve esperar em parsedPayload.
    pendingKind: pending ? (pending.parsedPayload?.correction ? "correction" : "plan") : null,
    recentApplied: recentApplied.map(({ model, id, amount, description }) => ({ model, id, amount, description })),
  };
}
