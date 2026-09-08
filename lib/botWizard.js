import { prisma } from "./prisma.js";
import { CATEGORIES } from "./categoryRules.js";
import { extractAmount } from "./amountExtractor.js";
import { resolveDate } from "./naturalDate.js";
import { createBill, markBillPaid, listBills } from "./bills.js";
import { commitBotIntent } from "./commitBotIntent.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { sendMessage, editMessageText, buildInlineKeyboard, chunk } from "./telegramApi.js";

const WIZARD_TTL_MS = 20 * 60 * 1000;

const QUICK_DUE_OPTIONS = [
  { text: "Hoje", value: "hoje" },
  { text: "Amanhã", value: "amanha" },
  { text: "Dia 10", value: "dia 10" },
  { text: "Dia 15", value: "dia 15" },
  { text: "Dia 20", value: "dia 20" },
  { text: "Fim do mês", value: "fim do mes" },
];

const QUICK_INSTALLMENT_COUNTS = [2, 3, 6, 10, 12];

const FLOW_START = {
  nova_conta: startNovaConta,
  gasto: startValorFirst,
  receita: startValorFirst,
  parcela: startParcela,
  vou_pagar_menu: startVouPagarMenu,
};

// Menu principal — teclado fixo do Telegram (fica sempre visível embaixo da caixa de
// texto, diferente do teclado inline usado dentro de cada pergunta do assistente).
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
// fim (hoje só o caminho de "sem contas pendentes" em startMarcarPaga) —
// continua com ask() inline, sem necessidade de adiar resposta.
async function finish(session, reply, client = prisma) {
  await client.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
  await ask(session, reply || "✅ Feito.", undefined, client);
}

const CONFIRM_KEYBOARD = buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]);

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

// ============================== nova_conta ==============================

async function startNovaConta(session, client = prisma) {
  const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
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

// ============================== gasto / receita ==============================

async function startValorFirst(session, client = prisma) {
  const label = session.flow === "receita" ? "Nova receita 💰" : "Novo gasto 💸";
  await updateStep(session, "valor", {}, { client });
  await ask(session, `${label}\n\nQuanto foi?`, undefined, client);
}

async function finishGastoReceitaConfirm(session, client = prisma) {
  const isReceita = session.flow === "receita";
  const summary = [
    "Confirma?", "",
    `${isReceita ? "💰" : "💸"} ${isReceita ? "Receita" : "Gasto"}: ${formatMoney(session.data.amount)}`,
    `🏷️ ${session.data.category}`,
    `🏦 ${session.data.targetLabel}`,
  ].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitGastoReceita(session, client) {
  const target = session.data.targetType === "card"
    ? { type: "card", card: await client.card.findUnique({ where: { id: session.data.targetId } }) }
    : { type: "account", account: await client.account.findUnique({ where: { id: session.data.targetId } }) };

  const data = {
    amount: session.data.amount,
    category: session.data.category,
    description: session.data.category,
    rawMessage: "assistente guiado",
    isRecurring: false,
    target,
  };
  const intent = session.flow === "receita" ? "income" : "expense";
  const { reply } = await commitBotIntent(intent, data, { source: "telegram", client });
  return reply;
}

// ============================== parcela ==============================

async function startParcela(session, client = prisma) {
  await updateStep(session, "valor", {}, { client });
  await ask(session, "Compra parcelada 🔁\n\nQual o valor total?", undefined, client);
}

async function finishParcelaConfirm(session, client = prisma) {
  const summary = [
    "Confirma?", "",
    `🔁 ${session.data.description}`,
    `💰 ${formatMoney(session.data.amount)} em ${session.data.installmentCount}x`,
    `🏷️ ${session.data.category}`,
  ].join("\n");
  await updateStep(session, "confirmar", {}, { client });
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD }, client);
}

async function commitParcela(session, client) {
  const card = await client.card.findFirst({ orderBy: { createdAt: "asc" } });
  const data = {
    amount: session.data.amount,
    installmentCount: session.data.installmentCount,
    category: session.data.category,
    description: session.data.description,
    rawMessage: "assistente guiado",
    target: { type: "card", card },
  };
  const { reply } = await commitBotIntent("installment_purchase", data, { source: "telegram", client });
  return reply;
}

