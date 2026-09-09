import { prisma } from "./prisma.js";
import { parseTransaction } from "./parseTransaction.js";
import { commitBotIntent } from "./commitBotIntent.js";
import { resolveDate, resolveEconomicDate, ECONOMIC_DATE_STATUS } from "./naturalDate.js";
import { extractAmount } from "./amountExtractor.js";
import { extractCardFields, extractRecurringBillFields } from "./configExtractors.js";
import { isInWizard, handleWizardText, cancelWizard } from "./botWizard.js";
import { classifyIntent } from "./intentClassifier.js";
import { SIMULATION_TRANSACTIONAL_INTENTS, handleTransactionalSimulationIntent, resolveSimulationPending } from "./telegramSimulation.js";

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const YES_RE = /^(s|sim|yes|confirmo|isso|correto|ok)\b/i;
const NO_RE = /^(n|nao|não|no|errado|cancela)\b/i;

// Interpreta e grava uma mensagem de texto livre do Telegram. `chatId` é obrigatório porque
// o fluxo de confirmação (pra mensagens ambíguas) precisa de estado por chat, guardado no
// banco — o webhook de produção roda numa function serverless sem memória entre chamadas.
//
// Fase 5.3C.2 — `client` opcional (default: `prisma`): permite que
// lib/telegramUpdateHandler.js processe a mensagem inteira (incluindo o
// eventual commitBotIntent) dentro da MESMA transação que reivindica o
// update_id — claim + toda mutação persistente + marcar completo, tudo
// atômico. Nenhum call-site existente muda de comportamento.
export async function processTelegramMessage(text, chatId, { client = prisma } = {}) {
  // O assistente guiado (menu de botões) tem prioridade — enquanto ativo, toda mensagem do
  // chat pertence a ele, não ao parser normal. Ele mesmo edita/manda a mensagem do Telegram,
  // então não devolve `reply` — o entrypoint não precisa (nem deve) mandar nada de novo.
  if (await isInWizard(chatId, { client })) {
    if (text.trim() === "/cancelar") {
      await cancelWizard(chatId, { client });
    } else {
      await handleWizardText(chatId, text, { client });
    }
    return { ok: true, handled: true };
  }

  const pending = await consumePendingIfPresent(chatId, text, client);
  if (pending) return pending;

  // Fase 5.3E.1 — intents de simulação que podem precisar de clarificação
  // (método de pagamento, qual cartão, timing de contingência) rodam AQUI,
  // ANTES de parseTransaction — nunca chegam em commitBotIntent (item 12:
  // ZERO mutação financeira). Diferente de SIMULATION_BYPASS_INTENTS (só
  // simulate_cash_expense, tratado por lib/telegramUpdateHandler.js como
  // READ, fora desta função inteira) — esta família PODE gravar um
  // PendingBotMessage (infraestrutura não-financeira, documentada) quando
  // precisa perguntar algo.
  const classifiedForSimulation = classifyIntent(text);
  if (SIMULATION_TRANSACTIONAL_INTENTS.has(classifiedForSimulation.intent)) {
    const result = await handleTransactionalSimulationIntent(classifiedForSimulation, { client });
    if (result.pending) await upsertSimulationPending(chatId, text, result.pending, client);
    return { ok: true, reply: result.reply };
  }

  const parsed = await parseTransaction(text);
  if (!parsed) {
    return {
      ok: false,
      reply: 'Não consegui achar um valor nessa mensagem. Tenta algo tipo "50 mercado pix" ou "recebi 200 freela".',
    };
  }

  // Fase 5.3D, item 27 — caso recusado explicitamente (hoje só
  // UNSUPPORTED_HISTORICAL_BALANCE_OBSERVATION): nunca chega em
  // commitBotIntent, mesmo sem needsConfirmation/pendingSelection.
  if (parsed.unsupported) {
    return { ok: false, reply: parsed.reply };
  }

  if (parsed.needsConfirmation) {
    await upsertPending(chatId, parsed, client);
    return { ok: true, pending: true, reply: parsed.confirmationPrompt };
  }

  const { reply } = await commitBotIntent(parsed.intent, parsed.data, { source: "telegram", client });
  return { ok: true, reply };
}

// Fase 5.3D — checagem RÁPIDA e barata (sem consumir/apagar nada) usada por
// lib/telegramUpdateHandler.js pra decidir se um texto deve ser tratado como
// resposta a uma confirmação pendente (nunca como READ intent — wizard e
// pending confirmation sempre têm precedência sobre leitura, ver item 2).
export async function hasPendingConfirmation(chatId, { client = prisma } = {}) {
  const pending = await client.pendingBotMessage.findUnique({ where: { chatId } });
  return pending != null && pending.expiresAt > new Date();
}

