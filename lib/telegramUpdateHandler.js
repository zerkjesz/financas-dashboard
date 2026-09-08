import { processTelegramMessage } from "./processTelegramMessage.js";
import { startWizard, handleWizardCallback, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT, sendMainMenu } from "./botWizard.js";
import { sendMessage, answerCallbackQuery } from "./telegramApi.js";
import { isAuthorizedTelegramSender } from "./auth/telegramSecurity.js";
import { getTelegramAllowedUserId, isDevBypassEnabled } from "./auth/envConfig.js";
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from "./telegramIdempotency.js";

// ============================================================================
// Fase 5.3C.1 — ponto de entrada ÚNICO e COMPARTILHADO pra processar um
// Update do Telegram, usado tanto pelo webhook de produção
// (app/api/telegram/webhook/route.js) quanto pelo bot local em polling
// (bot/telegram-bot.js). Antes da 5.3C.1 essa lógica estava DUPLICADA (quase
// idêntica) nos dois arquivos — centralizar aqui garante que sender auth +
// private-chat policy + idempotência valem EXATAMENTE igual nos dois
// entrypoints (item 5: "não proteger apenas webhook e deixar o bot local
// menos restrito").
//
// ACCEPTED UPDATE SHAPES (item 0) — auditado explicitamente, só 2:
//   - `message` (com `.text`) — comandos/texto livre.
//   - `callback_query` — toque em botão do wizard.
// Qualquer outro tipo de Update (edited_message, channel_post,
// edited_channel_post, inline_query, etc.) é IGNORADO de propósito — nunca
// processado, nunca ampliado sem decisão explícita de produto (item 16).
// ============================================================================

// Extrai sender/chat de um Update — NUNCA confunde os dois (item 1).
//   - chatId/chatType vêm de message.chat (ou callback_query.message.chat).
//   - senderId vem de message.from.id (ou callback_query.from.id) — quem
//     APERTOU O BOTÃO/MANDOU A MENSAGEM, não o chat em si.
function extractIdentity(update) {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  return {
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    senderId: from?.id ?? null,
  };
}

// handleTelegramUpdate(update) -> { status: "..." }
//
// Nunca lança pra fora por causa de rejeição de auth (retorna status
// descritivo) — só propaga exceção se o PROCESSAMENTO em si falhar (erro
// real dentro de processTelegramMessage/commitBotIntent), pra quem chama
// decidir o código HTTP (permitir retry do Telegram em erro real).
export async function handleTelegramUpdate(update) {
  if (!update?.message && !update?.callback_query) {
    return { status: "ignored_unsupported_update_type" };
  }

  const { chatId, chatType, senderId } = extractIdentity(update);
  const devBypass = isDevBypassEnabled();

  // Item 3 — SENDER AUTH (from.id), nunca chat.id.
  if (!devBypass) {
    const allowedUserId = getTelegramAllowedUserId();
    if (senderId == null) {
      return { status: "rejected_missing_sender" };
    }
    if (!isAuthorizedTelegramSender(senderId, allowedUserId)) {
      return { status: "rejected_unauthorized_sender" };
    }
    // Item 2 — PRIVATE CHAT POLICY, fail-closed: mesmo sender autorizado,
    // fora de um chat privado 1:1 é rejeitado. Nenhum suporte a
    // group/supergroup/channel nesta fase.
    if (chatType !== "private") {
      return { status: "rejected_non_private_chat" };
    }
  }

  // Item 6 — IDEMPOTÊNCIA DURÁVEL por update_id, ANTES de qualquer
  // processamento/mutação financeira. Ver lib/telegramIdempotency.js pro
  // escopo exato da garantia (documentado, não "exactly-once" perfeito).
  const updateId = update.update_id;
  if (updateId == null) {
    return { status: "rejected_missing_update_id" };
  }

  let claim = { claimed: true, receiptId: null };
  if (!devBypass) {
    claim = await claimTelegramUpdate(updateId, {
      senderId: senderId != null ? String(senderId) : null,
      chatId: chatId != null ? String(chatId) : null,
    });
    if (!claim.claimed) {
      // Item 13 — duplicate legítimo: nunca tratado como erro. O caller
      // responde sucesso HTTP (impede retry infinito do Telegram).
      return { status: `duplicate_${claim.reason.toLowerCase()}` };
    }
  }

  try {
    await dispatchUpdate(update, chatId);
    if (claim.receiptId) await completeTelegramUpdate(claim.receiptId);
    return { status: "processed" };
  } catch (err) {
    // Item 14 — falha antes do commit da mutação: marca FAILED (permite
    // retry futuro reivindicar de novo) e propaga pro caller decidir o
    // código HTTP (500 -> Telegram tenta de novo).
    if (claim.receiptId) await failTelegramUpdate(claim.receiptId).catch(() => {});
    throw err;
  }
}

async function dispatchUpdate(update, chatId) {
  if (update.callback_query) {
    const { callback_query: callbackQuery } = update;
    await answerCallbackQuery(callbackQuery.id);
    await handleWizardCallback(String(chatId), callbackQuery.data);
    return;
  }

  const text = update.message?.text;
  if (!text) return;
  const trimmed = text.trim();

  if (trimmed === "/start") {
    await sendMainMenu(String(chatId), "Oi! Usa os botões aqui embaixo pra registrar rapidinho, ou manda uma mensagem tipo \"50 mercado pix\" se preferir escrever.");
    return;
  }
  if (MENU_FLOWS[trimmed]) {
    await startWizard(String(chatId), MENU_FLOWS[trimmed]);
    return;
  }
  if (trimmed === MAIS_OPCOES_LABEL) {
    await sendMessage(chatId, MAIS_OPCOES_TEXT);
    return;
  }

  const result = await processTelegramMessage(text, String(chatId));
  if (result.reply) {
    await sendMessage(chatId, result.reply);
  }
}
