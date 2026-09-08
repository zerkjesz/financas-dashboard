import { NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/telegramUpdateHandler";
import { verifyTelegramSecret } from "@/lib/auth/telegramSecurity";
import { getTelegramWebhookSecret, getTelegramAllowedUserId, isDevBypassEnabled, isProductionRuntime } from "@/lib/auth/envConfig";

// Usado apenas quando hospedado (Vercel). O Telegram chama esta URL a cada
// mensagem/toque de botão novo — não precisa de nenhum processo rodando o tempo todo.
// Setup: depois do deploy, rode uma vez
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://SEU_DOMINIO/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
// Fase 5.3C/5.3C.1 — TRÊS camadas de proteção, independentes (item 4 —
// nenhuma substitui a outra):
//   1) TRANSPORT_AUTHENTICATED: header X-Telegram-Bot-Api-Secret-Token
//      precisa bater com TELEGRAM_WEBHOOK_SECRET (prova que a requisição veio
//      do Telegram de verdade).
//   2) SENDER_AUTHORIZED: from.id do update precisa bater com
//      TELEGRAM_ALLOWED_USER_ID (nunca chat.id — ver lib/auth/telegramSecurity.js)
//      + chat.type precisa ser "private" — ambos checados dentro de
//      lib/telegramUpdateHandler.js, compartilhado com o bot local.
//   3) IDEMPOTENT: update_id reivindicado de forma durável (banco, não
//      memória) antes de qualquer mutação financeira — lib/telegramIdempotency.js.
// FAIL CLOSED: sem TELEGRAM_WEBHOOK_SECRET/TELEGRAM_ALLOWED_USER_ID
// configurados, o webhook recusa operar — exceto AUTH_DEV_BYPASS=true
// explícito em dev (nunca em produção).
export async function POST(request) {
  const devBypass = isDevBypassEnabled();

  if (!devBypass) {
    const webhookSecret = getTelegramWebhookSecret();
    const allowedUserId = getTelegramAllowedUserId();
    if (!webhookSecret || !allowedUserId) {
      console.error(
        "[telegram/webhook] TELEGRAM_WEBHOOK_SECRET ou TELEGRAM_ALLOWED_USER_ID ausente — recusando processar (fail closed)." +
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

  try {
    const result = await handleTelegramUpdate(update);
    // Item 13 — sucesso OU duplicate/rejeitado: sempre 200 (evita retry
    // infinito do Telegram pra um update que não vamos processar de novo de
    // propósito, seja por autorização ou por já ter sido processado).
    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    // Item 14 — falha REAL de processamento: 500 permite o Telegram tentar
    // de novo (retry legítimo, vai reivindicar o mesmo update_id de novo já
    // que o receipt ficou FAILED).
    console.error("[telegram/webhook] erro processando update:", err.message);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
