import { prisma } from "./prisma.js";
import { runGuarded, friendlyErrorMessage } from "./txGuard.js";
import { CATEGORIES } from "./categoryRules.js";
import { extractAmount } from "./amountExtractor.js";
import { resolveDate, resolveEconomicDate } from "./naturalDate.js";
import { createBill, markBillPaid, listBills } from "./bills.js";
import { listContingencies } from "./contingencies.js";
import { commitBotIntent } from "./commitBotIntent.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { serializeMoney, subtractMoney } from "./money.js";
import { resolveCurrentBillSafely } from "./cardBillCalculator.js";
import { sendMessage, editMessageText, buildInlineKeyboard, chunk } from "./telegramApi.js";
import { previewBalanceReconciliation, applyBalanceReconciliation } from "./balanceReconciliation.js";
import { previewCardBillReconciliation, applyCardBillReconciliation } from "./cardBillReconciliation.js";
import { simulateFinancialScenario } from "./simulation/financialSimulator.js";
import { formatVerdict } from "./telegramSimulation.js";
import { computeCategoryBreakdown } from "./categoryBreakdown.js";
import { formatCategoryBreakdownReply } from "./telegramAi/responseFormatter.js";
import { applyGuardedCorrection, describeFieldChanges } from "./telegramAi/correctionService.js";

const WIZARD_TTL_MS = 20 * 60 * 1000;

// Datas do wizard (itens 31/38): "Hoje"/"Ontem" são sempre o dia-calendário
// LOCAL do app (lib/appTimezone.js) guardado como meia-noite UTC — a mesma
// convenção de resolveEconomicDate/Telegram legado. NUNCA new Date()/
// Date.now()-24h crus: à noite (ex.: 22h em UTC-3 já é o dia seguinte em
// UTC) isso mostraria/gravaria o dia errado.
export function quickDateISO(key, now = new Date()) {
  return resolveEconomicDate(key === "ontem" ? "ontem" : "hoje", now).date.toISOString();
}

const STRICT_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;

// "Outra data": só DD/MM ou DD/MM/AAAA (mais hoje/ontem/anteontem digitados).
// Qualquer outra coisa — texto solto, data inexistente (31/02), mês 13 — é
// REJEITADA; nunca cai em "hoje" por default (resolveEconomicDate devolve
// TODAY pra texto sem marcador, o que aqui seria um erro silencioso).
export function parseWizardDateText(text, now = new Date()) {
  const t = String(text ?? "").trim().toLowerCase();
  if (t === "hoje" || t === "ontem" || t === "anteontem") return { ok: true, date: resolveEconomicDate(t, now).date };
  const m = t.match(STRICT_DATE_RE);
  if (!m) return { ok: false };
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : resolveEconomicDate("hoje", now).date.getUTCFullYear();
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { ok: false };
  return { ok: true, date };
}

const QUICK_DUE_OPTIONS = [
  { text: "Hoje", value: "hoje" },
  { text: "Amanhã", value: "amanha" },
  { text: "Dia 10", value: "dia 10" },
  { text: "Dia 15", value: "dia 15" },
  { text: "Dia 20", value: "dia 20" },
  { text: "Fim do mês", value: "fim do mes" },
];

const QUICK_INSTALLMENT_COUNTS = [2, 3, 4, 5, 6];

const FLOW_START = {
  nova_conta: startNovaConta,
  gasto: startValorFirst,
  receita: startValorFirst,
  parcela: startParcela,
  vou_pagar_menu: startVouPagarMenu,
  // Fase 7D — Telegram determinístico / menu-driven.
  cartao_compra: startCartaoCompra,
  transferencia: startTransferencia,
  saldo_itau: (session, client) => startSaldoConta(session, client, "checking", "Itaú"),
  saldo_va: (session, client) => startSaldoConta(session, client, "food_voucher", "Vale Alimentação"),
  fatura_atual: startFaturaAtual,
  fatura_pagar: startFaturaPagar,
  multipla: startMultipla,
  compromisso: startCompromisso,
  contingencia: startContingencia,
  recebivel: startRecebivel,
  simulador: startSimulador,
  categoria_periodo: startCategoriaPeriodo,
  // Fase 7D.1 — fechamento do menu de planejamento (marcar pago/resolvido/
  // recebido, editar) e metas (criar/editar).
  compromisso_pagar: startCompromissoPagar,
  compromisso_editar: startCompromissoEditar,
  contingencia_resolver: startContingenciaResolver,
  contingencia_editar: startContingenciaEditar,
  recebivel_receber: startRecebivelReceber,
  recebivel_editar: startRecebivelEditar,
  meta_nova: startMetaNova,
  meta_editar: startMetaEditar,
};

// Menu principal — teclado fixo do Telegram (fica sempre visível embaixo da caixa de
// texto, diferente do teclado inline usado dentro de cada pergunta do assistente).
// Fase 7D: o menu PRINCIPAL de navegação agora é o menu raiz inline (ver
// lib/telegramMenu.js) — este teclado fixo continua existindo só como atalho
// rápido complementar (nunca removido, item "não remover" aplicado por
// analogia: nenhum fluxo existente que dependa dele quebra).
export const MENU_FLOWS = {
  "💸 Gastei": "gasto",
  "💰 Recebi": "receita",
  "🔁 Parcelei": "parcela",
  "📋 Vou pagar": "vou_pagar_menu",
};

export const MAIS_OPCOES_LABEL = "⚙️ Mais opções";

export const MAIS_OPCOES_TEXT = [
  "Isso aqui continua funcionando por texto, sem precisar de botão:",
  "",
  "• Transferência: \"transferi 100 pro dinheiro\"",
  "• Ajuste de saldo: \"meu saldo no itaú é 800 reais\"",
  "• Ajuste de limite do cartão: \"tenho 1500 disponíveis no cartão\"",
  "• Criar cartão: \"criar cartão Nubank, limite 5000, vencimento dia 10\"",
  "• Criar conta: \"criar conta Inter\"",
  "• Criar conta fixa: \"criar conta fixa: Netflix, 39,90 reais, todo dia 5\"",
  "• Criar meta: \"criar meta: guardar 1000 pra notebook\"",
  "• Guardar numa meta: \"guardei mais 100 pra meta notebook\"",
].join("\n");

export function buildMainMenuKeyboard() {
  return {
    keyboard: [["💸 Gastei", "💰 Recebi"], ["🔁 Parcelei", "📋 Vou pagar"], [MAIS_OPCOES_LABEL]],
    resize_keyboard: true,
  };
}

export async function sendMainMenu(chatId, text) {
  await sendMessage(chatId, text, { replyMarkup: buildMainMenuKeyboard() });
}

// Fase 5.3C.2 — `client` opcional (default: `prisma`) em TODA função deste
// arquivo que toca o banco: permite que lib/telegramUpdateHandler.js envolva
// o processamento de um update inteiro numa única `prisma.$transaction` —
// ou tudo persiste (claim do update + avanço/conclusão do wizard), ou nada
// persiste. Nenhum call-site pré-existente muda de comportamento (default
// idêntico ao anterior).
//
// Exceção documentada (item 25 do pedido, aplicada com bom senso): as
// chamadas de `ask()`/Telegram que só fazem NAVEGAÇÃO DE UI (perguntar a
// próxima pergunta do assistente) continuam acontecendo diretamente, mesmo
// dentro da transação — porque `ask()` às vezes precisa aprender o
// `message_id` retornado pelo Telegram pra persisti-lo (pra poder EDITAR a
// mesma mensagem no próximo passo, em vez de floodar o chat) e isso exige a
// resposta real da API antes de continuar. Isso é um detalhe de UX sem
// nenhum efeito financeiro — nunca um Expense/Income/etc. Só o passo FINAL
// que efetivamente comita uma mutação financeira (branch "confirm:yes" em
// handleWizardCallback) tem sua resposta ADIADA pra depois do commit da
// transação — esse é o caminho que item 25 realmente protege.
export async function cancelWizard(chatId, { client = prisma } = {}) {
  const session = await client.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  await client.botWizardSession.delete({ where: { id: session.id } });
  await sendMessage(chatId, "Cancelado. Pode usar o menu de novo quando quiser.");
  return true;
}

export async function isInWizard(chatId, { client = prisma } = {}) {
  const session = await client.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  if (session.expiresAt <= new Date()) {
    await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    return false;
  }
  return true;
}

export async function startWizard(chatId, flow, { client = prisma } = {}) {
  const starter = FLOW_START[flow];
  if (!starter) throw new Error(`Fluxo de assistente desconhecido: ${flow}`);

  await client.botWizardSession.deleteMany({ where: { chatId } });
  const session = await client.botWizardSession.create({
    data: { chatId, flow, step: "start", data: {}, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });
  await starter(session, client);
}

async function updateStep(session, step, dataPatch, { flow, client = prisma } = {}) {
  const data = { ...session.data, ...dataPatch };
  await client.botWizardSession.update({
    where: { id: session.id },
    data: { step, data, flow: flow || session.flow, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });
  session.step = step;
  session.data = data;
  if (flow) session.flow = flow;
  return session;
}

// Edita a mensagem do assistente se ela já existe, ou manda uma nova (1ª pergunta de um
// flow, ou transição pra outro flow dentro da mesma sessão) — sempre a MESMA mensagem indo
// e voltando, em vez de floodar o chat com uma mensagem por passo.
async function ask(session, text, options, client = prisma) {
  if (session.messageId) {
    await editMessageText(session.chatId, session.messageId, text, options);
    return;
  }
  const sent = await sendMessage(session.chatId, text, options);
  if (sent?.result?.message_id) {
    // .catch: a sessão pode já ter sido apagada (ex: finish() chamado antes
    // de qualquer ask() anterior ter setado messageId — caso raro, já
    // pré-existente antes desta fase). Não deixa um erro de UX derrubar o
    // processamento em si.
    await client.botWizardSession.update({ where: { id: session.id }, data: { messageId: sent.result.message_id } }).catch(() => {});
    session.messageId = sent.result.message_id;
  }
}

// finishNonFinancial: usado pelos flows que NÃO commitam nada financeiro no
// fim — continua com ask() inline, sem necessidade de adiar resposta.
async function finish(session, reply, client = prisma) {
  await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
  await ask(session, reply || "✅ Feito.", undefined, client);
}

const CONFIRM_KEYBOARD = buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]);
const NAV_ROW = [{ text: "🏠 Menu", data: "wiznav:menu" }, { text: "❌ Cancelar", data: "wiznav:cancel" }];

function withNav(rows) {
  return buildInlineKeyboard([...rows, NAV_ROW]);
}

// --- utilitário: teclado de conta/cartão pra pagar/receber ---
async function targetKeyboard(client = prisma) {
  const [accounts, cards] = await Promise.all([
    client.account.findMany({ orderBy: { createdAt: "asc" } }),
    client.card.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const buttons = [
    ...accounts.map((a) => ({ text: a.name, data: `tgt:account:${a.id}` })),
    ...cards.map((c) => ({ text: `Cartão ${c.name}`, data: `tgt:card:${c.id}` })),
  ];
  return buildInlineKeyboard(chunk(buttons, 2));
}

async function resolveTarget(callbackData, client = prisma) {
  const [, type, id] = callbackData.split(":");
  if (type === "account") {
    const account = await client.account.findUnique({ where: { id } });
    return { type: "account", account };
  }
  const card = await client.card.findUnique({ where: { id } });
  return { type: "card", card };
}

async function findAccountByType(type, client = prisma) {
  return client.account.findFirst({ where: { type }, orderBy: { createdAt: "asc" } });
}

async function accountKeyboard(client, excludeId) {
  const accounts = await client.account.findMany({ orderBy: { createdAt: "asc" } });
  const filtered = excludeId ? accounts.filter((a) => a.id !== excludeId) : accounts;
  return buildInlineKeyboard(chunk(filtered.map((a) => ({ text: a.name, data: `acct:${a.id}` })), 2));
}

async function cardKeyboard(client, prefix = "card") {
  const cards = await client.card.findMany({ orderBy: { createdAt: "asc" } });
  return { cards, keyboard: buildInlineKeyboard(chunk(cards.map((c) => ({ text: c.name, data: `${prefix}:${c.id}` })), 2)) };
}

const CATEGORY_KEYBOARD_ROWS = chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2);

// ============================== nova_conta ==============================

async function startNovaConta(session, client = prisma) {
  const keyboard = buildInlineKeyboard(CATEGORY_KEYBOARD_ROWS);
  await updateStep(session, "categoria", {}, { flow: "nova_conta", client });
  await ask(session, "Nova conta a pagar 📋\n\nQue categoria?", { replyMarkup: keyboard }, client);
}

async function finishNovaContaDate(session, client = prisma) {
  const dueDate = session.data.pendingDate ? new Date(session.data.pendingDate) : null;
  if (!dueDate) {
    await updateStep(session, "vencimento_texto", {}, { client });
    await ask(session, "Não entendi essa data. Digite de novo (ex: \"dia 25\", \"mês que vem\"):", undefined, client);
    return;
  }
  await updateStep(session, "confirmar", { dueDateISO: dueDate.toISOString() }, { client });
  const summary = [
    "Confirma?", "",
    `📋 ${session.data.description}`,
    `💰 ${formatMoney(session.data.amount)}`,
    `📅 ${formatDate(dueDate)}`,
    `🏷️ ${session.data.category}`,
  ].join("\n");
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

// commit* — SEM chamada a ask()/sendMessage aqui dentro (item 25): só
// calculam e persistem, devolvem o texto de resposta. Quem chama (o branch
// "confirm:yes" abaixo) decide quando/como enviar, DEPOIS do commit da
// transação.
async function commitNovaConta(session, client) {
  const bill = await createBill({
    description: session.data.description,
    amount: session.data.amount,
    category: session.data.category,
    dueDate: new Date(session.data.dueDateISO),
    source: "telegram",
    rawMessage: "assistente guiado",
  }, { client });
  return `✅ Conta "${bill.description}" criada: ${formatMoney(bill.amount)}, vence em ${formatDate(bill.dueDate)}.`;
}

// ============================== gasto / receita (item 5/6) ==============================
//
// Fase 7D — fluxo rico: valor -> descrição -> como pagou/de onde entra ->
// categoria -> data (Hoje/Ontem/Outra) -> preview -> confirmar/editar/cancelar.
// commitBotIntent("expense"/"income", ...) continua o ÚNICO lugar que grava
// (item 5: "não duplicar lógica financeira no wizard").

const EXPENSE_PAYMENT_OPTIONS = [
  { text: "💸 Pix / Itaú", data: "pm:pix", accountType: "checking", paymentMethod: "pix" },
  { text: "💳 Cartão Itaú", data: "pm:cartao", isCard: true, paymentMethod: "cartao_credito" },
  { text: "🥗 Vale Alimentação", data: "pm:va", accountType: "food_voucher", paymentMethod: "vale" },
  { text: "💵 Dinheiro", data: "pm:dinheiro", accountType: "cash", paymentMethod: "dinheiro" },
];

const INCOME_TARGET_ACCOUNT_TYPES = [
  { text: "🏦 Conta Itaú", data: "pm:pix", accountType: "checking" },
  { text: "🥗 Vale Alimentação", data: "pm:va", accountType: "food_voucher" },
  { text: "💵 Dinheiro", data: "pm:dinheiro", accountType: "cash" },
];

async function startValorFirst(session, client = prisma) {
  const label = session.flow === "receita" ? "Nova receita 💰" : "Nova despesa 🧾";
  await updateStep(session, "valor", {}, { client });
  await ask(session, `${label}\n\nQuanto foi?`, undefined, client);
}

async function askDescricao(session, client) {
  const isReceita = session.flow === "receita";
  await updateStep(session, "descricao", {}, { client });
  await ask(session, `Valor: ${formatMoney(session.data.amount)}\n\n${isReceita ? "Qual a origem?" : "Qual a descrição?"}`, undefined, client);
}

async function askComoPagou(session, client) {
  const isReceita = session.flow === "receita";
  const options = isReceita ? INCOME_TARGET_ACCOUNT_TYPES : EXPENSE_PAYMENT_OPTIONS;
  const keyboard = withNav(chunk(options.map((o) => ({ text: o.text, data: o.data })), 2));
  await updateStep(session, "meio", {}, { client });
  await ask(session, `${session.data.description}\n\n${isReceita ? "Onde entrou?" : "Como pagou?"}`, { replyMarkup: keyboard }, client);
}

async function askCategoria(session, client) {
  await updateStep(session, "categoria", {}, { client });
  await ask(session, `${session.data.targetLabel}\n\nQue categoria?`, { replyMarkup: withNav(CATEGORY_KEYBOARD_ROWS) }, client);
}

const DATE_QUICK_KEYBOARD = withNav([
  [{ text: "Hoje", data: "date:hoje" }, { text: "Ontem", data: "date:ontem" }],
  [{ text: "Outra data", data: "date:outra" }],
]);

async function askData(session, client) {
  await updateStep(session, "data", {}, { client });
  await ask(session, `Categoria: ${session.data.category}\n\nQuando foi?`, { replyMarkup: DATE_QUICK_KEYBOARD }, client);
}

function startOfDayUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function applyQuickDate(session, key, client) {
  if (key === "hoje") return finishGastoReceitaConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("hoje") }, { client }), client);
  if (key === "ontem") {
    return finishGastoReceitaConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("ontem") }, { client }), client);
  }
  await updateStep(session, "data_texto", {}, { client });
  await ask(session, "Digite a data (ex: \"12/03\" ou \"12/03/2026\"):", undefined, client);
}

