import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { processTelegramMessage } from "../lib/processTelegramMessage.js";
import { startWizard, handleWizardCallback, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT, sendMainMenu } from "../lib/botWizard.js";
import { answerCallbackQuery } from "../lib/telegramApi.js";

const { TELEGRAM_TOKEN } = process.env;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "seu_token_aqui") {
  console.error("Configure o TELEGRAM_TOKEN de verdade no .env (pegue com o @BotFather).");
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
