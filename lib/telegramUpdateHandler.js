import { prisma } from "./prisma.js";
import { processTelegramMessage, hasPendingConfirmation } from "./processTelegramMessage.js";
import { startWizard, handleWizardCallback, isInWizard, buildMainMenuKeyboard, MENU_FLOWS, MAIS_OPCOES_LABEL, MAIS_OPCOES_TEXT } from "./botWizard.js";
import { handleMenuCallback, rootMenuKeyboard, ROOT_MENU_TEXT, renderMenu, matchTextAlias } from "./telegramMenu.js";
import { sendMessage, editMessageText, answerCallbackQuery } from "./telegramApi.js";
import { isAuthorizedTelegramSender } from "./auth/telegramSecurity.js";
import { getTelegramAllowedUserId, isDevBypassEnabled } from "./auth/envConfig.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "./telegramIdempotency.js";
import { classifyIntent } from "./intentClassifier.js";
import { READ_INTENTS, handleReadIntent } from "./telegramReads.js";
import { SIMULATION_BYPASS_INTENTS, handleBypassSimulationIntent } from "./telegramSimulation.js";
import { handleConversationalMessage, PIPELINE_RESULT_KIND } from "./telegramAi/pipeline.js";
import { getConfiguredProvider } from "./telegramAi/llmProvider.js";
import { isTelegramAiEnabled } from "./telegramAi/featureFlag.js";
import { PROVIDER_UNAVAILABLE_MESSAGE } from "./telegramAi/responseFormatter.js";

// ============================================================================
// Fase 5.3C.1/5.3C.2 — ponto de entrada ÚNICO e COMPARTILHADO pra processar
// um Update do Telegram, usado tanto pelo webhook de produção
// (app/api/telegram/webhook/route.js) quanto pelo bot local em polling
// (bot/telegram-bot.js).
//
// ACCEPTED UPDATE SHAPES — só 2: `message` (com `.text`) e `callback_query`.
// Qualquer outro tipo (edited_message, channel_post, inline_query, etc.) é
// ignorado de propósito.
//
// Fase 5.3C.2 — GARANTIA: pra cada update_id, TODA a mutação persistente
// disparada por ele (claim do receipt + BotWizardSession/PendingBotMessage +
// a mutação financeira em si, se houver) acontece numa ÚNICA
// `prisma.$transaction`. EFFECTIVELY_ONCE_FINANCIAL_DB_EFFECT: os efeitos
// persistentes no Postgres pra um update_id acontecem no máximo uma vez —
// mesmo sob concorrência, retry, ou processo morrendo no meio. Isso NÃO é
// uma alegação de exactly-once de entrega de rede/HTTP/mensagem de resposta
// (esses continuam best-effort, como sempre foram).
//
// Item 25 — replies do Telegram (sendMessage/editMessageText/
// answerCallbackQuery) NUNCA rodam dentro da transação: são coletadas num
// "outbox" durante o processamento e só de fato enviadas DEPOIS da
// transação commitar. Exceção documentada: o assistente guiado (botWizard.js)
// às vezes precisa aprender o message_id retornado pelo Telegram pra
// persisti-lo (editar a mesma mensagem no próximo passo) — essas chamadas de
// NAVEGAÇÃO DE UI (nunca financeiras) continuam inline, dentro da transação;
// só a resposta do ÚNICO passo com efeito financeiro real (confirm:yes) é
// adiada via outbox. Ver lib/botWizard.js pro detalhe exato.
// ============================================================================

const TRANSACTION_TIMEOUT_MS = 10_000; // folga generosa — processamento normal é bem mais rápido; nunca queremos abortar um update legítimo por timeout artificial.

function extractIdentity(update) {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  return {
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    senderId: from?.id ?? null,
  };
}

