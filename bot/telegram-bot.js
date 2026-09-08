import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { processTelegramMessage } from "../lib/processTelegramMessage.js";
import { startWizard, handleWizardCallback, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT, sendMainMenu } from "../lib/botWizard.js";
import { answerCallbackQuery } from "../lib/telegramApi.js";
import { isAuthorizedTelegramChat } from "../lib/auth/telegramSecurity.js";
import { getOwnerChatId, isDevBypassEnabled } from "../lib/auth/envConfig.js";

const { TELEGRAM_TOKEN } = process.env;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "seu_token_aqui") {
  console.error("Configure o TELEGRAM_TOKEN de verdade no .env (pegue com o @BotFather).");
  process.exit(1);
}

// Fase 5.3C, item 13 — o polling não precisa do TELEGRAM_WEBHOOK_SECRET (só
// existe pra provar que um POST externo veio do Telegram de verdade; aqui a
// conexão já é direta com a API do Telegram), mas o OWNER_CHAT_ID continua
// obrigatório: qualquer pessoa pode mandar mensagem pro bot, autenticidade
// do transporte não implica autorização do usuário. Fail closed — sem
// OWNER_CHAT_ID configurado, o bot recusa iniciar (exceto AUTH_DEV_BYPASS
// explícito em dev).
const ownerChatId = getOwnerChatId();
if (!ownerChatId && !isDevBypassEnabled()) {
  console.error(
    "Configure OWNER_CHAT_ID no .env (o chat_id do Telegram do único usuário autorizado) — o bot recusa rodar sem isso. " +
      "Alternativa só pra dev local: AUTH_DEV_BYPASS=true (nunca em produção)."
  );
  process.exit(1);
}

// Garante que não existe webhook antigo configurado (ex: o Apps Script)
// disputando as mensagens com o polling daqui.
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

async function start() {
  try {
    await bot.deleteWebHook();
  } catch (err) {
    console.error("Não consegui autenticar no Telegram — confira se o TELEGRAM_TOKEN no .env está correto.");
    process.exit(1);
  }
  bot.startPolling();
  console.log("Bot rodando (polling). Aguardando mensagens...");
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (!isDevBypassEnabled() && !isAuthorizedTelegramChat(chatId, ownerChatId)) {
    return; // update genuíno do Telegram, mas de um chat não autorizado — nunca processado.
  }

  const trimmed = text.trim();

  try {
    if (trimmed === "/start") {
      await sendMainMenu(String(chatId), "Oi! Usa os botões aqui embaixo pra registrar rapidinho, ou manda uma mensagem tipo \"50 mercado pix\" se preferir escrever.");
      return;
    }
    if (MENU_FLOWS[trimmed]) {
      await startWizard(String(chatId), MENU_FLOWS[trimmed]);
      return;
    }
    if (trimmed === MAIS_OPCOES_LABEL) {
      await bot.sendMessage(chatId, MAIS_OPCOES_TEXT);
      return;
    }

    const result = await processTelegramMessage(text, String(chatId));
    if (result.reply) await bot.sendMessage(chatId, result.reply);
  } catch (err) {
    console.error("Erro ao processar mensagem:", err);
    await bot.sendMessage(chatId, "Deu erro ao salvar, tenta de novo.");
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (!isDevBypassEnabled() && !isAuthorizedTelegramChat(chatId, ownerChatId)) {
    return;
  }
  try {
    await answerCallbackQuery(query.id);
    await handleWizardCallback(String(chatId), query.data);
  } catch (err) {
    console.error("Erro ao processar botão:", err);
  }
});

bot.on("polling_error", (err) => {
  console.error("Erro de polling:", err.message);
});

start();
