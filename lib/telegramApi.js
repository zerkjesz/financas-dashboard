// Chamadas cruas pra API HTTP do Telegram — usado tanto pelo bot em polling
// (bot/telegram-bot.js) quanto pelo webhook de produção (app/api/telegram/webhook/route.js),
// pra manter os dois entrypoints com o mesmo comportamento de teclado/botão.
const BASE = "https://api.telegram.org/bot";

function apiUrl(method) {
  const token = process.env.TELEGRAM_TOKEN;
  return `${BASE}${token}/${method}`;
}

// Fase 7D — buffer circular de observabilidade (nunca afeta o comportamento
// real): sendMessage/editMessageText SEMPRE registram aqui o que TENTARAM
// mandar, mesmo que a chamada HTTP real falhe/não exista (ex.: ambiente de
// teste sem TELEGRAM_TOKEN real). Isso é o que permite testes automatizados
// verificarem o CONTEÚDO das mensagens do wizard (que chama sendMessage/
// editMessageText diretamente, fora do outbox — ver lib/botWizard.js:ask())
// sem precisar mockar o módulo inteiro. Tamanho limitado só pra nunca crescer
// sem limite num processo de polling de longa duração.
const MAX_SENT_LOG = 200;
export const sentMessages = [];
let sentTotalCount = 0;
// Contador monotônico (o buffer acima é circular e satura em 200): permite a
// um teste saber quantas mensagens novas saíram desde um ponto, mesmo depois
// do buffer encher.
export function sentTotal() {
  return sentTotalCount;
}
function recordSent(entry) {
  sentTotalCount++;
  sentMessages.push(entry);
  if (sentMessages.length > MAX_SENT_LOG) sentMessages.shift();
}
export function lastSentTextFor(chatId) {
  for (let i = sentMessages.length - 1; i >= 0; i--) {
    if (String(sentMessages[i].chatId) === String(chatId)) return sentMessages[i].text;
  }
  return null;
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
  recordSent({ type: "sendMessage", chatId, text, replyMarkup });
  return call("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

export function editMessageText(chatId, messageId, text, { replyMarkup } = {}) {
  recordSent({ type: "editMessageText", chatId, messageId, text, replyMarkup });
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