// Item 29 — "✏️ Editar" no preview: reabre SÓ o campo escolhido, sem
// reiniciar o wizard inteiro. `session.data.editing` marca que o próximo
// passo completado deve voltar DIRETO pro preview (em vez de seguir a
// cadeia normal valor->descrição->meio->categoria->data) — setado por
// editfield:<campo> abaixo, limpo assim que o preview é re-renderizado.
const EDIT_FIELD_KEYBOARD = buildInlineKeyboard([
  [{ text: "💰 Valor", data: "editfield:valor" }, { text: "📝 Descrição", data: "editfield:descricao" }],
  [{ text: "💳 Meio/conta", data: "editfield:meio" }, { text: "🏷 Categoria", data: "editfield:categoria" }],
  [{ text: "📅 Data", data: "editfield:data" }],
  [{ text: "⬅️ Voltar", data: "editfield:voltar" }],
]);

// Fase 7D.1 — edição no preview pra cartão simples/parcelado/transferência.
// Em vez de checar `editing` em cada call-site da cadeia, toda função
// "ask*" (a PRÓXIMA pergunta da cadeia normal) volta direto pro preview
// quando o flag está ligado — o campo editado já foi gravado por quem a
// chamou, e o resto do estado fica intacto.
async function renderConfirmForFlow(session, client) {
  if (session.flow === "gasto" || session.flow === "receita") return finishGastoReceitaConfirm(session, client);
  if (session.flow === "cartao_compra") return finishCartaoCompraConfirm(session, client);
  if (session.flow === "parcela") return finishParcelaConfirm2(session, client);
  if (session.flow === "transferencia") return finishTransferenciaConfirm(session, client);
}

async function returnToConfirmIfEditing(session, client) {
  if (!session.data.editing) return false;
  if (!["cartao_compra", "parcela", "transferencia"].includes(session.flow)) return false;
  await updateStep(session, "confirmar", { editing: false }, { client });
  await renderConfirmForFlow(session, client);
  return true;
}

const EDIT_MENUS = {
  cartao_compra: [
    [["💰 Valor", "valor"], ["📝 Descrição", "descricao"]],
    [["💳 Cartão", "cartao"], ["🏷 Categoria", "categoria"]],
    [["📅 Data", "data"]],
  ],
  parcela: [
    [["💰 Valor total", "valor"], ["📝 Descrição", "descricao"]],
    [["🏪 Loja", "merchant"], ["🔢 Parcelas", "parcelas"]],
    [["💳 Cartão", "cartao"], ["📅 Data", "data"]],
  ],
  transferencia: [
    [["💰 Valor", "valor"], ["🏦 Origem", "origem"]],
    [["🏦 Destino", "destino"], ["📝 Descrição", "descricao"]],
    [["📅 Data", "data"]],
  ],
};

function editMenuKeyboard(flow) {
  const rows = EDIT_MENUS[flow];
  if (!rows) return EDIT_FIELD_KEYBOARD;
  return buildInlineKeyboard([...rows.map((row) => row.map(([text, field]) => ({ text, data: `editfield:${field}` }))), [{ text: "⬅️ Voltar", data: "editfield:voltar" }]]);
}