// Fase 5.3D, item 2 — wizard e confirmação pendente SEMPRE têm precedência
// sobre READ (nunca interrompe um fluxo em andamento por engano). Callback de
// botão nunca é READ. Comandos especiais (/start, menu, "mais opções")
// também nunca são READ (já têm seu próprio tratamento).
//
// Fase 5.3E/5.3E.1 — SIMULATION_BYPASS_INTENTS ("posso gastar X?", "e se eu
// gastar/pagar X?") recebe EXATAMENTE o mesmo tratamento de bypass que READ:
// zero efeito persistente (nunca ambíguo, nunca precisa perguntar nada),
// então idempotente por construção — um retry do mesmo update_id só
// recalcula e reenvia. Intents de simulação que PODEM precisar de
// clarificação (cartão/parcelamento/contingência — ver
// lib/telegramSimulation.js:SIMULATION_TRANSACTIONAL_INTENTS) NÃO entram
// aqui de propósito: passam por lib/processTelegramMessage.js dentro da
// transação normal, porque podem precisar gravar um PendingBotMessage
// (item 12 da Fase 5.3E.1 — infraestrutura não-financeira, mas ainda uma
// escrita real).
async function detectQueryIntent(update, chatId) {
  if (update.callback_query) return null;
  const text = update.message?.text;
  if (!text) return null;
  const trimmed = text.trim();
  // Fase 7D — comandos/aliases do menu determinístico (item 2/27) NUNCA
  // passam pelo classificador de leitura legado: "saldo"/"fatura"/etc.
  // precisam abrir o wizard/menu certo, não uma leitura por acaso parecida.
  if (trimmed === "/start" || trimmed === "/menu" || MENU_FLOWS[trimmed] || trimmed === MAIS_OPCOES_LABEL || matchTextAlias(trimmed)) return null;

  if (await isInWizard(String(chatId))) return null;
  if (await hasPendingConfirmation(String(chatId))) return null;

  const classified = classifyIntent(text);
  if (READ_INTENTS.has(classified.intent)) return { kind: "read", intent: classified.intent };
  if (SIMULATION_BYPASS_INTENTS.has(classified.intent)) return { kind: "simulation", classified };
  return null;
}

function pushSend(outbox, chatId, text, opts) {
  outbox.push({ type: "sendMessage", args: [chatId, text, opts] });
}

async function flushOutbox(outbox) {
  for (const action of outbox) {
    if (action.type === "sendMessage") await sendMessage(...action.args);
    else if (action.type === "editMessageText") await editMessageText(...action.args);
    else if (action.type === "answerCallbackQuery") await answerCallbackQuery(...action.args);
  }
}