// ============================== vou_pagar (menu) ==============================

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
  if (!session) return;

  if (session.step === "categoria" && callbackData.startsWith("cat:")) {
    const category = callbackData.slice(4);
    if (session.flow === "nova_conta") {
      await updateStep(session, "descricao", { category }, { client });
      await ask(session, `Categoria: ${category}\n\nQual a descrição? (ex: Internet, aluguel...)`, undefined, client);
    } else if (session.flow === "parcela") {
      await finishParcelaConfirm(await updateStep(session, "confirmar", { category }, { client }), client);
    } else {
      await updateStep(session, "alvo", { category }, { client });
      await ask(session, `Categoria: ${category}\n\nDe onde sai/entra o dinheiro?`, { replyMarkup: await targetKeyboard(client) }, client);
    }
    return;
  }

  if (session.step === "alvo" && callbackData.startsWith("tgt:")) {
    const target = await resolveTarget(callbackData, client);
    const label = target.type === "card" ? `Cartão ${target.card.name}` : target.account.name;
    await updateStep(session, "confirmar", { targetType: target.type, targetId: target.type === "card" ? target.card.id : target.account.id, targetLabel: label }, { client });
    await finishGastoReceitaConfirm(session, client);
    return;
  }

  if (session.step === "parcelas" && callbackData.startsWith("qtd:")) {
    const installmentCount = parseInt(callbackData.slice(4), 10);
    await updateStep(session, "descricao", { installmentCount }, { client });
    await ask(session, `${installmentCount}x\n\nQual a descrição da compra?`, undefined, client);
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

  if (session.step === "confirmar" && callbackData === "confirm:no") {
    await finish(session, "Cancelado.", client);
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:yes") {
    // ÚNICO ponto do wizard com efeito financeiro real. reply calculado e
    // persistido AQUI (dentro da transação vinda de fora, via `client`);
    // NENHUMA chamada de Telegram acontece nesta função pra este branch —
    // devolve um descritor pro caller enviar depois do commit.
    let reply;
    if (session.flow === "nova_conta") reply = await commitNovaConta(session, client);
    else if (session.flow === "gasto" || session.flow === "receita") reply = await commitGastoReceita(session, client);
    else if (session.flow === "parcela") reply = await commitParcela(session, client);
    else if (session.flow === "marcar_paga") reply = await commitMarcarPaga(session, client);
    else if (session.flow === "pagar_fatura" || session.flow === "antecipar_fatura") reply = await commitFatura(session, client);
    await client.botWizardSession.delete({ where: { id: session.id } });
    return { deferredReply: { chatId: session.chatId, messageId: session.messageId, text: reply || "✅ Feito." } };
  }
}

export async function handleWizardText(chatId, text, { client = prisma } = {}) {
  const session = await client.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
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
      const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
      await updateStep(session, "categoria", { amount }, { client });
      await ask(session, `Valor: ${formatMoney(amount)}\n\nQue categoria?`, { replyMarkup: keyboard }, client);
    } else if (session.flow === "parcela") {
      const keyboard = buildInlineKeyboard(chunk(QUICK_INSTALLMENT_COUNTS.map((n) => ({ text: `${n}x`, data: `qtd:${n}` })), 3));
      await updateStep(session, "parcelas", { amount }, { client });
      await ask(session, `Valor total: ${formatMoney(amount)}\n\nEm quantas vezes?`, { replyMarkup: keyboard }, client);
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

  if (session.flow === "parcela" && session.step === "descricao") {
    const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
    await updateStep(session, "categoria", { description: trimmed }, { client });
    await ask(session, `Descrição: ${trimmed}\n\nQue categoria?`, { replyMarkup: keyboard }, client);
    return true;
  }

  // dentro do assistente, num passo que só aceita botão — avisa em vez de ignorar quieto
  await sendMessage(session.chatId, "Usa os botões aí em cima 👆 (ou manda /cancelar pra desistir).");
  return true;
}