// Abre SÓ o campo pedido (flag editing ligado) sem recomeçar o wizard.
async function startEditField(session, field, client) {
  if (field === "voltar") return renderConfirmForFlow(session, client);
  const flow = session.flow;

  if (flow === "gasto" || flow === "receita") {
    await updateStep(session, field === "meio" ? "meio" : field, { editing: true }, { client });
    if (field === "valor") return ask(session, "Novo valor?", undefined, client);
    if (field === "descricao") return ask(session, "Nova descrição?", undefined, client);
    if (field === "meio") return askComoPagou(session, client);
    if (field === "categoria") return ask(session, "Nova categoria?", { replyMarkup: withNav(CATEGORY_KEYBOARD_ROWS) }, client);
    if (field === "data") return ask(session, "Nova data?", { replyMarkup: DATE_QUICK_KEYBOARD }, client);
    return;
  }

  const allowed = (EDIT_MENUS[flow] || []).flat().map(([, f]) => f);
  if (!allowed.includes(field)) return; // campo que este flow não edita — fail closed.

  await updateStep(session, field, { editing: true }, { client });
  if (field === "valor") return ask(session, flow === "parcela" ? "Novo valor TOTAL?" : "Novo valor?", undefined, client);
  if (field === "descricao") {
    if (flow === "transferencia") return ask(session, "Nova descrição? (opcional)", { replyMarkup: withNav([[{ text: "Pular", data: "skip:descricao" }]]) }, client);
    return ask(session, "Nova descrição?", undefined, client);
  }
  if (field === "merchant") return ask(session, "Nova loja/merchant? (opcional)", { replyMarkup: withNav([[{ text: "Pular", data: "skip:merchant" }]]) }, client);
  if (field === "parcelas") return ask(session, "Em quantas vezes?", { replyMarkup: parcelasKeyboard() }, client);
  if (field === "categoria") return ask(session, "Nova categoria?", { replyMarkup: withNav(CATEGORY_KEYBOARD_ROWS) }, client);
  if (field === "data") return ask(session, "Nova data?", { replyMarkup: DATE_QUICK_KEYBOARD }, client);
  if (field === "cartao") {
    const { cards, keyboard } = await cardKeyboard(client, "card");
    if (cards.length <= 1) return renderConfirmForFlow(await updateStep(session, "confirmar", { editing: false }, { client }), client); // só existe 1 cartão — nada a trocar.
    return ask(session, "Qual cartão?", { replyMarkup: withNav(keyboard.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
  }
  if (field === "origem") {
    const keyboard = await accountKeyboard(client, session.data.toAccountId);
    return ask(session, "De onde sai o dinheiro?", { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
  }
  if (field === "destino") {
    const keyboard = await accountKeyboard(client, session.data.fromAccountId);
    return ask(session, "Pra onde vai?", { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
  }
}

async function finishGastoReceitaConfirm(session, client = prisma) {
  const isReceita = session.flow === "receita";
  const occurredAt = session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date();
  const summary = [
    session.data.description,
    formatMoney(session.data.amount),
    `${session.data.targetLabel}${session.data.paymentMethodLabel ? ` · ${session.data.paymentMethodLabel}` : ""}`,
    session.data.category,
    formatDate(occurredAt),
  ].join("\n");
  await updateStep(session, "confirmar", { editing: false }, { client });
  await ask(session, summary, { replyMarkup: buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "✏️ Editar", data: "editmenu:gasto" }, { text: "❌ Cancelar", data: "confirm:no" }]]) }, client);
  return session;
}

async function commitGastoReceita(session, client) {
  const target = session.data.targetType === "card"
    ? { type: "card", card: await client.card.findUnique({ where: { id: session.data.targetId } }) }
    : { type: "account", account: await client.account.findUnique({ where: { id: session.data.targetId } }) };

  const data = {
    amount: session.data.amount,
    category: session.data.category,
    description: session.data.description,
    paymentMethod: session.data.paymentMethod || null,
    rawMessage: "assistente guiado",
    isRecurring: false,
    target,
    occurredAt: session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date(),
  };
  const intent = session.flow === "receita" ? "income" : "expense";
  const { reply } = await commitBotIntent(intent, data, { source: "telegram", client });
  return reply;
}

// ============================== compra no cartão simples (item 7) ==============================

async function startCartaoCompra(session, client = prisma) {
  await updateStep(session, "valor", {}, { flow: "cartao_compra", client });
  await ask(session, "Compra no cartão 💳\n\nQual o valor?", undefined, client);
}

async function askCartaoDescricao(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "descricao", {}, { client });
  await ask(session, `Valor: ${formatMoney(session.data.amount)}\n\nQual a descrição?`, undefined, client);
}

async function askCartaoCartao(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  const { cards, keyboard } = await cardKeyboard(client, "card");
  if (cards.length <= 1) {
    const card = cards[0];
    if (!card) {
      await finish(session, "⚠️ Nenhum cartão cadastrado ainda. Cadastra um cartão no site primeiro.", client);
      return;
    }
    return askCartaoCategoria(await updateStep(session, "categoria", { cardId: card.id, cardName: card.name }, { client }), client);
  }
  await updateStep(session, "cartao", {}, { client });
  await ask(session, `${session.data.description}\n\nQual cartão?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function askCartaoCategoria(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "categoria", {}, { client });
  await ask(session, `Cartão: ${session.data.cardName}\n\nQue categoria?`, { replyMarkup: withNav(CATEGORY_KEYBOARD_ROWS) }, client);
}

async function askCartaoData(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "data", {}, { client });
  await ask(session, `Categoria: ${session.data.category}\n\nQuando foi?`, { replyMarkup: DATE_QUICK_KEYBOARD }, client);
}

const EDITABLE_CONFIRM_KEYBOARD = (flow) => buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "✏️ Editar", data: `editmenu:${flow}` }, { text: "❌ Cancelar", data: "confirm:no" }]]);

async function finishCartaoCompraConfirm(session, client) {
  const occurredAt = session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date();
  const summary = [session.data.description, formatMoney(session.data.amount), `Cartão ${session.data.cardName}`, session.data.category, formatDate(occurredAt)].join("\n");
  await updateStep(session, "confirmar", { editing: false }, { client });
  await ask(session, summary, { replyMarkup: EDITABLE_CONFIRM_KEYBOARD("cartao_compra") }, client);
}

async function commitCartaoCompra(session, client) {
  const card = await client.card.findUnique({ where: { id: session.data.cardId } });
  const data = {
    amount: session.data.amount,
    category: session.data.category,
    description: session.data.description,
    rawMessage: "assistente guiado",
    isRecurring: false,
    target: { type: "card", card },
    occurredAt: session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date(),
  };
  const { reply } = await commitBotIntent("expense", data, { source: "telegram", client });
  return reply;
}

// ============================== parcela (item 8) ==============================
//
// Ordem: valor total -> descrição -> loja/merchant (opcional) -> parcelas ->
// cartão -> categoria -> data da compra -> preview -> confirmar. Usa
// EXATAMENTE commitBotIntent("installment_purchase", ...) -> generateInstallmentSchedule
// (Purchase + Installment reais, item "não representar como Expense simples").

async function startParcela(session, client = prisma) {
  await updateStep(session, "valor", {}, { flow: "parcela", client });
  await ask(session, "Compra parcelada 🧩\n\nQual o valor TOTAL?", undefined, client);
}

async function askParcelaDescricao(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "descricao", {}, { client });
  await ask(session, `Valor total: ${formatMoney(session.data.amount)}\n\nQual a descrição?`, undefined, client);
}

async function askParcelaMerchant(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "merchant", {}, { client });
  await ask(session, `${session.data.description}\n\nLoja/merchant? (opcional)`, { replyMarkup: withNav([[{ text: "Pular", data: "skip:merchant" }]]) }, client);
}

const parcelasKeyboard = () => withNav([...chunk(QUICK_INSTALLMENT_COUNTS.map((n) => ({ text: `${n}x`, data: `qtd:${n}` })), 3), [{ text: "Outro", data: "qtd:outro" }]]);

async function askParcelaQtd(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  const keyboard = parcelasKeyboard();
  await updateStep(session, "parcelas", {}, { client });
  await ask(session, "Em quantas vezes?", { replyMarkup: keyboard }, client);
}

async function askParcelaCartao(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  const { cards, keyboard } = await cardKeyboard(client, "card");
  if (cards.length <= 1) {
    const card = cards[0];
    if (!card) {
      await finish(session, "⚠️ Nenhum cartão cadastrado ainda. Cadastra um cartão no site primeiro.", client);
      return;
    }
    return askParcelaCategoria(await updateStep(session, "categoria", { cardId: card.id, cardName: card.name }, { client }), client);
  }
  await updateStep(session, "cartao", {}, { client });
  await ask(session, `${session.data.installmentCount}x\n\nQual cartão?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function askParcelaCategoria(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "categoria", {}, { client });
  await ask(session, `Cartão: ${session.data.cardName}\n\nQue categoria?`, { replyMarkup: withNav(CATEGORY_KEYBOARD_ROWS) }, client);
}

async function askParcelaData(session, client) {
  await updateStep(session, "data", {}, { client });
  await ask(session, `Categoria: ${session.data.category}\n\nQuando foi a compra?`, { replyMarkup: DATE_QUICK_KEYBOARD }, client);
}

// Preview EXATO do exemplo obrigatório (item 8): descrição · merchant / valor
// total / Nx de R$Y / cartão / data — sem mostrar categoria (coletada, mas
// não exibida, igual ao exemplo do pedido).
async function finishParcelaConfirm2(session, client) {
  const occurredAt = session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date();
  // formatMoney() espera NUMBER (usa toLocaleString internamente) — nunca a
  // STRING de .toFixed(2), que "toLocaleString" de string devolve intacta,
  // sem formatar como moeda (achado real do teste desta fase).
  const installmentValue = Number((Number(session.data.amount) / session.data.installmentCount).toFixed(2));
  const title = session.data.merchant ? `${session.data.merchant} · ${session.data.description}` : session.data.description;
  const summary = [title, formatMoney(session.data.amount), `${session.data.installmentCount}x de ${formatMoney(installmentValue)}`, session.data.cardName, formatDate(occurredAt)].join("\n");
  await updateStep(session, "confirmar", { editing: false }, { client });
  await ask(session, summary, { replyMarkup: EDITABLE_CONFIRM_KEYBOARD("parcela") }, client);
}

async function commitParcela(session, client) {
  const card = await client.card.findUnique({ where: { id: session.data.cardId } });
  const data = {
    amount: session.data.amount,
    installmentCount: session.data.installmentCount,
    category: session.data.category,
    description: session.data.merchant ? `${session.data.description} (${session.data.merchant})` : session.data.description,
    rawMessage: "assistente guiado",
    target: { type: "card", card },
    occurredAt: session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date(),
  };
  const { reply } = await commitBotIntent("installment_purchase", data, { source: "telegram", client });
  return reply;
}

// ============================== transferência (item 10) ==============================

async function startTransferencia(session, client = prisma) {
  await updateStep(session, "valor", {}, { flow: "transferencia", client });
  await ask(session, "Transferência 🔄\n\nQual o valor?", undefined, client);
}

async function askTransferenciaOrigem(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  const keyboard = await accountKeyboard(client);
  await updateStep(session, "origem", {}, { client });
  await ask(session, `Valor: ${formatMoney(session.data.amount)}\n\nDe onde sai o dinheiro?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function askTransferenciaDestino(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  const keyboard = await accountKeyboard(client, session.data.fromAccountId);
  await updateStep(session, "destino", {}, { client });
  await ask(session, `Origem: ${session.data.fromAccountName}\n\nPra onde vai?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function askTransferenciaDescricao(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "descricao", {}, { client });
  await ask(session, `${session.data.fromAccountName} → ${session.data.toAccountName}\n\nDescrição? (opcional)`, { replyMarkup: withNav([[{ text: "Pular", data: "skip:descricao" }]]) }, client);
}

async function askTransferenciaData(session, client) {
  if (await returnToConfirmIfEditing(session, client)) return;
  await updateStep(session, "data", {}, { client });
  await ask(session, "Quando foi?", { replyMarkup: DATE_QUICK_KEYBOARD }, client);
}

async function finishTransferenciaConfirm(session, client) {
  const occurredAt = session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date();
  const summary = ["🔄 Transferência", formatMoney(session.data.amount), `${session.data.fromAccountName} → ${session.data.toAccountName}`, session.data.description || "(sem descrição)", formatDate(occurredAt)].join("\n");
  await updateStep(session, "confirmar", { editing: false }, { client });
  await ask(session, summary, { replyMarkup: EDITABLE_CONFIRM_KEYBOARD("transferencia") }, client);
}

async function commitTransferencia(session, client) {
  const data = {
    amount: session.data.amount,
    description: session.data.description || "Transferência",
    fromAccountId: session.data.fromAccountId,
    toAccountId: session.data.toAccountId,
    rawMessage: "assistente guiado",
    occurredAt: session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date(),
  };
  const { reply } = await commitBotIntent("transfer", data, { source: "telegram", client });
  return reply;
}

// ============================== saldo Itaú / VA — reconciliação (item 16) ==============================

async function startSaldoConta(session, client, accountType, label) {
  const account = await findAccountByType(accountType, client);
  if (!account) {
    await finish(session, `⚠️ Não achei uma conta do tipo "${label}" cadastrada.`, client);
    return;
  }
  await updateStep(session, "valor", { accountId: account.id, accountName: account.name }, { flow: "saldo", client });
  await ask(session, `Saldo ${label} 🏦\n\nQual o saldo observado agora?`, undefined, client);
}

async function finishSaldoPreview(session, client) {
  const preview = await previewBalanceReconciliation(session.data.accountId, session.data.amount, { client });
  const summary = [
    `Saldo observado: ${formatMoney(preview.observed)}`,
    `Norte calculado: ${formatMoney(preview.calculated)}`,
    `Diferença: ${Number(preview.delta) >= 0 ? "+" : ""}${formatMoney(preview.delta)}`,
  ].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: buildInlineKeyboard([[{ text: "✅ Reconciliar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]) }, client);
}

async function commitSaldo(session, client) {
  const { record } = await applyBalanceReconciliation(session.data.accountId, session.data.amount, { rawMessage: "assistente guiado", client });
  return `✅ Saldo de ${session.data.accountName} reconciliado: ${formatMoney(serializeMoney(record.newBalance))}.`;
}

// ============================== fatura atual — reconciliação (item 12) ==============================

async function startFaturaAtual(session, client = prisma) {
  const { cards, keyboard } = await cardKeyboard(client, "card");
  if (cards.length === 0) {
    await finish(session, "⚠️ Nenhum cartão cadastrado ainda.", client);
    return;
  }
  await updateStep(session, "cartao", {}, { flow: "fatura_atual", client });
  if (cards.length === 1) {
    return askFaturaValor(await updateStep(session, "valor", { cardId: cards[0].id, cardName: cards[0].name }, { client }), client);
  }
  await ask(session, "Informar fatura atual 🧾\n\nQual cartão?", { replyMarkup: keyboard }, client);
}

async function askFaturaValor(session, client) {
  await updateStep(session, "valor", {}, { client });
  await ask(session, `Cartão ${session.data.cardName}\n\nQual o valor observado da fatura?`, undefined, client);
}

async function finishFaturaPreview(session, client) {
  const preview = await previewCardBillReconciliation(session.data.cardId, session.data.amount, { client });
  const summary = [
    `Fatura observada: ${formatMoney(preview.observed)}`,
    `Norte calculado: ${formatMoney(preview.calculated)}`,
    `Diferença: ${Number(preview.delta) >= 0 ? "+" : ""}${formatMoney(preview.delta)}`,
  ].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: buildInlineKeyboard([[{ text: "✅ Reconciliar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]) }, client);
}

async function commitFaturaAtual(session, client) {
  const { record } = await applyCardBillReconciliation(session.data.cardId, session.data.amount, { rawMessage: "assistente guiado", client });
  return `✅ Fatura do cartão ${session.data.cardName} reconciliada: observado ${formatMoney(serializeMoney(record.observedTotal))}, diferença ${formatMoney(serializeMoney(record.delta))}.`;
}

// ============================== pagar fatura (item 13) ==============================
//
// cartão -> valor pago -> conta usada -> data -> preview -> confirmar.
// Usa payBill()/commitBotIntent("bill_payment") — Transfer kind
// card_bill_payment + CardBill.paidAmount/status, NUNCA uma Expense nova.
// payBill valida (valor > 0, não excede o restante, fatura materializada)
// ANTES de qualquer escrita, então um erro vira mensagem amigável sem
// deixar escrita parcial pra trás.

async function startFaturaPagar(session, client = prisma) {
  const { cards, keyboard } = await cardKeyboard(client, "card");
  if (cards.length === 0) {
    await finish(session, "⚠️ Nenhum cartão cadastrado ainda.", client);
    return;
  }
  await updateStep(session, "cartao", {}, { flow: "fatura_pagar", client });
  if (cards.length === 1) return askFaturaPagarValor(await updateStep(session, "valor", { cardId: cards[0].id, cardName: cards[0].name }, { client }), client);
  await ask(session, "Pagar fatura ✅\n\nQual cartão?", { replyMarkup: withNav(keyboard.inline_keyboard.map((row) => row.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function askFaturaPagarValor(session, client) {
  let hint = "";
  try {
    const bill = await resolveCurrentBillSafely(session.data.cardId, { client });
    const remaining = serializeMoney(subtractMoney(bill.totalAmount, bill.paidAmount ?? 0));
    hint = `Fatura atual: ${formatMoney(serializeMoney(bill.totalAmount))} · restante ${formatMoney(remaining)}\n\n`;
  } catch {
    hint = "";
  }
  await updateStep(session, "valor", {}, { client });
  await ask(session, `Pagar fatura ✅\nCartão ${session.data.cardName}\n\n${hint}Quanto você pagou?`, undefined, client);
}

async function askFaturaPagarConta(session, client) {
  const accounts = (await client.account.findMany({ orderBy: { createdAt: "asc" } })).filter((a) => a.type !== "food_voucher");
  const keyboard = withNav(chunk(accounts.map((a) => ({ text: a.name, data: `acct:${a.id}` })), 2));
  await ask(session, `Valor: ${formatMoney(session.data.amount)}\n\nPago com qual conta?`, { replyMarkup: keyboard }, client);
}

async function finishFaturaPagarConfirm(session, client) {
  const occurredAt = session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date();
  const summary = ["✅ Pagamento de fatura", `Cartão ${session.data.cardName}`, formatMoney(session.data.amount), `Conta: ${session.data.accountName}`, formatDate(occurredAt)].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitFaturaPagar(session, client) {
  const card = await client.card.findUnique({ where: { id: session.data.cardId } });
  // Sem try/catch: um erro (valor > restante, fatura inexistente, SQL) sobe pro
  // guard de savepoint do confirm:yes, que desfaz tudo e responde com segurança.
  const { reply } = await commitBotIntent(
    "bill_payment",
    { amount: session.data.amount, description: "Pagamento de fatura", rawMessage: "assistente guiado", target: { type: "card", card }, fromAccountId: session.data.accountId, occurredAt: session.data.occurredAtISO ? new Date(session.data.occurredAtISO) : new Date(), billPaymentKind: "card_bill_payment" },
    { source: "telegram", client }
  );
  return reply;
}

// ============================== compromisso / contingência / recebível (planejamento) ==============================

async function startCompromisso(session, client = prisma) {
  await updateStep(session, "descricao", {}, { flow: "compromisso", client });
  await ask(session, "Novo compromisso 📌\n\nQual a descrição?", undefined, client);
}

async function finishCompromissoPreview(session, client) {
  const summary = ["Confirma?", "", `📌 ${session.data.description}`, formatMoney(session.data.amount), `Vence: ${formatDate(new Date(session.data.dueDateISO))}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitCompromisso(session, client) {
  const { reply } = await commitBotIntent("create_confirmed_commitment", { description: session.data.description, amount: session.data.amount, dueDate: session.data.dueDateISO }, { source: "telegram", client });
  return reply;
}

async function startContingencia(session, client = prisma) {
  await updateStep(session, "descricao", {}, { flow: "contingencia", client });
  await ask(session, "Nova contingência ⚠️\n\nQual a descrição?", undefined, client);
}

async function askContingenciaMax(session, client) {
  await updateStep(session, "maximo", {}, { client });
  await ask(session, `${session.data.description}\n\nQual o valor MÁXIMO possível?`, undefined, client);
}

async function finishContingenciaPreview(session, client) {
  const summary = ["Confirma?", "", `⚠️ ${session.data.description}`, `Até ${formatMoney(session.data.maxAmount)}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitContingencia(session, client) {
  const { reply } = await commitBotIntent("create_contingency", { description: session.data.description, maxAmount: session.data.maxAmount, expectedAmount: session.data.expectedAmount || null, expectedDate: session.data.expectedDate || null }, { source: "telegram", client });
  return reply;
}

async function startRecebivel(session, client = prisma) {
  await updateStep(session, "descricao", {}, { flow: "recebivel", client });
  await ask(session, "Novo valor a receber 📥\n\nQual a descrição?", undefined, client);
}

async function askRecebivelContraparte(session, client) {
  await updateStep(session, "contraparte", {}, { client });
  await ask(session, `${session.data.description}\n\nDe quem?`, undefined, client);
}

async function askRecebivelValor(session, client) {
  await updateStep(session, "valor", {}, { client });
  await ask(session, `De ${session.data.counterparty}\n\nQual o valor?`, undefined, client);
}

async function finishRecebivelPreview(session, client) {
  const summary = ["Confirma?", "", `📥 ${session.data.description}`, `De: ${session.data.counterparty}`, formatMoney(session.data.amount)].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitRecebivel(session, client) {
  const { reply } = await commitBotIntent("create_receivable", { description: session.data.description, counterparty: session.data.counterparty, amount: session.data.amount }, { source: "telegram", client });
  return reply;
}

// ============================== Fase 7D.1 — planejamento: fechar o ciclo completo ==============================
// Cada entidade (compromisso/contingência/recebível/meta) ganha um fluxo de
// "listar ativos -> escolher -> [detalhe] -> ação -> preview -> confirmar"
// pras ações que faltavam (marcar pago/resolvido/recebido, editar). Nunca
// Prisma cru — sempre via commitBotIntent -> serviço de domínio real.

function pickerKeyboard(items, prefix, labelFn) {
  return withNav(items.map((it) => [{ text: labelFn(it), data: `${prefix}:${it.id}` }]));
}

// ---- Compromisso: marcar como pago ----

async function startCompromissoPagar(session, client = prisma) {
  const { listCommitments } = await import("./commitments.js");
  const all = await listCommitments({ client });
  const active = all.filter((c) => c.status === "CONFIRMED" || c.status === "FUNDED");
  await updateStep(session, "escolher", {}, { flow: "compromisso_pagar", client });
  if (active.length === 0) {
    await finish(session, "📌 Nenhum compromisso ativo (CONFIRMED/FUNDED) pra marcar como pago agora.", client);
    return;
  }
  const keyboard = pickerKeyboard(active, "cpay", (c) => `${c.description} · ${formatMoney(serializeMoney(c.amount))} (${c.status})`);
  await ask(session, "✅ Marcar compromisso como pago\n\nQual?", { replyMarkup: keyboard }, client);
}

async function askCompromissoPagarConta(session, commitmentId, client) {
  const { getCommitment } = await import("./commitments.js");
  const commitment = await getCommitment(commitmentId, { client });
  if (!commitment) {
    await finish(session, "⚠️ Não achei mais esse compromisso.", client);
    return;
  }
  const keyboard = await accountKeyboard(client);
  await updateStep(session, "conta", { commitmentId, commitmentDescription: commitment.description, commitmentAmount: serializeMoney(commitment.amount) }, { client });
  await ask(session, `${commitment.description} — ${formatMoney(serializeMoney(commitment.amount))}\n\nPago com qual conta?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function finishCompromissoPagarPreview(session, client) {
  const summary = ["Confirma o pagamento?", "", `📌 ${session.data.commitmentDescription}`, formatMoney(session.data.commitmentAmount), `Via: ${session.data.accountName}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitCompromissoPagar(session, client) {
  const account = await client.account.findUnique({ where: { id: session.data.accountId } });
  const { reply } = await commitBotIntent("settle_confirmed_commitment", { commitmentId: session.data.commitmentId, target: { type: "account", account } }, { source: "telegram", client });
  return reply;
}

// ---- Compromisso: editar ----

async function startCompromissoEditar(session, client = prisma) {
  const { listCommitments } = await import("./commitments.js");
  const all = await listCommitments({ client });
  const editable = all.filter((c) => c.status !== "SETTLED" && c.status !== "CANCELLED");
  await updateStep(session, "escolher", {}, { flow: "compromisso_editar", client });
  if (editable.length === 0) {
    await finish(session, "📌 Nenhum compromisso editável agora (só SETTLED/CANCELLED existem).", client);
    return;
  }
  const keyboard = pickerKeyboard(editable, "cedit", (c) => `${c.description} · ${formatMoney(serializeMoney(c.amount))} (${c.status})`);
  await ask(session, "✏️ Editar compromisso\n\nQual?", { replyMarkup: keyboard }, client);
}

async function askCompromissoEditarCampo(session, commitmentId, client) {
  await updateStep(session, "campo", { commitmentId }, { client });
  const keyboard = withNav([[{ text: "💰 Valor", data: "cfield:amount" }, { text: "📅 Vencimento", data: "cfield:dueDate" }]]);
  await ask(session, "O que você quer editar?", { replyMarkup: keyboard }, client);
}

// ---- Contingência: resolver ----

async function startContingenciaResolver(session, client = prisma) {
  const all = await listContingencies({ client });
  const open = all.filter((c) => c.status === "AWAITING_INFORMATION" || c.status === "CONFIRMED");
  await updateStep(session, "escolher", {}, { flow: "contingencia_resolver", client });
  if (open.length === 0) {
    await finish(session, "⚠️ Nenhuma contingência aberta pra resolver agora.", client);
    return;
  }
  const keyboard = pickerKeyboard(open, "cgpick", (c) => `${c.description} · até ${formatMoney(serializeMoney(c.maxAmount))} (${c.status})`);
  await ask(session, "✅ Resolver contingência\n\nQual?", { replyMarkup: keyboard }, client);
}

async function askContingenciaResolverStatus(session, contingencyId, client) {
  const contingency = (await listContingencies({ client })).find((c) => c.id === contingencyId);
  if (!contingency) {
    await finish(session, "⚠️ Não achei mais essa contingência.", client);
    return;
  }
  const keyboard = withNav([[{ text: "✅ Aconteceu (virou real)", data: "cgstatus:CONFIRMED" }, { text: "❌ Não aconteceu (descartar)", data: "cgstatus:DISMISSED" }]]);
  await updateStep(session, "status", { contingencyId, contingencyDescription: contingency.description }, { client });
  await ask(session, `${contingency.description}\n\nO que aconteceu?`, { replyMarkup: keyboard }, client);
}

async function finishContingenciaResolverPreview(session, client) {
  const humanStatus = session.data.newStatus === "CONFIRMED" ? "confirmada (virou real)" : "descartada";
  const summary = ["Confirma?", "", `⚠️ ${session.data.contingencyDescription}`, `Nova situação: ${humanStatus}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitContingenciaResolver(session, client) {
  const { reply } = await commitBotIntent("resolve_contingency", { contingencyId: session.data.contingencyId, status: session.data.newStatus }, { source: "telegram", client });
  return reply;
}

// ---- Contingência: editar (só maxAmount — único campo com serviço real) ----

async function startContingenciaEditar(session, client = prisma) {
  const all = await listContingencies({ client });
  const editable = all.filter((c) => c.status !== "DISMISSED");
  await updateStep(session, "escolher", {}, { flow: "contingencia_editar", client });
  if (editable.length === 0) {
    await finish(session, "⚠️ Nenhuma contingência editável agora.", client);
    return;
  }
  const keyboard = pickerKeyboard(editable, "cgeditpick", (c) => `${c.description} · até ${formatMoney(serializeMoney(c.maxAmount))}`);
  await ask(session, "✏️ Atualizar contingência (valor máximo)\n\nQual?", { replyMarkup: keyboard }, client);
}

// ---- Recebível: marcar recebido ----

async function startRecebivelReceber(session, client = prisma) {
  const { listReceivables } = await import("./receivables.js");
  const pending = await listReceivables({ status: "PENDING", client });
  await updateStep(session, "escolher", {}, { flow: "recebivel_receber", client });
  if (pending.length === 0) {
    await finish(session, "📥 Nenhum valor a receber pendente agora.", client);
    return;
  }
  const keyboard = pickerKeyboard(pending, "rpick", (r) => `${r.description} · ${formatMoney(serializeMoney(r.amount))} de ${r.counterparty}`);
  await ask(session, "✅ Marcar como recebido\n\nQual?", { replyMarkup: keyboard }, client);
}

async function askRecebivelReceberConta(session, receivableId, client) {
  const { listReceivables } = await import("./receivables.js");
  const receivable = (await listReceivables({ client })).find((r) => r.id === receivableId);
  if (!receivable) {
    await finish(session, "⚠️ Não achei mais esse valor a receber.", client);
    return;
  }
  const keyboard = await accountKeyboard(client);
  await updateStep(session, "conta", { receivableId, receivableDescription: receivable.description, receivableAmount: serializeMoney(receivable.amount), counterparty: receivable.counterparty }, { client });
  await ask(session, `${receivable.description} — ${formatMoney(serializeMoney(receivable.amount))} de ${receivable.counterparty}\n\nCreditar em qual conta?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
}

async function finishRecebivelReceberPreview(session, client) {
  const summary = ["Confirma o recebimento?", "", `📥 ${session.data.receivableDescription}`, `De: ${session.data.counterparty}`, formatMoney(session.data.receivableAmount), `Em: ${session.data.accountName}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitRecebivelReceber(session, client) {
  const account = await client.account.findUnique({ where: { id: session.data.accountId } });
  const { reply } = await commitBotIntent("mark_receivable_received", { receivableId: session.data.receivableId, target: { type: "account", account } }, { source: "telegram", client });
  return reply;
}

// ---- Recebível: editar (só amount — único campo com serviço real além de data) ----

async function startRecebivelEditar(session, client = prisma) {
  const { listReceivables } = await import("./receivables.js");
  const pending = await listReceivables({ status: "PENDING", client });
  await updateStep(session, "escolher", {}, { flow: "recebivel_editar", client });
  if (pending.length === 0) {
    await finish(session, "📥 Nenhum valor a receber pendente editável agora.", client);
    return;
  }
  const keyboard = pickerKeyboard(pending, "reditpick", (r) => `${r.description} · ${formatMoney(serializeMoney(r.amount))} de ${r.counterparty}`);
  await ask(session, "✏️ Editar valor a receber\n\nQual?", { replyMarkup: keyboard }, client);
}

// ---- Meta: nova ----

async function startMetaNova(session, client = prisma) {
  await updateStep(session, "nome", {}, { flow: "meta_nova", client });
  await ask(session, "Nova meta 🎯\n\nQual o nome? (ex: Notebook, Viagem...)", undefined, client);
}

async function finishMetaNovaPreview(session, client) {
  const summary = ["Confirma?", "", `🎯 ${session.data.goalName}`, `Guardar: ${formatMoney(session.data.targetAmount)}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitMetaNova(session, client) {
  const { reply } = await commitBotIntent("create_goal", { goalName: session.data.goalName, targetAmount: session.data.targetAmount }, { source: "telegram", client });
  return reply;
}

// ---- Meta: editar (só targetAmount) ----

async function startMetaEditar(session, client = prisma) {
  const { listGoals } = await import("./goals.js");
  const goals = await listGoals({ client });
  await updateStep(session, "escolher", {}, { flow: "meta_editar", client });
  if (goals.length === 0) {
    await finish(session, "🎯 Nenhuma meta cadastrada ainda.", client);
    return;
  }
  const keyboard = pickerKeyboard(goals, "gpick", (g) => `${g.name} · ${formatMoney(serializeMoney(g.savedAmount))} / ${formatMoney(serializeMoney(g.targetAmount))}`);
  await ask(session, "✏️ Editar meta (valor alvo)\n\nQual?", { replyMarkup: keyboard }, client);
}

async function finishMetaEditarPreview(session, client) {
  const summary = ["Confirma?", "", `🎯 ${session.data.goalName}`, `Novo alvo: ${formatMoney(session.data.targetAmount)}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitMetaEditar(session, client) {
  const { reply } = await commitBotIntent("update_goal", { goalId: session.data.goalId, targetAmount: session.data.targetAmount }, { source: "telegram", client });
  return reply;
}

async function commitCompromissoEditar(session, client) {
  const { reply } = await commitBotIntent("update_confirmed_commitment", { commitmentId: session.data.commitmentId, amount: session.data.newAmount, dueDate: session.data.newDueDate }, { source: "telegram", client });
  return reply;
}

async function commitContingenciaEditar(session, client) {
  const { reply } = await commitBotIntent("update_contingency", { contingencyId: session.data.contingencyId, maxAmount: session.data.newMaxAmount }, { source: "telegram", client });
  return reply;
}

async function commitRecebivelEditar(session, client) {
  const { reply } = await commitBotIntent("update_receivable", { receivableId: session.data.receivableId, amount: session.data.newAmount }, { source: "telegram", client });
  return reply;
}

// ============================== vários lançamentos — batch (item 9) ==============================

function describeBatchItem(item) {
  const labels = { despesa: "Despesa", receita: "Receita", cartao: "Cartão", parcelado: "Parcelado", transferencia: "Transferência" };
  if (item.kind === "parcelado") return `${labels.parcelado} · ${formatMoney(item.amount)} em ${item.installmentCount}x · ${item.cardName}`;
  if (item.kind === "transferencia") return `${labels.transferencia} · ${formatMoney(item.amount)} · ${item.fromAccountName} → ${item.toAccountName}`;
  return `${labels[item.kind] || item.kind} · ${formatMoney(item.amount)} · ${item.targetLabel}`;
}

async function renderBatchList(session, client, headerNote) {
  const items = session.data.items || [];
  const lines = items.length ? items.map((it, i) => `${i + 1}. ${describeBatchItem(it)}`) : ["(nenhum item ainda)"];
  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);
  const text = [headerNote, "", `Itens no lote (${items.length}):`, ...lines, "", items.length ? `Total: ${formatMoney(total)}` : ""].filter(Boolean).join("\n");
  const keyboard = buildInlineKeyboard([
    [{ text: "➕ Adicionar despesa", data: "batch:add:despesa" }, { text: "💰 Adicionar receita", data: "batch:add:receita" }],
    [{ text: "💳 Adicionar cartão", data: "batch:add:cartao" }, { text: "🧩 Adicionar parcelado", data: "batch:add:parcelado" }],
    [{ text: "🔄 Adicionar transferência", data: "batch:add:transferencia" }],
    ...(items.length ? [[{ text: "🗑 Remover último", data: "batch:removelast" }], [{ text: "✅ Revisar e salvar", data: "batch:review" }]] : []),
    [{ text: "❌ Cancelar lote", data: "batch:cancel" }],
  ]);
  await updateStep(session, "menu", {}, { client });
  await ask(session, text, { replyMarkup: keyboard }, client);
}

async function startMultipla(session, client = prisma) {
  await updateStep(session, "menu", { items: [] }, { flow: "multipla", client });
  await renderBatchList(session, client, "📚 Vários lançamentos");
}

const BATCH_ITEM_LABELS = { receita: "receita", cartao: "compra no cartão", parcelado: "compra parcelada", transferencia: "transferência", despesa: "despesa" };

async function startBatchItem(session, client, kind) {
  await updateStep(session, "item_valor", { itemKind: kind }, { client });
  const label = BATCH_ITEM_LABELS[kind] || "despesa";
  await ask(session, `Adicionar ${label}\n\nQual o valor?`, undefined, client);
}

async function askBatchDescricao(session, client) {
  await updateStep(session, "item_descricao", {}, { client });
  await ask(session, `Valor: ${formatMoney(session.data.itemAmount)}\n\nDescrição?`, undefined, client);
}

async function askBatchMeio(session, client) {
  const kind = session.data.itemKind;
  if (kind === "cartao") {
    const { cards, keyboard } = await cardKeyboard(client, "batchcard");
    if (cards.length <= 1 && cards[0]) return finishBatchItem(session, client, { targetType: "card", targetId: cards[0].id, targetLabel: `Cartão ${cards[0].name}` });
    await updateStep(session, "item_meio", {}, { client });
    await ask(session, `${session.data.itemDescription}\n\nQual cartão?`, { replyMarkup: keyboard }, client);
    return;
  }
  if (kind === "parcelado") {
    await updateStep(session, "item_parcelas", {}, { client });
    await ask(session, `${session.data.itemDescription}\n\nEm quantas vezes?`, { replyMarkup: buildInlineKeyboard(chunk(QUICK_INSTALLMENT_COUNTS.map((n) => ({ text: `${n}x`, data: `bqtd:${n}` })), 3)) }, client);
    return;
  }
  if (kind === "transferencia") {
    const keyboard = await accountKeyboard(client);
    await updateStep(session, "item_origem", {}, { client });
    await ask(session, `${session.data.itemDescription}\n\nDe onde sai o dinheiro?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
    return;
  }
  const options = kind === "receita" ? INCOME_TARGET_ACCOUNT_TYPES : EXPENSE_PAYMENT_OPTIONS;
  await updateStep(session, "item_meio", {}, { client });
  await ask(session, `${session.data.itemDescription}\n\n${kind === "receita" ? "Onde entrou?" : "Como pagou?"}`, { replyMarkup: buildInlineKeyboard(chunk(options.map((o) => ({ text: o.text, data: `bpm:${o.data.slice(3)}` })), 2)) }, client);
}

async function askBatchParceladoCartao(session, client, installmentCount) {
  const { cards, keyboard } = await cardKeyboard(client, "bcard");
  if (cards.length <= 1 && cards[0]) return finishBatchItem(session, client, { installmentCount, cardId: cards[0].id, cardName: cards[0].name });
  await updateStep(session, "item_cartao", { itemInstallmentCount: installmentCount }, { client });
  await ask(session, "Qual cartão?", { replyMarkup: keyboard }, client);
}

async function finishBatchItem(session, client, extra) {
  const kind = session.data.itemKind;
  let item;
  if (kind === "parcelado") {
    item = { kind, amount: session.data.itemAmount, description: session.data.itemDescription, installmentCount: extra.installmentCount, cardId: extra.cardId, cardName: extra.cardName };
  } else if (kind === "transferencia") {
    item = { kind, amount: session.data.itemAmount, description: session.data.itemDescription, fromAccountId: extra.fromAccountId, fromAccountName: extra.fromAccountName, toAccountId: extra.toAccountId, toAccountName: extra.toAccountName };
  } else {
    item = { kind, amount: session.data.itemAmount, description: session.data.itemDescription, targetType: extra.targetType, targetId: extra.targetId, targetLabel: extra.targetLabel };
  }
  const items = [...(session.data.items || []), item];
  await updateStep(session, "menu", { items, itemKind: undefined, itemAmount: undefined, itemDescription: undefined, itemFromAccountId: undefined, itemFromAccountName: undefined }, { client });
  await ask(session, "✅ Item adicionado ao lote.", undefined, client);
  await renderBatchList(session, client, "📚 Vários lançamentos");
}

async function finishBatchReview(session, client) {
  const items = session.data.items || [];
  const lines = items.map((it, i) => `${i + 1}. ${describeBatchItem(it)}`);
  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);
  const summary = ["Revisar lote — confirma tudo de uma vez?", "", ...lines, "", `Total: ${formatMoney(total)}`].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

// Item 9 — TODAS as actions do lote no MESMO `client` (já é a transação
// externa que envolve o update inteiro, ver telegramUpdateHandler.js): se
// qualquer commitBotIntent lançar, a transação inteira reverte — ZERO itens
// persistidos, nunca uma aplicação parcial.
async function commitBatch(session, client) {
  const items = session.data.items || [];
  const results = [];
  for (const item of items) {
    if (item.kind === "parcelado") {
      // Item 6 — parcelado no lote usa EXATAMENTE commitBotIntent("installment_purchase",...)
      // -> generateInstallmentSchedule, nunca uma Expense/duas despesas.
      const card = await client.card.findUnique({ where: { id: item.cardId } });
      const { reply } = await commitBotIntent("installment_purchase", { amount: item.amount, installmentCount: item.installmentCount, category: "Outros", description: item.description, target: { type: "card", card }, rawMessage: "assistente guiado (lote)" }, { source: "telegram", client });
      results.push(reply);
      continue;
    }
    if (item.kind === "transferencia") {
      const { reply } = await commitBotIntent("transfer", { amount: item.amount, description: item.description, fromAccountId: item.fromAccountId, toAccountId: item.toAccountId, rawMessage: "assistente guiado (lote)" }, { source: "telegram", client });
      results.push(reply);
      continue;
    }
    const target = item.targetType === "card" ? { type: "card", card: await client.card.findUnique({ where: { id: item.targetId } }) } : { type: "account", account: await client.account.findUnique({ where: { id: item.targetId } }) };
    const intent = item.kind === "receita" ? "income" : "expense";
    const { reply } = await commitBotIntent(intent, { amount: item.amount, category: "Outros", description: item.description, target, rawMessage: "assistente guiado (lote)", isRecurring: false }, { source: "telegram", client });
    results.push(reply);
  }
  return `✅ Lote aplicado: ${items.length} lançamento(s).\n\n${results.join("\n")}`;
}

// ============================== categoria — período personalizado ==============================

async function startCategoriaPeriodo(session, client = prisma) {
  await updateStep(session, "inicio", {}, { flow: "categoria_periodo", client });
  await ask(session, "Onde foi meu dinheiro — período personalizado 📊\n\nData de início (DD/MM ou DD/MM/AAAA):", undefined, client);
}

async function askCategoriaFim(session, client) {
  await updateStep(session, "fim", {}, { client });
  await ask(session, "Data de fim (DD/MM ou DD/MM/AAAA):", undefined, client);
}

// computeCategoryBreakdown trata "end" como EXCLUSIVO (occurredAt < end) e
// os dias de calendário do app ficam guardados como meia-noite UTC. Pra
// "data final" ser inclusiva pro usuário, o limite enviado é fim + 1 dia; o
// rótulo mostrado continua sendo o intervalo que a pessoa digitou.
export async function computeCustomCategoryPeriod(inicioISO, fimISO, { client = prisma } = {}) {
  const endExclusive = new Date(new Date(`${fimISO}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await computeCategoryBreakdown({ start: inicioISO, end: endExclusive }, { client });
  return { ...result, label: `${formatDate(new Date(`${inicioISO}T00:00:00.000Z`))} a ${formatDate(new Date(`${fimISO}T00:00:00.000Z`))}` };
}

async function finishCategoriaPeriodo(session, client) {
  const result = await computeCustomCategoryPeriod(session.data.inicioISO, session.data.fimISO, { client });
  await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
  await ask(session, formatCategoryBreakdownReply(result), undefined, client);
}

// ============================== simulador (item 25) ==============================

async function startSimulador(session, client = prisma) {
  await updateStep(session, "valor", {}, { flow: "simulador", client });
  await ask(session, "Simular compra 🧮\n\nQual o valor da compra?", undefined, client);
}

async function askSimuladorModo(session, client) {
  await updateStep(session, "modo", {}, { client });
  await ask(session, `Valor: ${formatMoney(session.data.amount)}\n\nÀ vista ou parcelado?`, { replyMarkup: buildInlineKeyboard([[{ text: "💵 À vista", data: "simmode:avista" }, { text: "💳 Parcelado", data: "simmode:parcelado" }]]) }, client);
}

async function askSimuladorPagamento(session, client) {
  await updateStep(session, "pagamento", {}, { client });
  await ask(session, "Como seria pago?", { replyMarkup: buildInlineKeyboard([[{ text: "Pix/Débito/Dinheiro", data: "simpm:cash" }, { text: "Cartão de crédito", data: "simpm:cartao" }]]) }, client);
}

async function askSimuladorParcelas(session, client) {
  await updateStep(session, "parcelas", {}, { client });
  await ask(session, "Em quantas vezes?", { replyMarkup: buildInlineKeyboard(chunk(QUICK_INSTALLMENT_COUNTS.map((n) => ({ text: `${n}x`, data: `simqtd:${n}` })), 3)) }, client);
}

async function askSimuladorCartao(session, client) {
  const { cards, keyboard } = await cardKeyboard(client, "simcard");
  if (cards.length <= 1 && cards[0]) return runSimulacao(await updateStep(session, "resultado", { cardId: cards[0].id }, { client }), client);
  await updateStep(session, "cartao", {}, { client });
  await ask(session, "Qual cartão?", { replyMarkup: keyboard }, client);
}

async function runSimulacao(session, client) {
  const amount = Number(session.data.amount);
  let scenario;
  if (session.data.modo === "parcelado") {
    scenario = { type: "CARD_PURCHASE_INSTALLMENTS", cardId: session.data.cardId, totalAmount: amount, installmentCount: session.data.installmentCount };
  } else if (session.data.pagamento === "cartao") {
    scenario = { type: "CARD_PURCHASE_SINGLE", cardId: session.data.cardId, amount };
  } else {
    scenario = { type: "CASH_EXPENSE_NOW", amount };
  }
  let reply;
  try {
    const result = await simulateFinancialScenario({ scenario });
    reply = formatVerdict(result);
  } catch (err) {
    reply = `Não consegui simular isso agora (${err.message}).`;
  }
  await updateStep(session, "resultado", {}, { client });
  await ask(session, reply, { replyMarkup: buildInlineKeyboard([[{ text: "🧾 Registrar essa compra", data: "simreg" }], [{ text: "🏠 Menu", data: "wiznav:menu" }]]) }, client);
}

// "🧾 Registrar essa compra" — abre o wizard REAL correspondente já com os
// campos conhecidos preenchidos, mas AINDA exige preview/confirmação (item
// 25: "nunca registrar automaticamente"). Nunca pula a etapa de confirmar.
async function seedRealWizardFromSimulation(session, client) {
  const amount = session.data.amount;
  const expiresAt = new Date(Date.now() + WIZARD_TTL_MS);
  const nowISO = quickDateISO("hoje");
  // Pré-preenche tudo que a simulação já sabe e vai DIRETO pro preview real
  // (parcelado/cartão) ou pra pergunta "como pagou?" (à vista) — nunca grava
  // nada aqui; a confirmação continua obrigatória e o "✏️ Editar" do preview
  // permite ajustar descrição/categoria/data antes de salvar.
  if (session.data.modo === "parcelado") {
    const card = await client.card.findUnique({ where: { id: session.data.cardId } });
    const seeded = await client.botWizardSession.update({ where: { id: session.id }, data: { flow: "parcela", step: "confirmar", data: { amount, description: "Compra simulada", merchant: null, installmentCount: session.data.installmentCount, cardId: card.id, cardName: card.name, category: "Outros", occurredAtISO: nowISO }, expiresAt } });
    return finishParcelaConfirm2(seeded, client);
  }
  if (session.data.pagamento === "cartao") {
    const card = await client.card.findUnique({ where: { id: session.data.cardId } });
    const seeded = await client.botWizardSession.update({ where: { id: session.id }, data: { flow: "cartao_compra", step: "confirmar", data: { amount, description: "Compra simulada", cardId: card.id, cardName: card.name, category: "Outros", occurredAtISO: nowISO }, expiresAt } });
    return finishCartaoCompraConfirm(seeded, client);
  }
  const seeded = await client.botWizardSession.update({ where: { id: session.id }, data: { flow: "gasto", step: "meio", data: { amount, description: "Compra simulada" }, expiresAt } });
  return askComoPagou(seeded, client);
}

// ============================== corrigir campo (item 26/29) ==============================

const CORRECTION_MODEL_TABLE = { expense: "expense", income: "income", transfer: "transfer" };

export async function startCorrectionFieldEdit(chatId, { model, id, field }, { client = prisma } = {}) {
  const table = CORRECTION_MODEL_TABLE[model];
  if (!table) {
    await sendMessage(chatId, "⚠️ Esse tipo de lançamento não pode ser editado por aqui.");
    return;
  }
  const record = await client[table].findUnique({ where: { id } });
  if (!record) {
    await sendMessage(chatId, "⚠️ Não achei mais esse lançamento.");
    return;
  }
  await client.botWizardSession.deleteMany({ where: { chatId } });
  const session = await client.botWizardSession.create({
    data: { chatId, flow: "corrigir_campo", step: "novo_valor", data: { model, id, field, expectedUpdatedAt: record.updatedAt.toISOString() }, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });
  if (field === "category") {
    await ask(session, "Nova categoria:", { replyMarkup: buildInlineKeyboard(CATEGORY_KEYBOARD_ROWS.map((row) => row.map((b) => ({ text: b.text, data: `corcat:${b.data.slice(4)}` })))) }, client);
    return;
  }
  const label = { amount: "o novo valor", description: "a nova descrição", date: "a nova data (DD/MM ou DD/MM/AAAA)" }[field] || "o novo valor";
  await ask(session, `Manda ${label}:`, undefined, client);
}

async function finishCorrectionPreview(session, client, fieldChanges) {
  const table = CORRECTION_MODEL_TABLE[session.data.model];
  const record = await client[table].findUnique({ where: { id: session.data.id } });
  const diff = describeFieldChanges(record, fieldChanges);
  await updateStep(session, "confirmar", { fieldChanges }, { client });
  await ask(session, ["Confirma a correção?", "", ...diff].join("\n"), { replyMarkup: CONFIRM_KEYBOARD }, client);
}

// Fase 7D.1 — nunca deixa StaleRecordError/RecordNotFoundError propagar pra
// fora (isso abortaria a transação INTEIRA do update, incluindo o claim de
// idempotência — item 38-G: "stale object" precisa de uma resposta
// graciosa, nunca um erro genérico/retry infinito). Oferece "↩️ Desfazer"
// no sucesso (item 38-F), igual à exclusão.
async function commitCorrection(session, client) {
  try {
    const { auditId } = await applyGuardedCorrection({ model: session.data.model, id: session.data.id, fieldChanges: session.data.fieldChanges, expectedUpdatedAt: session.data.expectedUpdatedAt, chatId: session.chatId }, { client });
    return { text: "✅ Corrigido.", keyboard: buildInlineKeyboard([[{ text: "↩️ Desfazer", data: `cor:undoyes:${auditId}` }]]) };
  } catch (err) {
    if (err.name === "StaleRecordError") return "⚠️ Esse lançamento mudou desde que eu mostrei ele — abre a lista de novo pra conferir antes de corrigir.";
    if (err.name === "RecordNotFoundError") return "⚠️ Não achei mais esse lançamento (já foi excluído?).";
    throw err;
  }
}

// ============================== vou_pagar (menu legado) ==============================

async function startVouPagarMenu(session, client = prisma) {
  const keyboard = buildInlineKeyboard([
    [{ text: "🆕 Nova conta", data: "pagmenu:nova" }],
    [{ text: "✅ Marcar como paga", data: "pagmenu:marcar" }],
    [{ text: "💳 Pagar fatura", data: "pagmenu:fatura" }],
    [{ text: "⏩ Antecipar fatura", data: "pagmenu:antecipar" }],
  ]);
  await updateStep(session, "acao", {}, { client });
  await ask(session, "Vou ter que pagar 📋\n\nO que você quer fazer?", { replyMarkup: keyboard }, client);
}

async function startMarcarPaga(session, client = prisma) {
  const bills = await listBills({ status: ["pending", "overdue"], withinDays: 90 });
  if (bills.length === 0) {
    await finish(session, "Você não tem nenhuma conta pendente registrada. Use \"🆕 Nova conta\" primeiro.", client);
    return;
  }
  const buttons = bills.slice(0, 8).map((b) => [{ text: `${b.description} — ${formatMoney(b.amount)}`, data: `bill:${b.id}` }]);
  await updateStep(session, "escolher_bill", {}, { flow: "marcar_paga", client });
  await ask(session, "Qual conta você pagou?", { replyMarkup: buildInlineKeyboard(buttons) }, client);
}

async function finishMarcarPagaConfirm(session, client = prisma) {
  const bill = await client.bill.findUnique({ where: { id: session.data.billId } });
  const summary = [
    "Confirma o pagamento?", "",
    `✅ ${bill.description} — ${formatMoney(bill.amount)}`,
    `🏦 ${session.data.targetLabel}`,
  ].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitMarcarPaga(session, client) {
  const { bill, expense } = await markBillPaid(session.data.billId, { accountId: session.data.targetId }, { client });
  return `✅ Conta "${bill.description}" marcada como paga: ${formatMoney(expense.amount)}.`;
}

async function startFaturaValor(session, flow, client = prisma) {
  await updateStep(session, "valor", {}, { flow, client });
  await ask(session, flow === "antecipar_fatura" ? "Antecipar fatura ⏩\n\nQuanto você quer antecipar?" : "Pagar fatura 💳\n\nQuanto você pagou?", undefined, client);
}

async function commitFatura(session, client) {
  const card = await client.card.findFirst({ orderBy: { createdAt: "asc" } });
  const data = {
    amount: session.data.amount,
    description: "assistente guiado",
    rawMessage: "assistente guiado",
    target: { type: "card", card },
    billPaymentKind: session.flow === "antecipar_fatura" ? "installment_anticipation" : "card_bill_payment",
  };
  const { reply } = await commitBotIntent("bill_payment", data, { source: "telegram", client });
  return reply;
}

// ============================== dispatch ==============================

// Retorno: normalmente `undefined` (a resposta, se houve, já foi enviada
// inline via ask()). No branch financeiro ("confirm:yes"), retorna
// `{ deferredReply: { chatId, messageId, text } }` — o CALLER (lib/
// telegramUpdateHandler.js) envia isso só depois do commit da transação
// (item 25: reply nunca dentro da tx pra um efeito financeiro).
export async function handleWizardCallback(chatId, callbackData, { client = prisma } = {}) {
  const session = await client.botWizardSession.findUnique({ where: { chatId } });
  // Sem sessão = callback antigo/stale: nenhuma ação, o caller responde com
  // uma mensagem segura (fail closed, Fase 7D.1 item 12).
  if (!session) return { stale: true };
  // Item 28 — "sessão velha nunca executa ação": achado real de teste desta
  // fase — nada aqui checava expiresAt antes deste fix, então um callback
  // (incl. confirm:yes) chegando depois do TTL ainda executava normalmente.
  // Trata sessão expirada EXATAMENTE como sessão inexistente, sempre a
  // PRIMEIRA checagem, antes de qualquer branch (incluindo navegação).
  if (session.expiresAt <= new Date()) {
    await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    await ask(session, "Essa sessão expirou. Abre o menu de novo pra continuar.", undefined, client);
    return;
  }

  // Navegação global (item 28/34) — sempre disponível dentro de um wizard,
  // qualquer step: 🏠 Menu abandona o fluxo e mostra o menu raiz, ❌ Cancelar
  // confirma o abandono explicitamente (sem confirmação extra se ainda não
  // há dado relevante — abandonar cedo é sempre seguro).
  if (callbackData === "wiznav:menu" || callbackData === "wiznav:cancel") {
    await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    if (callbackData === "wiznav:cancel") await ask(session, "Cancelado.", undefined, client);
    const { renderMenu } = await import("./telegramMenu.js");
    const { text, keyboard } = renderMenu("root");
    await ask(session, text, { replyMarkup: keyboard }, client);
    return;
  }

  // Item 29 — editar um campo específico do preview de despesa/receita
  // sem recomeçar o wizard inteiro.
  if (session.step === "confirmar" && callbackData.startsWith("editmenu:")) {
    await ask(session, "O que você quer editar?", { replyMarkup: editMenuKeyboard(session.flow) }, client);
    return;
  }
  if (session.step === "confirmar" && callbackData.startsWith("editfield:")) {
    return startEditField(session, callbackData.slice(10), client);
  }

  if (session.step === "categoria" && callbackData.startsWith("cat:")) {
    const category = callbackData.slice(4);
    if (session.flow === "nova_conta") {
      await updateStep(session, "descricao", { category }, { client });
      await ask(session, `Categoria: ${category}\n\nQual a descrição? (ex: Internet, aluguel...)`, undefined, client);
    } else if (session.flow === "cartao_compra") {
      await askCartaoData(await updateStep(session, "data", { category }, { client }), client);
    } else if (session.flow === "parcela") {
      await askParcelaData(await updateStep(session, "data", { category }, { client }), client);
    } else if (session.data.editing) {
      await finishGastoReceitaConfirm(await updateStep(session, "confirmar", { category, editing: false }, { client }), client);
    } else {
      await askData(await updateStep(session, "data", { category }, { client }), client);
    }
    return;
  }

  if (session.step === "meio" && callbackData.startsWith("pm:")) {
    const key = callbackData.slice(3);
    const isReceita = session.flow === "receita";
    const options = isReceita ? INCOME_TARGET_ACCOUNT_TYPES : EXPENSE_PAYMENT_OPTIONS;
    const chosen = options.find((o) => o.data === callbackData);
    if (!chosen) return;
    if (chosen.isCard) {
      const card = await client.card.findFirst({ orderBy: { createdAt: "asc" } });
      if (!card) {
        await finish(session, "⚠️ Nenhum cartão cadastrado ainda.", client);
        return;
      }
      const patch = { targetType: "card", targetId: card.id, targetLabel: `Cartão ${card.name}`, paymentMethod: chosen.paymentMethod, paymentMethodLabel: chosen.text };
      if (session.data.editing) return finishGastoReceitaConfirm(await updateStep(session, "confirmar", { ...patch, editing: false }, { client }), client);
      await askCategoria(await updateStep(session, "categoria", patch, { client }), client);
      return;
    }
    const account = await findAccountByType(chosen.accountType, client);
    if (!account) {
      await finish(session, `⚠️ Nenhuma conta do tipo "${chosen.text}" cadastrada.`, client);
      return;
    }
    const patch = { targetType: "account", targetId: account.id, targetLabel: account.name, paymentMethod: chosen.paymentMethod, paymentMethodLabel: chosen.text };
    if (session.data.editing) return finishGastoReceitaConfirm(await updateStep(session, "confirmar", { ...patch, editing: false }, { client }), client);
    await askCategoria(await updateStep(session, "categoria", patch, { client }), client);
    return;
  }

  if (session.step === "data" && callbackData.startsWith("date:")) {
    const key = callbackData.slice(5);
    if (session.flow === "cartao_compra") {
      if (key === "hoje") return finishCartaoCompraConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("hoje") }, { client }), client);
      if (key === "ontem") return finishCartaoCompraConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("ontem") }, { client }), client);
      await updateStep(session, "data_texto", {}, { client });
      await ask(session, "Digite a data (ex: \"12/03\" ou \"12/03/2026\"):", undefined, client);
      return;
    }
    if (session.flow === "parcela") {
      if (key === "hoje") return finishParcelaConfirm2(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("hoje") }, { client }), client);
      if (key === "ontem") return finishParcelaConfirm2(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("ontem") }, { client }), client);
      await updateStep(session, "data_texto", {}, { client });
      await ask(session, "Digite a data (ex: \"12/03\" ou \"12/03/2026\"):", undefined, client);
      return;
    }
    if (session.flow === "transferencia") {
      if (key === "hoje") return finishTransferenciaConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("hoje") }, { client }), client);
      if (key === "ontem") return finishTransferenciaConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO("ontem") }, { client }), client);
      await updateStep(session, "data_texto", {}, { client });
      await ask(session, "Digite a data (ex: \"12/03\" ou \"12/03/2026\"):", undefined, client);
      return;
    }
    if (session.flow === "fatura_pagar") {
      if (key === "hoje" || key === "ontem") return finishFaturaPagarConfirm(await updateStep(session, "confirmar", { occurredAtISO: quickDateISO(key) }, { client }), client);
      await updateStep(session, "data_texto", {}, { client });
      await ask(session, "Digite a data (ex: \"12/03\" ou \"12/03/2026\"):", undefined, client);
      return;
    }
    if (session.flow === "gasto" || session.flow === "receita") await applyQuickDate(session, key, client);
    return;
  }

  if (session.step === "cartao" && callbackData.startsWith("card:")) {
    const cardId = callbackData.slice(5);
    const card = await client.card.findUnique({ where: { id: cardId } });
    if (session.flow === "cartao_compra") return askCartaoCategoria(await updateStep(session, "categoria", { cardId, cardName: card.name }, { client }), client);
    if (session.flow === "parcela") return askParcelaCategoria(await updateStep(session, "categoria", { cardId, cardName: card.name }, { client }), client);
    if (session.flow === "fatura_atual") return askFaturaValor(await updateStep(session, "valor", { cardId, cardName: card.name }, { client }), client);
    if (session.flow === "fatura_pagar") return askFaturaPagarValor(await updateStep(session, "valor", { cardId, cardName: card.name }, { client }), client);
    return;
  }

  if (session.step === "parcelas" && callbackData.startsWith("qtd:")) {
    const raw = callbackData.slice(4);
    if (raw === "outro") {
      await updateStep(session, "parcelas_texto", {}, { client });
      await ask(session, "Quantas parcelas? (número)", undefined, client);
      return;
    }
    const installmentCount = parseInt(raw, 10);
    await askParcelaCartao(await updateStep(session, "cartao", { installmentCount }, { client }), client);
    return;
  }

  if (session.step === "merchant" && callbackData === "skip:merchant") {
    await askParcelaQtd(await updateStep(session, "parcelas", { merchant: null }, { client }), client);
    return;
  }
  if (session.step === "descricao" && session.flow === "transferencia" && callbackData === "skip:descricao") {
    await askTransferenciaData(await updateStep(session, "data", { description: null }, { client }), client);
    return;
  }

  if (session.step === "origem" && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    if (accountId === session.data.toAccountId) {
      await sendMessage(session.chatId, "Origem e destino não podem ser a mesma conta.");
      return;
    }
    const account = await client.account.findUnique({ where: { id: accountId } });
    await askTransferenciaDestino(await updateStep(session, "destino", { fromAccountId: accountId, fromAccountName: account.name }, { client }), client);
    return;
  }
  if (session.step === "destino" && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    if (accountId === session.data.fromAccountId) {
      await sendMessage(session.chatId, "Origem e destino não podem ser a mesma conta.");
      return;
    }
    const account = await client.account.findUnique({ where: { id: accountId } });
    await askTransferenciaDescricao(await updateStep(session, "descricao", { toAccountId: accountId, toAccountName: account.name }, { client }), client);
    return;
  }

  if (session.step === "vencimento" && callbackData.startsWith("due:")) {
    const value = callbackData.slice(4);
    if (value === "outra") {
      await updateStep(session, "vencimento_texto", {}, { client });
      await ask(session, "Digite a data (ex: \"dia 25\", \"mês que vem\"):", undefined, client);
      return;
    }
    const dueDate = await resolveDate(value);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null }, { client });
    await finishNovaContaDate(session, client);
    return;
  }

  if (session.step === "acao" && callbackData.startsWith("pagmenu:")) {
    const choice = callbackData.slice(8);
    if (choice === "nova") await startNovaConta(session, client);
    else if (choice === "marcar") await startMarcarPaga(session, client);
    else if (choice === "fatura") await startFaturaValor(session, "pagar_fatura", client);
    else if (choice === "antecipar") await startFaturaValor(session, "antecipar_fatura", client);
    return;
  }

  if (session.step === "escolher_bill" && callbackData.startsWith("bill:")) {
    const billId = callbackData.slice(5);
    await updateStep(session, "conta_origem", { billId }, { client });
    await ask(session, "Pago com qual conta?", { replyMarkup: await targetKeyboard(client) }, client);
    return;
  }

  if (session.step === "conta_origem" && callbackData.startsWith("tgt:")) {
    const target = await resolveTarget(callbackData, client);
    if (target.type !== "account") {
      await ask(session, "Escolhe uma conta (não um cartão) pra pagar essa conta.", { replyMarkup: await targetKeyboard(client) }, client);
      return;
    }
    await updateStep(session, "confirmar", { targetType: "account", targetId: target.account.id, targetLabel: target.account.name }, { client });
    await finishMarcarPagaConfirm(session, client);
    return;
  }

  // ---- Planejamento (Fase 7D.1): pagar/resolver/receber/editar ----

  if (session.step === "escolher" && session.flow === "compromisso_pagar" && callbackData.startsWith("cpay:")) {
    return askCompromissoPagarConta(session, callbackData.slice(5), client);
  }
  if (session.step === "conta" && session.flow === "fatura_pagar" && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    const account = await client.account.findUnique({ where: { id: accountId } });
    if (!account) return { unhandled: true };
    await updateStep(session, "data", { accountId, accountName: account.name }, { client });
    await ask(session, `Conta: ${account.name}\n\nQuando foi o pagamento?`, { replyMarkup: DATE_QUICK_KEYBOARD }, client);
    return;
  }
  if (session.step === "conta" && (session.flow === "compromisso_pagar" || session.flow === "recebivel_receber") && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    const account = await client.account.findUnique({ where: { id: accountId } });
    await updateStep(session, "confirmar", { accountId, accountName: account.name }, { client });
    if (session.flow === "compromisso_pagar") return finishCompromissoPagarPreview(session, client);
    return finishRecebivelReceberPreview(session, client);
  }

  if (session.step === "escolher" && session.flow === "compromisso_editar" && callbackData.startsWith("cedit:")) {
    return askCompromissoEditarCampo(session, callbackData.slice(6), client);
  }
  if (session.step === "campo" && session.flow === "compromisso_editar" && callbackData.startsWith("cfield:")) {
    const field = callbackData.slice(7); // "amount" | "dueDate"
    await updateStep(session, "novo_valor", { field }, { client });
    await ask(session, field === "amount" ? "Novo valor?" : "Nova data de vencimento? (ex: \"dia 25\", \"12/03\")", undefined, client);
    return;
  }

  if (session.step === "escolher" && session.flow === "contingencia_resolver" && callbackData.startsWith("cgpick:")) {
    return askContingenciaResolverStatus(session, callbackData.slice(7), client);
  }
  if (session.step === "status" && session.flow === "contingencia_resolver" && callbackData.startsWith("cgstatus:")) {
    const newStatus = callbackData.slice(9);
    await updateStep(session, "confirmar", { newStatus }, { client });
    return finishContingenciaResolverPreview(session, client);
  }
  if (session.step === "escolher" && session.flow === "contingencia_editar" && callbackData.startsWith("cgeditpick:")) {
    const contingencyId = callbackData.slice(11);
    await updateStep(session, "novo_valor", { contingencyId }, { client });
    await ask(session, "Novo valor MÁXIMO?", undefined, client);
    return;
  }

  if (session.step === "escolher" && session.flow === "recebivel_receber" && callbackData.startsWith("rpick:")) {
    return askRecebivelReceberConta(session, callbackData.slice(6), client);
  }
  if (session.step === "escolher" && session.flow === "recebivel_editar" && callbackData.startsWith("reditpick:")) {
    const receivableId = callbackData.slice(10);
    await updateStep(session, "novo_valor", { receivableId }, { client });
    await ask(session, "Novo valor?", undefined, client);
    return;
  }

  if (session.step === "escolher" && session.flow === "meta_editar" && callbackData.startsWith("gpick:")) {
    const goalId = callbackData.slice(6);
    const { listGoals } = await import("./goals.js");
    const goal = (await listGoals({ client })).find((g) => g.id === goalId);
    if (!goal) {
      await finish(session, "⚠️ Não achei mais essa meta.", client);
      return;
    }
    await updateStep(session, "novo_valor", { goalId, goalName: goal.name }, { client });
    await ask(session, `${goal.name}\n\nNovo valor alvo?`, undefined, client);
    return;
  }

  // ---- Vários lançamentos (batch) ----
  if (session.step === "menu" && callbackData.startsWith("batch:")) {
    const action = callbackData.slice(6);
    if (action.startsWith("add:")) return startBatchItem(session, client, action.slice(4));
    if (action === "removelast") {
      const items = (session.data.items || []).slice(0, -1);
      await updateStep(session, "menu", { items }, { client });
      return renderBatchList(session, client, "📚 Vários lançamentos");
    }
    if (action === "review") return finishBatchReview(session, client);
    if (action === "cancel") {
      await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
      await ask(session, "Lote cancelado — nenhum item foi salvo.", undefined, client);
      return;
    }
  }
  if (session.step === "item_meio" && callbackData.startsWith("bpm:")) {
    const key = `pm:${callbackData.slice(4)}`;
    const kind = session.data.itemKind;
    const options = kind === "receita" ? INCOME_TARGET_ACCOUNT_TYPES : EXPENSE_PAYMENT_OPTIONS;
    const chosen = options.find((o) => o.data === key);
    if (!chosen) return;
    const account = chosen.isCard ? null : await findAccountByType(chosen.accountType, client);
    if (chosen.isCard) {
      const card = await client.card.findFirst({ orderBy: { createdAt: "asc" } });
      return finishBatchItem(session, client, { targetType: "card", targetId: card.id, targetLabel: `Cartão ${card.name}` });
    }
    return finishBatchItem(session, client, { targetType: "account", targetId: account.id, targetLabel: account.name });
  }
  if (session.step === "item_meio" && callbackData.startsWith("batchcard:")) {
    const cardId = callbackData.slice(10);
    const card = await client.card.findUnique({ where: { id: cardId } });
    return finishBatchItem(session, client, { targetType: "card", targetId: cardId, targetLabel: `Cartão ${card.name}` });
  }
  if (session.step === "item_parcelas" && callbackData.startsWith("bqtd:")) {
    return askBatchParceladoCartao(session, client, parseInt(callbackData.slice(5), 10));
  }
  if (session.step === "item_cartao" && callbackData.startsWith("bcard:")) {
    const cardId = callbackData.slice(6);
    const card = await client.card.findUnique({ where: { id: cardId } });
    return finishBatchItem(session, client, { installmentCount: session.data.itemInstallmentCount, cardId, cardName: card.name });
  }
  if (session.step === "item_origem" && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    const account = await client.account.findUnique({ where: { id: accountId } });
    const keyboard = await accountKeyboard(client, accountId);
    await updateStep(session, "item_destino", { itemFromAccountId: accountId, itemFromAccountName: account.name }, { client });
    await ask(session, `De: ${account.name}\n\nPra onde vai?`, { replyMarkup: withNav(keyboard.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, data: b.callback_data })))) }, client);
    return;
  }
  if (session.step === "item_destino" && callbackData.startsWith("acct:")) {
    const accountId = callbackData.slice(5);
    const account = await client.account.findUnique({ where: { id: accountId } });
    return finishBatchItem(session, client, { fromAccountId: session.data.itemFromAccountId, fromAccountName: session.data.itemFromAccountName, toAccountId: accountId, toAccountName: account.name });
  }

  // ---- Simulador ----
  if (session.step === "modo" && callbackData.startsWith("simmode:")) {
    const modo = callbackData.slice(8);
    if (modo === "avista") return askSimuladorPagamento(await updateStep(session, "pagamento", { modo }, { client }), client);
    return askSimuladorParcelas(await updateStep(session, "parcelas", { modo }, { client }), client);
  }
  if (session.step === "pagamento" && callbackData.startsWith("simpm:")) {
    const pagamento = callbackData.slice(6);
    if (pagamento === "cartao") return askSimuladorCartao(await updateStep(session, "cartao", { pagamento }, { client }), client);
    return runSimulacao(await updateStep(session, "resultado", { pagamento }, { client }), client);
  }
  if (session.step === "parcelas" && callbackData.startsWith("simqtd:")) {
    const installmentCount = parseInt(callbackData.slice(7), 10);
    return askSimuladorCartao(await updateStep(session, "cartao", { installmentCount }, { client }), client);
  }
  if (session.step === "cartao" && callbackData.startsWith("simcard:")) {
    const cardId = callbackData.slice(8);
    return runSimulacao(await updateStep(session, "resultado", { cardId }, { client }), client);
  }
  if (session.step === "resultado" && callbackData === "simreg") {
    return seedRealWizardFromSimulation(session, client);
  }

  // ---- Correção — escolha de categoria pro campo "category" ----
  if (session.flow === "corrigir_campo" && session.step === "novo_valor" && callbackData.startsWith("corcat:")) {
    const category = callbackData.slice(7);
    return finishCorrectionPreview(session, client, { category });
  }

  if (session.step === "confirmar" && callbackData === "confirm:no") {
    await finish(session, "Cancelado.", client);
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:yes") {
    // ÚNICO ponto do wizard com efeito financeiro real. reply calculado e
    // persistido AQUI (dentro da transação vinda de fora, via `client`);
    // NENHUMA chamada de Telegram acontece nesta função pra este branch —
    // devolve um descritor pro caller enviar depois do commit.
    // Fase 7D.1 — a escrita roda dentro de um SAVEPOINT (lib/txGuard.js): qualquer
    // erro (domínio OU SQL/CHECK) desfaz SÓ esta escrita — zero persistência
    // parcial (vital pro lote) — e vira resposta amigável, em vez de abortar a
    // transação do update inteiro. Sem transação (client === prisma) propaga.
    const guarded = await runGuarded(client, async () => {
      let reply;
      if (session.flow === "nova_conta") reply = await commitNovaConta(session, client);
      else if (session.flow === "gasto" || session.flow === "receita") reply = await commitGastoReceita(session, client);
      else if (session.flow === "cartao_compra") reply = await commitCartaoCompra(session, client);
      else if (session.flow === "parcela") reply = await commitParcela(session, client);
      else if (session.flow === "transferencia") reply = await commitTransferencia(session, client);
      else if (session.flow === "saldo") reply = await commitSaldo(session, client);
      else if (session.flow === "fatura_atual") reply = await commitFaturaAtual(session, client);
      else if (session.flow === "fatura_pagar") reply = await commitFaturaPagar(session, client);
      else if (session.flow === "compromisso") reply = await commitCompromisso(session, client);
      else if (session.flow === "contingencia") reply = await commitContingencia(session, client);
      else if (session.flow === "recebivel") reply = await commitRecebivel(session, client);
      else if (session.flow === "compromisso_pagar") reply = await commitCompromissoPagar(session, client);
      else if (session.flow === "compromisso_editar") reply = await commitCompromissoEditar(session, client);
      else if (session.flow === "contingencia_resolver") reply = await commitContingenciaResolver(session, client);
      else if (session.flow === "contingencia_editar") reply = await commitContingenciaEditar(session, client);
      else if (session.flow === "recebivel_receber") reply = await commitRecebivelReceber(session, client);
      else if (session.flow === "recebivel_editar") reply = await commitRecebivelEditar(session, client);
      else if (session.flow === "meta_nova") reply = await commitMetaNova(session, client);
      else if (session.flow === "meta_editar") reply = await commitMetaEditar(session, client);
      else if (session.flow === "multipla") reply = await commitBatch(session, client);
      else if (session.flow === "corrigir_campo") reply = await commitCorrection(session, client);
      else if (session.flow === "marcar_paga") reply = await commitMarcarPaga(session, client);
      else if (session.flow === "pagar_fatura" || session.flow === "antecipar_fatura") reply = await commitFatura(session, client);
      return reply;
    });
    if (!guarded.ok) {
      await client.botWizardSession.delete({ where: { id: session.id } });
      return { deferredReply: { chatId: session.chatId, messageId: session.messageId, text: `⚠️ Não consegui registrar: ${friendlyErrorMessage(guarded.error)}. Nada foi gravado.` } };
    }
    const reply = guarded.value;
    await client.botWizardSession.delete({ where: { id: session.id } });
    // Fase 7D.1 — commit* normalmente devolve uma STRING; alguns (correção,
    // com "↩️ Desfazer") devolvem {text, keyboard} pra anexar um teclado na
    // mensagem final. Ambos os formatos são suportados aqui, sem quebrar os
    // ~15 commit* que só devolvem texto.
    const isRich = reply && typeof reply === "object";
    return { deferredReply: { chatId: session.chatId, messageId: session.messageId, text: (isRich ? reply.text : reply) || "✅ Feito.", replyMarkup: isRich ? reply.keyboard : undefined } };
  }

  // Nenhum branch reconheceu este callback neste passo do wizard (botão
  // antigo, passo já avançado, dado forjado): nenhuma ação, o caller avisa.
  return { unhandled: true };
}

export function isStartableFlow(flow) {
  return Object.prototype.hasOwnProperty.call(FLOW_START, flow);
}

export async function handleWizardText(chatId, text, { client = prisma } = {}) {
  const session = await client.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  // Item 28 — mesmo fix de handleWizardCallback: texto respondendo um
  // step de uma sessão já expirada nunca deve avançar/gravar nada.
  if (session.expiresAt <= new Date()) {
    await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    await sendMessage(session.chatId, "Essa sessão expirou. Abre o menu de novo pra continuar.");
    return true;
  }
  const trimmed = text.trim();

  if (session.flow === "nova_conta" && session.step === "descricao") {
    await updateStep(session, "valor", { description: trimmed }, { client });
    await ask(session, `Descrição: ${trimmed}\n\nQuanto é?`, undefined, client);
    return true;
  }
  if (session.flow === "nova_conta" && session.step === "vencimento_texto") {
    const dueDate = await resolveDate(trimmed);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null }, { client });
    await finishNovaContaDate(session, client);
    return true;
  }

  // ---- valor (item 32 — parser determinístico de moeda) ----
  if (session.step === "valor") {
    const { amount } = extractAmount(trimmed);
    if (amount == null) {
      await sendMessage(session.chatId, "Não entendi o valor. Manda só o número, tipo \"117,30\".");
      return true;
    }
    if (session.flow === "nova_conta") {
      const keyboard = buildInlineKeyboard([...chunk(QUICK_DUE_OPTIONS.map((o) => ({ text: o.text, data: `due:${o.value}` })), 2), [{ text: "Outra data", data: "due:outra" }]]);
      await updateStep(session, "vencimento", { amount }, { client });
      await ask(session, `Valor: ${formatMoney(amount)}\n\nVence quando?`, { replyMarkup: keyboard }, client);
    } else if (session.flow === "gasto" || session.flow === "receita") {
      if (session.data.editing) return void (await finishGastoReceitaConfirm(await updateStep(session, "confirmar", { amount, editing: false }, { client }), client)), true;
      await askDescricao(await updateStep(session, "descricao", { amount }, { client }), client);
    } else if (session.flow === "cartao_compra") {
      await askCartaoDescricao(await updateStep(session, "descricao", { amount }, { client }), client);
    } else if (session.flow === "parcela") {
      await askParcelaDescricao(await updateStep(session, "descricao", { amount }, { client }), client);
    } else if (session.flow === "transferencia") {
      await askTransferenciaOrigem(await updateStep(session, "origem", { amount }, { client }), client);
    } else if (session.flow === "saldo") {
      await finishSaldoPreview(await updateStep(session, "confirmar", { amount }, { client }), client);
    } else if (session.flow === "fatura_atual") {
      await finishFaturaPreview(await updateStep(session, "confirmar", { amount }, { client }), client);
    } else if (session.flow === "contingencia") {
      await finishContingenciaPreview(await updateStep(session, "confirmar", { maxAmount: amount }, { client }), client);
    } else if (session.flow === "recebivel") {
      await finishRecebivelPreview(await updateStep(session, "confirmar", { amount }, { client }), client);
    } else if (session.flow === "simulador") {
      await askSimuladorModo(await updateStep(session, "modo", { amount }, { client }), client);
    } else if (session.flow === "fatura_pagar") {
      await askFaturaPagarConta(await updateStep(session, "conta", { amount }, { client }), client);
    } else if (session.flow === "meta_nova") {
      await finishMetaNovaPreview(await updateStep(session, "confirmar", { targetAmount: amount }, { client }), client);
    } else if (session.flow === "pagar_fatura" || session.flow === "antecipar_fatura") {
      await updateStep(session, "confirmar", { amount }, { client });
      const summary = [
        "Confirma?", "",
        `${session.flow === "antecipar_fatura" ? "⏩ Antecipação" : "💳 Pagamento de fatura"}: ${formatMoney(amount)}`,
      ].join("\n");
      await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
    }
    return true;
  }

  if (session.step === "item_valor") {
    const { amount } = extractAmount(trimmed);
    if (amount == null) {
      await sendMessage(session.chatId, "Não entendi o valor. Manda só o número.");
      return true;
    }
    await askBatchDescricao(await updateStep(session, "item_descricao", { itemAmount: amount }, { client }), client);
    return true;
  }
  if (session.step === "item_descricao") {
    await askBatchMeio(await updateStep(session, "item_meio", { itemDescription: trimmed }, { client }), client);
    return true;
  }

  if (session.flow === "gasto" || session.flow === "receita") {
    if (session.step === "descricao") {
      if (session.data.editing) return void (await finishGastoReceitaConfirm(await updateStep(session, "confirmar", { description: trimmed, editing: false }, { client }), client)), true;
      return void (await askComoPagou(await updateStep(session, "meio", { description: trimmed }, { client }), client)), true;
    }
    if (session.step === "data_texto") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await finishGastoReceitaConfirm(await updateStep(session, "confirmar", { occurredAtISO: resolved.date.toISOString() }, { client }), client);
      return true;
    }
  }

  if (session.flow === "cartao_compra") {
    if (session.step === "descricao") return void (await askCartaoCartao(await updateStep(session, "cartao", { description: trimmed }, { client }), client)), true;
    if (session.step === "data_texto") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await finishCartaoCompraConfirm(await updateStep(session, "confirmar", { occurredAtISO: resolved.date.toISOString() }, { client }), client);
      return true;
    }
  }

  if (session.flow === "parcela") {
    if (session.step === "descricao") return void (await askParcelaMerchant(await updateStep(session, "merchant", { description: trimmed }, { client }), client)), true;
    if (session.step === "merchant") return void (await askParcelaQtd(await updateStep(session, "parcelas", { merchant: trimmed }, { client }), client)), true;
    if (session.step === "parcelas_texto") {
      const n = parseInt(trimmed, 10);
      if (!Number.isInteger(n) || n < 2 || n > 48) {
        await sendMessage(session.chatId, "Manda um número de parcelas válido (2 a 48).");
        return true;
      }
      await askParcelaCartao(await updateStep(session, "cartao", { installmentCount: n }, { client }), client);
      return true;
    }
    if (session.step === "data_texto") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await finishParcelaConfirm2(await updateStep(session, "confirmar", { occurredAtISO: resolved.date.toISOString() }, { client }), client);
      return true;
    }
  }

  if (session.flow === "transferencia") {
    if (session.step === "descricao") return void (await askTransferenciaData(await updateStep(session, "data", { description: trimmed }, { client }), client)), true;
    if (session.step === "data_texto") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await finishTransferenciaConfirm(await updateStep(session, "confirmar", { occurredAtISO: resolved.date.toISOString() }, { client }), client);
      return true;
    }
  }

  if (session.flow === "compromisso") {
    if (session.step === "descricao") {
      await updateStep(session, "valor", { description: trimmed }, { client });
      await ask(session, `${trimmed}\n\nQual o valor?`, undefined, client);
      return true;
    }
    if (session.step === "valor") {
      const { amount } = extractAmount(trimmed);
      if (amount == null) {
        await sendMessage(session.chatId, "Não entendi o valor.");
        return true;
      }
      await updateStep(session, "vencimento_texto", { amount }, { client });
      await ask(session, "Vence quando? (ex: \"dia 25\", \"12/03\")", undefined, client);
      return true;
    }
    if (session.step === "vencimento_texto") {
      const dueDate = await resolveDate(trimmed);
      if (!dueDate) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta de novo.");
        return true;
      }
      await finishCompromissoPreview(await updateStep(session, "confirmar", { dueDateISO: dueDate.toISOString() }, { client }), client);
      return true;
    }
  }

  if (session.flow === "contingencia") {
    if (session.step === "descricao") return void (await askContingenciaMax(await updateStep(session, "maximo", { description: trimmed }, { client }), client)), true;
    if (session.step === "maximo") {
      const { amount } = extractAmount(trimmed);
      if (amount == null) {
        await sendMessage(session.chatId, "Não entendi o valor.");
        return true;
      }
      await finishContingenciaPreview(await updateStep(session, "confirmar", { maxAmount: amount }, { client }), client);
      return true;
    }
  }

  if (session.flow === "recebivel") {
    if (session.step === "descricao") return void (await askRecebivelContraparte(await updateStep(session, "contraparte", { description: trimmed }, { client }), client)), true;
    if (session.step === "contraparte") return void (await askRecebivelValor(await updateStep(session, "valor", { counterparty: trimmed }, { client }), client)), true;
  }

  // ---- Fase 7D.1 — editar compromisso (campo escolhido via callback antes) ----
  if (session.flow === "compromisso_editar" && session.step === "novo_valor") {
    const { getCommitment } = await import("./commitments.js");
    const commitment = await getCommitment(session.data.commitmentId, { client });
    if (!commitment) {
      await sendMessage(session.chatId, "⚠️ Não achei mais esse compromisso.");
      return true;
    }
    if (session.data.field === "amount") {
      const { amount } = extractAmount(trimmed);
      if (amount == null) {
        await sendMessage(session.chatId, "Não entendi o valor.");
        return true;
      }
      await updateStep(session, "confirmar", { newAmount: amount }, { client });
      await ask(session, ["Confirma?", "", `📌 ${commitment.description}`, `${formatMoney(serializeMoney(commitment.amount))} -> ${formatMoney(amount)}`].join("\n"), { replyMarkup: CONFIRM_KEYBOARD }, client);
      return true;
    }
    const dueDate = await resolveDate(trimmed);
    if (!dueDate) {
      await sendMessage(session.chatId, "Não entendi a data. Tenta de novo.");
      return true;
    }
    await updateStep(session, "confirmar", { newDueDate: dueDate.toISOString() }, { client });
    await ask(session, ["Confirma?", "", `📌 ${commitment.description}`, `Vencimento: ${formatDate(commitment.dueDate)} -> ${formatDate(dueDate)}`].join("\n"), { replyMarkup: CONFIRM_KEYBOARD }, client);
    return true;
  }

  // ---- Fase 7D.1 — editar contingência (só maxAmount) ----
  if (session.flow === "contingencia_editar" && session.step === "novo_valor") {
    const { amount } = extractAmount(trimmed);
    if (amount == null) {
      await sendMessage(session.chatId, "Não entendi o valor.");
      return true;
    }
    // A tabela tem CHECK (esperado <= máximo): avisa e pergunta de novo em vez
    // de deixar o usuário chegar no "Confirmar" pra só então falhar.
    const current = (await listContingencies({ client })).find((c) => c.id === session.data.contingencyId);
    if (current?.expectedAmount != null && Number(amount) < Number(current.expectedAmount)) {
      await sendMessage(session.chatId, `O máximo não pode ser menor que o esperado (${formatMoney(Number(current.expectedAmount))}). Manda outro valor.`);
      return true;
    }
    await updateStep(session, "confirmar", { newMaxAmount: amount }, { client });
    await ask(session, ["Confirma?", "", `Novo máximo: ${formatMoney(amount)}`].join("\n"), { replyMarkup: CONFIRM_KEYBOARD }, client);
    return true;
  }

  // ---- Fase 7D.1 — editar valor a receber (só amount) ----
  if (session.flow === "recebivel_editar" && session.step === "novo_valor") {
    const { amount } = extractAmount(trimmed);
    if (amount == null) {
      await sendMessage(session.chatId, "Não entendi o valor.");
      return true;
    }
    await updateStep(session, "confirmar", { newAmount: amount }, { client });
    await ask(session, ["Confirma?", "", `Novo valor: ${formatMoney(amount)}`].join("\n"), { replyMarkup: CONFIRM_KEYBOARD }, client);
    return true;
  }

  // ---- Fase 7D.1 — nova meta (passo "nome" só; "valor" é tratado no bloco
  // genérico de session.step==="valor" acima, igual todo outro flow) ----
  if (session.flow === "meta_nova" && session.step === "nome") {
    await updateStep(session, "valor", { goalName: trimmed }, { client });
    await ask(session, `${trimmed}\n\nQuanto você quer guardar (valor alvo)?`, undefined, client);
    return true;
  }

  // ---- Fase 7D.1 — editar meta (só targetAmount) ----
  if (session.flow === "meta_editar" && session.step === "novo_valor") {
    const { amount } = extractAmount(trimmed);
    if (amount == null) {
      await sendMessage(session.chatId, "Não entendi o valor.");
      return true;
    }
    await finishMetaEditarPreview(await updateStep(session, "confirmar", { targetAmount: amount }, { client }), client);
    return true;
  }

  if (session.flow === "categoria_periodo") {
    if (session.step === "inicio") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await askCategoriaFim(await updateStep(session, "fim", { inicioISO: resolved.date.toISOString().slice(0, 10) }, { client }), client);
      return true;
    }
    if (session.step === "fim") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      const fimISO = resolved.date.toISOString().slice(0, 10);
      if (fimISO < session.data.inicioISO) {
        await sendMessage(session.chatId, "A data final precisa ser igual ou depois da inicial. Manda a data final de novo.");
        return true;
      }
      await finishCategoriaPeriodo(await updateStep(session, "done", { fimISO }, { client }), client);
      return true;
    }
  }

  if (session.flow === "fatura_pagar" && session.step === "data_texto") {
    const resolved = parseWizardDateText(trimmed);
    if (!resolved.ok) {
      await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
      return true;
    }
    await finishFaturaPagarConfirm(await updateStep(session, "confirmar", { occurredAtISO: resolved.date.toISOString() }, { client }), client);
    return true;
  }

  if (session.flow === "corrigir_campo" && session.step === "novo_valor") {
    const field = session.data.field;
    if (field === "amount") {
      const { amount } = extractAmount(trimmed);
      if (amount == null) {
        await sendMessage(session.chatId, "Não entendi o valor.");
        return true;
      }
      await finishCorrectionPreview(session, client, { amount: String(amount.toFixed ? amount.toFixed(2) : amount) });
      return true;
    }
    if (field === "description") {
      await finishCorrectionPreview(session, client, { description: trimmed });
      return true;
    }
    if (field === "date") {
      const resolved = parseWizardDateText(trimmed);
      if (!resolved.ok) {
        await sendMessage(session.chatId, "Não entendi a data. Tenta \"12/03\" ou \"12/03/2026\".");
        return true;
      }
      await finishCorrectionPreview(session, client, { date: resolved.date.toISOString().slice(0, 10) });
      return true;
    }
  }

  if (session.step === "parcelas" && session.flow === "parcela") {
    // usuário digitou em vez de clicar num botão de quantidade — aceita número direto.
    const n = parseInt(trimmed, 10);
    if (Number.isInteger(n) && n >= 2 && n <= 48) {
      await askParcelaCartao(await updateStep(session, "cartao", { installmentCount: n }, { client }), client);
      return true;
    }
  }

  // dentro do assistente, num passo que só aceita botão — avisa em vez de ignorar quieto
  await sendMessage(session.chatId, "Usa os botões aí em cima 👆 (ou manda /cancelar pra desistir).");
  return true;
}
