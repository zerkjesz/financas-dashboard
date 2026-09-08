import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { handleTelegramUpdate } from "../lib/telegramUpdateHandler.js";
import { getTelegramAllowedUserId, isDevBypassEnabled } from "../lib/auth/envConfig.js";

const { TELEGRAM_TOKEN } = process.env;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "seu_token_aqui") {
  console.error("Configure o TELEGRAM_TOKEN de verdade no .env (pegue com o @BotFather).");
  process.exit(1);
}

// Fase 5.3C/5.3C.1, item 5 — a MESMA policy do webhook (sender auth +
// private-chat + idempotência durável), nunca uma versão mais fraca só
// porque é o processo local. TELEGRAM_ALLOWED_USER_ID é o from.id do único
// usuário autorizado (nunca um chat.id — ver lib/auth/telegramSecurity.js).
// Fail closed — sem isso configurado, o bot recusa iniciar (exceto
// AUTH_DEV_BYPASS explícito em dev).
if (!getTelegramAllowedUserId() && !isDevBypassEnabled()) {
  console.error(
    "Configure TELEGRAM_ALLOWED_USER_ID no .env (o from.id do Telegram do único usuário autorizado — " +
      "mande qualquer mensagem pro bot uma vez e confira o campo message.from.id do update recebido) — " +
      "o bot recusa rodar sem isso. Alternativa só pra dev local: AUTH_DEV_BYPASS=true (nunca em produção)."
  );
  process.exit(1);
}

// polling:false — este arquivo implementa seu PRÓPRIO loop de long-polling
// (abaixo) em vez de usar bot.startPolling()/os eventos 'message'/
// 'callback_query' da lib. Motivo (Fase 5.3C.1, item 6): a lib
// node-telegram-bot-api NÃO expõe update_id pros handlers de evento — só
// internamente, pra controlar o offset (ver node_modules/node-telegram-bot-api/
// src/telegramPolling.js). Sem update_id explícito não dá pra aplicar a
// MESMA idempotência durável (lib/telegramIdempotency.js) que o webhook usa
// — por isso chamamos bot.getUpdates() diretamente (método público da lib,
// só a chamada HTTP crua) e processamos cada Update via
// lib/telegramUpdateHandler.js, o MESMO caminho do webhook.
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let offset = 0;

// Fase 5.3C.2, item 23 — política explícita de offset. ANTES desta fase o
// offset avançava ANTES de processar (bug real: uma falha retryable
// perderia o update pra sempre, nunca mais reentregue pelo getUpdates).
// Agora: offset só avança DEPOIS de o update estar definitivamente
// resolvido — seja com sucesso, seja com um status terminal
// (rejected_*/duplicate_*, que não precisam de retry), seja por esgotar as
// tentativas de um erro persistente. Retry limitado (não infinito) evita o
// cenário oposto (item 23-C: um update permanentemente quebrado bloquearia
// TODOS os updates seguintes pra sempre) — 3 tentativas com backoff curto é
// suficiente pra falhas transitórias (rede/DB) sem travar o bot por um erro
// permanente. Seguro reprocessar: cada tentativa roda dentro da própria
// transação atômica (lib/telegramUpdateHandler.js) — uma tentativa que
// falha nunca deixa mutação financeira parcial, só reverte tudo.
const MAX_ATTEMPTS_PER_UPDATE = 3;
const RETRY_BACKOFF_MS = 3000;

async function pollOnce() {
  const updates = await bot.getUpdates({ offset, timeout: 25 });
  for (const update of updates) {
    let succeeded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_UPDATE && !succeeded; attempt++) {
      try {
        const result = await handleTelegramUpdate(update);
        if (result.status !== "processed" && result.status !== "ignored_unsupported_update_type") {
          console.log(`[bot] update ${update.update_id}: ${result.status}`);
        }
        succeeded = true;
      } catch (err) {
        console.error(`[bot] erro processando update ${update.update_id} (tentativa ${attempt}/${MAX_ATTEMPTS_PER_UPDATE}):`, err.message);
        if (attempt < MAX_ATTEMPTS_PER_UPDATE) await sleep(RETRY_BACKOFF_MS);
      }
    }
    if (!succeeded) {
      console.error(`[bot] update ${update.update_id} falhou ${MAX_ATTEMPTS_PER_UPDATE}x seguidas — desistindo e avançando. Nenhuma mutação parcial ficou persistida (cada tentativa é atômica).`);
    }
    offset = update.update_id + 1; // só avança DEPOIS do update estar resolvido (sucesso ou desistência), nunca antes.
  }
}

async function start() {
  try {
    await bot.deleteWebHook();
  } catch (err) {
    console.error("Não consegui autenticar no Telegram — confira se o TELEGRAM_TOKEN no .env está correto.");
    process.exit(1);
  }
  console.log("Bot rodando (polling manual, com idempotência durável por update_id). Aguardando mensagens...");
  while (true) {
    try {
      await pollOnce();
    } catch (err) {
      console.error("Erro de polling:", err.message);
      await sleep(3000);
    }
  }
}

start();
