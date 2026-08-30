import { NextResponse } from "next/server";
import { processTelegramMessage } from "@/lib/processTelegramMessage";
import { startWizard, handleWizardCallback, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT, sendMainMenu } from "@/lib/botWizard";
import { sendMessage, answerCallbackQuery } from "@/lib/telegramApi";

// Usado apenas quando hospedado (Vercel). O Telegram chama esta URL a cada
// mensagem/toque de botão novo — não precisa de nenhum processo rodando o tempo todo.
// Setup: depois do deploy, rode uma vez
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO/api/telegram/webhook"

export async function POST(request) {
  const update = await request.json();

  if (update?.callback_query) {
    const { callback_query: callbackQuery } = update;
    const chatId = callbackQuery.message?.chat?.id;
    if (chatId) {
      await answerCallbackQuery(callbackQuery.id);
      await handleWizardCallback(String(chatId), callbackQuery.data);
    }
    return NextResponse.json({ ok: true });
  }

  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;

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