// Fase 5.3E.1, item 12 — mesma tabela (PendingBotMessage), payload de forma
// DIFERENTE do resto (aqui é direto o estágio da clarificação, não
// {data, pendingSelection}) — por isso `intent: "simulation_clarification"`
// é checado ANTES de tudo em consumePendingIfPresent, nunca cai nos ramos
// abaixo (que terminam em commitBotIntent).
async function upsertSimulationPending(chatId, rawMessage, pendingSpec, client) {
  await client.pendingBotMessage.upsert({
    where: { chatId },
    create: {
      chatId,
      intent: "simulation_clarification",
      parsedPayload: JSON.parse(JSON.stringify(pendingSpec.data)),
      promptMessage: pendingSpec.promptMessage,
      rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
    update: {
      intent: "simulation_clarification",
      parsedPayload: JSON.parse(JSON.stringify(pendingSpec.data)),
      promptMessage: pendingSpec.promptMessage,
      rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
  });
}

async function upsertPending(chatId, parsed, client) {
  const payload = JSON.parse(JSON.stringify({ data: parsed.data, pendingSelection: parsed.pendingSelection || null }));
  await client.pendingBotMessage.upsert({
    where: { chatId },
    create: {
      chatId,
      intent: parsed.intent,
      parsedPayload: payload,
      promptMessage: parsed.confirmationPrompt,
      rawMessage: parsed.rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
    update: {
      intent: parsed.intent,
      parsedPayload: payload,
      promptMessage: parsed.confirmationPrompt,
      rawMessage: parsed.rawMessage,
      expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
    },
  });
}

async function consumePendingIfPresent(chatId, text, client) {
  const pending = await client.pendingBotMessage.findUnique({ where: { chatId } });
  if (!pending) return null;

  if (pending.expiresAt <= new Date()) {
    await client.pendingBotMessage.delete({ where: { id: pending.id } }).catch(() => {});
    return null;
  }

  // Fase 5.3E.1, item 12 — clarificação de SIMULAÇÃO (método de pagamento/
  // qual cartão/timing de contingência): payload próprio (estágio direto),
  // resolvido inteiramente em lib/telegramSimulation.js. NUNCA cai em
  // commitBotIntent em nenhum ramo — zero mutação financeira, mesmo quando
  // encadeia uma segunda pergunta (ex: "parcelado" sem dizer quantas vezes).
  if (pending.intent === "simulation_clarification") {
    const result = await resolveSimulationPending(pending, text.trim(), { client });
    await client.pendingBotMessage.delete({ where: { id: pending.id } }).catch(() => {});
    if (result.pending) await upsertSimulationPending(chatId, text, result.pending, client);
    return { ok: true, reply: result.reply };
  }

  const selection = pending.parsedPayload?.pendingSelection;
  const data = pending.parsedPayload?.data ?? pending.parsedPayload;
  const answer = text.trim();

  if (selection?.type === "provide_date") {
    return resolveProvideDate(pending, data, answer, client);
  }
  if (selection?.type === "provide_economic_date") {
    return resolveProvideEconomicDate(pending, data, answer, client);
  }
  if (selection?.type === "provide_amount") {
    return resolveProvideAmount(pending, data, answer, client);
  }
  if (selection?.type === "provide_amount_and_date") {
    return resolveProvideAmountAndDate(pending, data, answer, client);
  }
  if (selection?.type === "choose_bill") {
    return resolveChooseBill(pending, data, selection, answer, client);
  }
  if (selection?.type === "choose_option") {
    return resolveChooseOption(pending, data, selection, answer, client);
  }
  if (selection?.type === "provide_card_fields") {
    return resolveProvideCardFields(pending, data, answer, client);
  }
  if (selection?.type === "provide_recurring_fields") {
    return resolveProvideRecurringFields(pending, data, answer, client);
  }
  if (selection?.type === "provide_target_amount") {
    return resolveProvideTargetAmount(pending, data, answer, client);
  }
  if (selection?.type === "choose_goal") {
    return resolveChooseGoal(pending, data, selection, answer, client);
  }

  return resolveYesNo(pending, data, answer, client);
}

async function resolveYesNo(pending, data, answer, client) {
  if (YES_RE.test(answer)) {
    await client.pendingBotMessage.delete({ where: { id: pending.id } });
    const { reply } = await commitBotIntent(pending.intent, data, { source: "telegram", client });
    return { ok: true, reply };
  }
  if (NO_RE.test(answer)) {
    await client.pendingBotMessage.delete({ where: { id: pending.id } });
    return { ok: false, reply: "Beleza, cancelei o registro. Manda de novo com mais detalhes." };
  }
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  return null; // nem sim nem não: assume que mudou de assunto, processa a mensagem nova
}

async function resolveProvideDate(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const dueDate = await resolveDate(answer);
  if (!dueDate) {
    return { ok: false, reply: "Não entendi a data. Tenta de novo do zero, tipo \"preciso pagar X dia 20\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, dueDate }, { source: "telegram", client });
  return { ok: true, reply };
}

// Fase 5.3D — resposta à pergunta de clarificação de data econômica vaga
// (item 21: "semana passada" etc. nunca vira uma data sozinha). A resposta
// do usuário passa pelo MESMO resolver — se ainda vier ambígua (raro, mas
// possível: "essa semana" de novo), pergunta de novo em vez de desistir e
// chutar hoje.
async function resolveProvideEconomicDate(pending, data, answer, client) {
  const resolved = resolveEconomicDate(answer);
  if (resolved.status === ECONOMIC_DATE_STATUS.AMBIGUOUS) {
    return { ok: false, reply: `Ainda não ficou claro o dia exato. Pode ser algo tipo "dia 25", "terça", "ontem"?` };
  }
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const { reply } = await commitBotIntent(pending.intent, { ...data, occurredAt: resolved.date }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveProvideAmount(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  if (amount === null) {
    return { ok: false, reply: "Não entendi o valor. Tenta de novo do zero." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, amount }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveProvideAmountAndDate(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  const dueDate = await resolveDate(answer);
  if (amount === null || !dueDate) {
    return { ok: false, reply: "Não entendi valor e/ou data. Tenta de novo do zero, tipo \"preciso pagar 300 dia 20\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, amount, dueDate }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveProvideCardFields(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const fields = extractCardFields(answer);
  if (fields.totalLimit == null || fields.dueDay == null) {
    return { ok: false, reply: "Ainda faltou o limite e/ou o vencimento. Tenta de novo do zero, tipo \"criar cartão Nubank, limite 5000, vencimento dia 10\"." };
  }
  const merged = { ...data, totalLimit: fields.totalLimit, dueDay: fields.dueDay, closingDay: fields.closingDay ?? data.closingDay };
  const { reply } = await commitBotIntent(pending.intent, merged, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveProvideRecurringFields(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const fields = extractRecurringBillFields(answer);
  if (fields.amount == null || fields.dayOfMonth == null) {
    return { ok: false, reply: "Ainda faltou o valor e/ou o dia. Tenta de novo do zero, tipo \"internet, 117 reais, todo dia 10\"." };
  }
  const merged = { ...data, recurringAmount: fields.amount, dayOfMonth: fields.dayOfMonth };
  const { reply } = await commitBotIntent(pending.intent, merged, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveProvideTargetAmount(pending, data, answer, client) {
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const { amount } = extractAmount(answer);
  if (amount === null) {
    return { ok: false, reply: "Não entendi o valor. Tenta de novo do zero." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, targetAmount: amount }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveChooseGoal(pending, data, selection, answer, client) {
  const index = parseInt(answer, 10);
  const candidate = Number.isInteger(index) ? selection.candidates[index - 1] : null;
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  if (!candidate) {
    return { ok: false, reply: "Não entendi qual meta. Manda de novo, tipo \"guardei mais 100 pra meta notebook\"." };
  }
  const { reply } = await commitBotIntent(pending.intent, { ...data, goalId: candidate.id }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveChooseBill(pending, data, selection, answer, client) {
  const index = parseInt(answer, 10);
  const candidate = Number.isInteger(index) ? selection.candidates[index - 1] : null;
  if (!candidate) {
    await client.pendingBotMessage.delete({ where: { id: pending.id } });
    return { ok: false, reply: "Não entendi qual conta. Manda de novo, tipo \"paguei aqueles 300 da minha mãe\"." };
  }
  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  const { reply } = await commitBotIntent(pending.intent, { ...data, billId: candidate.id }, { source: "telegram", client });
  return { ok: true, reply };
}

async function resolveChooseOption(pending, data, selection, answer, client) {
  const normalized = answer.toLowerCase();
  const index = parseInt(answer, 10);
  const byIndex = Number.isInteger(index) ? selection.options[index - 1] : null;
  const byKeyword = selection.options.find((o) => {
    if (normalized.includes(o.key)) return true;
    const labelWords = o.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return labelWords.some((w) => normalized.includes(w));
  });
  const chosen = byIndex || byKeyword;

  await client.pendingBotMessage.delete({ where: { id: pending.id } });
  if (!chosen) {
    return { ok: false, reply: "Não entendi a opção. Manda de novo com mais detalhes." };
  }

  if (chosen.key === "expense") {
    const { reply } = await commitBotIntent("expense", data, { source: "telegram", client });
    return { ok: true, reply };
  }
  const { reply } = await commitBotIntent("pay_bill", { ...data, billId: null }, { source: "telegram", client });
  return { ok: true, reply };
}