// dispatchUpdate: SEM chamada de rede direta (exceto a exceção documentada
// de navegação de UI dentro de botWizard.js) — persiste via `client` e
// enfileira respostas via `outbox`.
// Exportada pra testes (Fase 7.0.1, item 1) poderem exercitar o roteamento
// real de TELEGRAM_AI_ENABLED sem precisar de uma transação de idempotência
// nem de chamadas HTTP reais pra API do Telegram (handleTelegramUpdate faz
// as duas coisas) — dispatchUpdate já é puramente client+outbox.
export async function dispatchUpdate(update, chatId, { client, outbox }) {
  if (update.callback_query) {
    const { callback_query: callbackQuery } = update;
    outbox.push({ type: "answerCallbackQuery", args: [callbackQuery.id] });
    const messageId = callbackQuery.message?.message_id;
    // Fase 7D — callbacks de MENU (m:/w:/r:/cor:, ver lib/telegramMenu.js)
    // são tentados PRIMEIRO; devolve `false` se o prefixo não é reconhecido,
    // e aí (só aí) tenta os callbacks de WIZARD (cat:/tgt:/confirm:/etc.,
    // ver lib/botWizard.js) — os dois espaços de callback_data nunca colidem
    // por construção (prefixos disjuntos), então a ordem aqui é só uma
    // questão de qual tentar primeiro, nunca uma ambiguidade real.
    const handledByMenu = await handleMenuCallback(String(chatId), callbackQuery.data, { client, messageId, outbox });
    if (handledByMenu) return { callback: "menu" };
    const result = await handleWizardCallback(String(chatId), callbackQuery.data, { client });
    // Fase 7D.1, item 12 — callback antigo/stale/inválido: NENHUMA ação, só
    // um aviso seguro (fail closed). Nunca "engole" o clique em silêncio.
    if (result?.stale || result?.unhandled) {
      pushSend(outbox, chatId, "Essa opção expirou ou não vale mais. Abre o menu de novo 👇", { replyMarkup: rootMenuKeyboard() });
      return { callback: result.stale ? "stale" : "unhandled" };
    }
    if (result?.deferredReply) {
      const { chatId: replyChatId, messageId: replyMessageId, text, replyMarkup } = result.deferredReply;
      if (replyMessageId) outbox.push({ type: "editMessageText", args: [replyChatId, replyMessageId, text, { replyMarkup }] });
      else pushSend(outbox, replyChatId, text, { replyMarkup });
    }
    return { callback: "wizard" };
  }

  const text = update.message?.text;
  if (!text) return;
  const trimmed = text.trim();

  if (trimmed === "/start" || trimmed === "/menu") {
    pushSend(outbox, chatId, ROOT_MENU_TEXT, { replyMarkup: rootMenuKeyboard() });
    return;
  }
  if (MENU_FLOWS[trimmed]) {
    await startWizard(String(chatId), MENU_FLOWS[trimmed], { client });
    return;
  }
  if (trimmed === MAIS_OPCOES_LABEL) {
    pushSend(outbox, chatId, MAIS_OPCOES_TEXT);
    return;
  }

  // Fase 7.0.1, item 1 — TELEGRAM_AI_ENABLED decide, de forma explícita e
  // binária, se o pipeline conversacional participa desta mensagem:
  //
  //   false (default, e a decisão de produto da Fase 7D — item 36: o
  //   Telegram determinístico/menu-driven NUNCA depende de LLM) -> pipeline
  //   NUNCA é chamado; permanece código morto/experimental, preservado mas
  //   inatingível na operação normal.
  //
  //   true (opt-in explícito, nunca o default) -> pipeline é SEMPRE chamado
  //   (quando a conversa não pertence ao parser antigo — wizard ativo, ou um
  //   PendingBotMessage estrangeiro). QUALQUER resultado que não seja
  //   REPLY/SILENT termina AQUI, com a mensagem de segurança fixa — NUNCA
  //   cai pro parser legado nem pro menu determinístico.
  if (isTelegramAiEnabled()) {
    const ownedByOldPipeline = (await isInWizard(String(chatId), { client })) || (await hasForeignPending(String(chatId), client));
    if (!ownedByOldPipeline) {
      const aiResult = await handleConversationalMessage(text, String(chatId), { client, provider: getConfiguredProvider(), rawMessage: text });
      if (aiResult.kind === PIPELINE_RESULT_KIND.REPLY) {
        pushSend(outbox, chatId, aiResult.reply);
        return;
      }
      if (aiResult.kind === PIPELINE_RESULT_KIND.SILENT) {
        return; // NO_FINANCIAL_INTENT — item J: zero resposta financeira, silêncio.
      }
      // NO_PROVIDER (sem ANTHROPIC_API_KEY) — zero write, mesma mensagem de
      // segurança de qualquer outra falha. NUNCA fallback pro parser legado
      // aqui: item 1 — "LEGACY_FALLBACK_WHEN_AI_ENABLED = NO".
      pushSend(outbox, chatId, PROVIDER_UNAVAILABLE_MESSAGE);
      return;
    }
  }

  // Fase 7D, item 2 — DECISÃO DE PRODUTO: texto livre só é interpretado
  // financeiramente quando está RESPONDENDO um campo que o wizard/uma
  // confirmação pendente pediu (isInWizard/hasPendingConfirmation, ambos já
  // resolvidos dentro de processTelegramMessage). Fora disso, NUNCA tenta
  // classificar a frase como um lançamento novo (nem por regex nem por
  // LLM) — mostra o menu. processTelegramMessage.js em si NÃO é alterado
  // (nem seus testes) — só deixa de ser chamado como fallback genérico.
  const inWizard = await isInWizard(String(chatId), { client });
  const hasPending = await hasPendingConfirmation(String(chatId), { client });
  if (inWizard || hasPending) {
    const result = await processTelegramMessage(text, String(chatId), { client });
    if (result.reply) pushSend(outbox, chatId, result.reply);
    return;
  }

  const alias = matchTextAlias(trimmed);
  if (alias) {
    if (alias.type === "wizard") {
      await startWizard(String(chatId), alias.flow, { client });
      return;
    }
    if (alias.type === "menu") {
      const { text: menuText, keyboard } = renderMenu(alias.key);
      pushSend(outbox, chatId, menuText, { replyMarkup: keyboard });
      return;
    }
    // alias.type === "cancel": sem wizard ativo (já checado acima), não há
    // nada a cancelar — mesma resposta honesta, nunca um "cancelado" falso.
    pushSend(outbox, chatId, "Nada em andamento pra cancelar.");
    return;
  }

  pushSend(outbox, chatId, "Use o menu pra registrar com segurança 👇", { replyMarkup: rootMenuKeyboard() });
}

