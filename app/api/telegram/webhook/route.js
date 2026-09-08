import { NextResponse } from "next/server";
import { processTelegramMessage } from "@/lib/processTelegramMessage";
import { startWizard, handleWizardCallback, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT, sendMainMenu } from "@/lib/botWizard";
import { sendMessage, answerCallbackQuery } from "@/lib/telegramApi";
import { verifyTelegramSecret, isAuthorizedTelegramChat } from "@/lib/auth/telegramSecurity";
import { getTelegramWebhookSecret, getOwnerChatId, isDevBypassEnabled, isProductionRuntime } from "@/lib/auth/envConfig";

// Usado apenas quando hospedado (Vercel). O Telegram chama esta URL a cada
// mensagem/toque de botão novo — não precisa de nenhum processo rodando o tempo todo.
// Setup: depois do deploy, rode uma vez
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
// Fase 5.3C, itens 12-14 — DUAS camadas de proteção, nenhuma substitui a
// outra:
//   1) authenticity do REQUEST: header X-Telegram-Bot-Api-Secret-Token
//      precisa bater com TELEGRAM_WEBHOOK_SECRET (prova que a requisição veio
//      do Telegram de verdade, não de qualquer POST bem formado nesta URL).
//   2) autorização do USUÁRIO: mesmo um update genuíno do Telegram pode vir
//      de outra pessoa conversando com o bot — chatId precisa bater com
//      OWNER_CHAT_ID.
// FAIL CLOSED: sem TELEGRAM_WEBHOOK_SECRET/OWNER_CHAT_ID configurados, o
// webhook recusa operar (nunca fica aberto silenciosamente) — exceto com
// AUTH_DEV_BYPASS=true explícito em dev (nunca em produção).
export async function POST(request) {
  const devBypass = isDevBypassEnabled();

  if (!devBypass) {
    const webhookSecret = getTelegramWebhookSecret();
    const ownerChatId = getOwnerChatId();
    if (!webhookSecret || !ownerChatId) {
      console.error(
        "[telegram/webhook] TELEGRAM_WEBHOOK_SECRET ou OWNER_CHAT_ID ausente — recusando processar (fail closed)." +
          (isProductionRuntime() ? " Configure ambos na Vercel." : " Configure no .env, ou AUTH_DEV_BYPASS=true só pra dev local.")
      );
      return NextResponse.json({ error: "webhook_not_configured" }, { status: 500 });
    }

    const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!verifyTelegramSecret(headerSecret, webhookSecret)) {
      return NextResponse.json({ error: "invalid_secret" }, { status: 401 });
    }
  }

  const update = await request.json();

  const chatId =
    update?.callback_query?.message?.chat?.id ?? update?.message?.chat?.id ?? null;

  if (!devBypass) {
    const ownerChatId = getOwnerChatId();
    if (!isAuthorizedTelegramChat(chatId, ownerChatId)) {
      // Update autêntico do Telegram, mas de um chat não autorizado — nunca
      // chega no classifier/commitBotIntent. Responde 200 pro Telegram (evita
      // retries desnecessários de um update que não vamos processar de
      // propósito), mas não processa nada.
      return NextResponse.json({ ok: true });
    }
  }

  if (update?.callback_query) {
    const { callback_query: callbackQuery } = update;
    if (chatId) {
      await answerCallbackQuery(callbackQuery.id);
      await handleWizardCallback(String(chatId), callbackQuery.data);
    }
    return NextResponse.json({ ok: true });
  }

  const text = update?.message?.text;

  if (!text || !chatId) {
    return NextResponse.json({ ok: true });
  }
  const trimmed = text.trim();

  if (trimmed === "/start") {
    await sendMainMenu(String(chatId), "Oi! Usa os botões aqui embaixo pra registrar rapidinho, ou manda uma mensagem tipo \"50 mercado pix\" se preferir escrever.");
    return NextResponse.json({ ok: true });
  }
  if (MENU_FLOWS[trimmed]) {
    await startWizard(String(chatId), MENU_FLOWS[trimmed]);
    return NextResponse.json({ ok: true });
  }
  if (trimmed === MAIS_OPCOES_LABEL) {
    await sendMessage(chatId, MAIS_OPCOES_TEXT);
    return NextResponse.json({ ok: true });
  }

  const result = await processTelegramMessage(text, String(chatId));
  if (result.reply) {
    await sendMessage(chatId, result.reply);
  }

  return NextResponse.json({ ok: true });
}
