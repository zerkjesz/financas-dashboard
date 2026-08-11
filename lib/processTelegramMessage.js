import { prisma } from "./prisma.js";
import { parseTransaction } from "./parseTransaction.js";
import { commitBotIntent } from "./commitBotIntent.js";

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const YES_RE = /^(s|sim|yes|confirmo|isso|correto|ok)\b/i;
const NO_RE = /^(n|nao|não|no|errado|cancela)\b/i;

// Interpreta e grava uma mensagem de texto livre do Telegram. `chatId` é obrigatório porque
// o fluxo de confirmação (pra mensagens ambíguas) precisa de estado por chat, guardado no
// banco — o webhook de produção roda numa function serverless sem memória entre chamadas.
export async function processTelegramMessage(text, chatId) {
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
    await prisma.pendingBotMessage.upsert({
      where: { chatId },
      create: {
        chatId,
        intent: parsed.intent,
        parsedPayload: JSON.parse(JSON.stringify(parsed.data)),
        promptMessage: parsed.confirmationPrompt,
        rawMessage: parsed.rawMessage,
        expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
      },
      update: {
        intent: parsed.intent,
        parsedPayload: JSON.parse(JSON.stringify(parsed.data)),
        promptMessage: parsed.confirmationPrompt,
        rawMessage: parsed.rawMessage,
        expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
      },
    });
    return { ok: true, pending: true, reply: parsed.confirmationPrompt };
  }

  const { reply } = await commitBotIntent(parsed.intent, parsed.data, { source: "telegram" });
  return { ok: true, reply };
}

async function consumePendingIfPresent(chatId, text) {
  const pending = await prisma.pendingBotMessage.findUnique({ where: { chatId } });
  if (!pending) return null;

  if (pending.expiresAt <= new Date()) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } }).catch(() => {});
    return null;
  }

  const answer = text.trim();
  if (YES_RE.test(answer)) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
    const { reply } = await commitBotIntent(pending.intent, pending.parsedPayload, { source: "telegram" });
    return { ok: true, reply };
  }
  if (NO_RE.test(answer)) {
    await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
    return { ok: false, reply: "Beleza, cancelei o registro. Manda de novo com mais detalhes." };
  }

  // Nem sim nem não: assume que o usuário mudou de assunto, descarta o pendente e processa a mensagem nova.
  await prisma.pendingBotMessage.delete({ where: { id: pending.id } });
  return null;
}
