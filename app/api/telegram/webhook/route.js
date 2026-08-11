import { NextResponse } from "next/server";
import { processTelegramMessage } from "@/lib/processTelegramMessage";

// Usado apenas quando hospedado (Vercel). O Telegram chama esta URL a cada
// mensagem nova — não precisa de nenhum processo rodando o tempo todo.
// Setup: depois do deploy, rode uma vez
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO/api/telegram/webhook"

export async function POST(request) {
  const update = await request.json();
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;

  if (!text || !chatId) {
    return NextResponse.json({ ok: true });
  }

  const token = process.env.TELEGRAM_TOKEN;
  const result = await processTelegramMessage(text, String(chatId));

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: result.reply }),
  });

  return NextResponse.json({ ok: true });
}