// Um PendingBotMessage que NÃO é do pipeline conversacional (Fase 7.0)
// pertence ao parser antigo (simulation_clarification, provide_date,
// choose_bill, etc.) — se existir, a mensagem atual precisa ser resolvida
// por processTelegramMessage/consumePendingIfPresent, nunca pelo pipeline
// novo (que ignoraria esse pending e interpretaria a resposta curta do
// usuário — ex.: "sim" — como uma mensagem nova, sem contexto nenhum).
async function hasForeignPending(chatId, client) {
  const pending = await client.pendingBotMessage.findUnique({ where: { chatId } });
  return Boolean(pending) && pending.intent !== "financial_ai_plan";
}

// handleTelegramUpdate(update) -> { status: "..." }
//
// Nunca lança pra fora por causa de rejeição de auth (retorna status
// descritivo) — só propaga exceção se o PROCESSAMENTO em si falhar
// (qualquer erro real dentro da transação: parsing/validação/banco), pra
// quem chama decidir o código HTTP (permitir retry do Telegram em erro
// real). Uma exceção propagada aqui significa que a transação inteira foi
// revertida — nenhum efeito persistente sobrou, retry é seguro.
export async function handleTelegramUpdate(update) {
  if (!update?.message && !update?.callback_query) {
    return { status: "ignored_unsupported_update_type" };
  }

  const { chatId, chatType, senderId } = extractIdentity(update);
  const devBypass = isDevBypassEnabled();

  // Item 3/21 — SENDER AUTH + PRIVATE CHAT POLICY, ANTES de qualquer
  // transação/claim: um update não autorizado NUNCA cria TelegramUpdateReceipt.
  if (!devBypass) {
    const allowedUserId = getTelegramAllowedUserId();
    if (senderId == null) return { status: "rejected_missing_sender" };
    if (!isAuthorizedTelegramSender(senderId, allowedUserId)) return { status: "rejected_unauthorized_sender" };
    if (chatType !== "private") return { status: "rejected_non_private_chat" };
  }

  const updateId = update.update_id;
  if (updateId == null) return { status: "rejected_missing_update_id" };

  // Fase 5.3D, itens 0/4/14 — READ intents NUNCA passam pela transação/
  // idempotência: são idempotentes por construção (zero efeito persistente
  // além da resposta em si), então reexecutar num retry do MESMO update_id é
  // sempre seguro — nunca duplica nada. Isso também RESOLVE o problema de
  // reply-delivery de READ (item 14) sem precisar guardar nenhum payload no
  // receipt: se a resposta da 1ª tentativa falhar, um retry simplesmente
  // recalcula e reenvia, sempre fresh, sempre a partir da MESMA verdade
  // canônica (buildProductFinancialSnapshot) que o WEB usa — nunca uma
  // segunda fórmula.
  const queryIntent = await detectQueryIntent(update, chatId);
  if (queryIntent) {
    const reply = queryIntent.kind === "read" ? await handleReadIntent(queryIntent.intent) : await handleBypassSimulationIntent(queryIntent.classified);
    await sendMessage(chatId, reply);
    return { status: queryIntent.kind === "read" ? "processed_read" : "processed_simulation" };
  }

  if (devBypass) {
    // Bypass de dev (AUTH_DEV_BYPASS=true, nunca produção): sem receipt, sem
    // transação, sem idempotência — comportamento explícito de conveniência
    // local, já documentado desde a Fase 5.3C.
    const outbox = [];
    await dispatchUpdate(update, chatId, { client: prisma, outbox });
    await flushOutbox(outbox);
    return { status: "processed" };
  }

  const txResult = await prisma.$transaction(
    async (tx) => {
      const claim = await claimTelegramUpdateInTx(tx, updateId, {
        senderId: String(senderId),
        chatId: chatId != null ? String(chatId) : null,
      });
      if (!claim.claimed) {
        return { duplicate: true, reason: claim.reason };
      }

      const outbox = [];
      await dispatchUpdate(update, chatId, { client: tx, outbox });
      await completeTelegramUpdateInTx(tx, claim.receiptId);
      return { duplicate: false, outbox };
    },
    { timeout: TRANSACTION_TIMEOUT_MS }
  );

  if (txResult.duplicate) {
    // Item 13 — duplicate legítimo: nunca tratado como erro.
    return { status: `duplicate_${txResult.reason.toLowerCase()}` };
  }

  // Item 25 — replies só DEPOIS da transação já ter commitado.
  await flushOutbox(txResult.outbox);
  return { status: "processed" };
}
