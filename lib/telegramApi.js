// Chamadas cruas pra API HTTP do Telegram — usado tanto pelo bot em polling
// (bot/telegram-bot.js) quanto pelo webhook de produção (app/api/telegram/webhook/route.js),
// pra manter os dois entrypoints com o mesmo comportamento de teclado/botão.
const BASE = "https://api.telegram.org/bot";

function apiUrl(method) {
  const token = process.env.TELEGRAM_TOKEN;
  return `${BASE}${token}/${method}`;
}

async function call(method, body) {
  try {
    const res = await fetch(apiUrl(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    console.error(`Erro chamando Telegram (${method}):`, err.message);
    return { ok: false, error: err.message };
  }
}

export function sendMessage(chatId, text, { replyMarkup } = {}) {
  return call("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

export function editMessageText(chatId, messageId, text, { replyMarkup } = {}) {
  return call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
}

export function answerCallbackQuery(callbackQueryId, text) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// rows: array de arrays de { text, data }
export function buildInlineKeyboard(rows) {
  return { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

export function chunk(arr, size) {
  const rows = [];
  for (let i = 0; i < arr.length; i += size) rows.push(arr.slice(i, i + size));
  return rows;
}
