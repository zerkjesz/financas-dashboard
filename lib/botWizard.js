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

export async function cancelWizard(chatId) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  await prisma.botWizardSession.delete({ where: { id: session.id } });
  await sendMessage(chatId, "Cancelado. Pode usar o menu de novo quando quiser.");
  return true;
}

export async function isInWizard(chatId) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  if (session.expiresAt <= new Date()) {
    await prisma.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
    return false;
  }
  return true;
}

export async function startWizard(chatId, flow) {
  const starter = FLOW_START[flow];
  if (!starter) throw new Error(`Fluxo de assistente desconhecido: ${flow}`);

  await prisma.botWizardSession.deleteMany({ where: { chatId } });
  const session = await prisma.botWizardSession.create({
    data: { chatId, flow, step: "start", data: {}, expiresAt: new Date(Date.now() + WIZARD_TTL_MS) },
  });
  await starter(session);
}

async function updateStep(session, step, dataPatch, { flow } = {}) {
  const data = { ...session.data, ...dataPatch };
  await prisma.botWizardSession.update({
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
async function ask(session, text, options) {
  if (session.messageId) {
    await editMessageText(session.chatId, session.messageId, text, options);
    return;
  }
  const sent = await sendMessage(session.chatId, text, options);
  if (sent?.result?.message_id) {
    await prisma.botWizardSession.update({ where: { id: session.id }, data: { messageId: sent.result.message_id } });
    session.messageId = sent.result.message_id;
  }
}

async function finish(session, reply) {
  await prisma.botWizardSession.delete({ where: { id: session.id } }).catch(() => {});
  await ask(session, reply || "✅ Feito.");
}

const CONFIRM_KEYBOARD = buildInlineKeyboard([[{ text: "✅ Confirmar", data: "confirm:yes" }, { text: "❌ Cancelar", data: "confirm:no" }]]);

// --- utilitário: teclado de conta/cartão pra pagar/receber ---
async function targetKeyboard() {
  const [accounts, cards] = await Promise.all([
    prisma.account.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.card.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const buttons = [
    ...accounts.map((a) => ({ text: a.name, data: `tgt:account:${a.id}` })),
    ...cards.map((c) => ({ text: `Cartão ${c.name}`, data: `tgt:card:${c.id}` })),
  ];
  return buildInlineKeyboard(chunk(buttons, 2));
}

async function resolveTarget(callbackData) {
  const [, type, id] = callbackData.split(":");
  if (type === "account") {
    const account = await prisma.account.findUnique({ where: { id } });
    return { type: "account", account };
  }
  const card = await prisma.card.findUnique({ where: { id } });
  return { type: "card", card };
}

// ============================== nova_conta ==============================

async function startNovaConta(session) {
  const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
  await updateStep(session, "categoria", {}, { flow: "nova_conta" });
  await ask(session, "Nova conta a pagar 📋\n\nQue categoria?", { replyMarkup: keyboard });
}

async function finishNovaContaDate(session) {
  const dueDate = session.data.pendingDate ? new Date(session.data.pendingDate) : null;
  if (!dueDate) {
    await updateStep(session, "vencimento_texto", {});
    await ask(session, "Não entendi essa data. Digite de novo (ex: \"dia 25\", \"mês que vem\"):");
    return;
  }
  await updateStep(session, "confirmar", { dueDateISO: dueDate.toISOString() });
  const summary = [
    "Confirma?", "",
    `📋 ${session.data.description}`,
    `💰 ${formatMoney(session.data.amount)}`,
    `📅 ${formatDate(dueDate)}`,
    `🏷️ ${session.data.category}`,
  ].join("\n");
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD });
}

async function commitNovaConta(session) {
  const bill = await createBill({
    description: session.data.description,
    amount: session.data.amount,
    category: session.data.category,
    dueDate: new Date(session.data.dueDateISO),
    source: "telegram",
    rawMessage: "assistente guiado",
  });
  return `✅ Conta "${bill.description}" criada: ${formatMoney(bill.amount)}, vence em ${formatDate(bill.dueDate)}.`;
}

// ============================== gasto / receita ==============================

async function startValorFirst(session) {
  const label = session.flow === "receita" ? "Nova receita 💰" : "Novo gasto 💸";
  await updateStep(session, "valor", {});
  await ask(session, `${label}\n\nQuanto foi?`);
}

async function finishGastoReceitaConfirm(session) {
  const isReceita = session.flow === "receita";
  const summary = [
    "Confirma?", "",
    `${isReceita ? "💰" : "💸"} ${isReceita ? "Receita" : "Gasto"}: ${formatMoney(session.data.amount)}`,
    `🏷️ ${session.data.category}`,
    `🏦 ${session.data.targetLabel}`,
  ].join("\n");
  await updateStep(session, "confirmar", {});
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD });
}

async function commitGastoReceita(session) {
  const target = session.data.targetType === "card"
    ? { type: "card", card: await prisma.card.findUnique({ where: { id: session.data.targetId } }) }
    : { type: "account", account: await prisma.account.findUnique({ where: { id: session.data.targetId } }) };

  const data = {
    amount: session.data.amount,
    category: session.data.category,
    description: session.data.category,
    rawMessage: "assistente guiado",
    isRecurring: false,
    target,
  };
  const intent = session.flow === "receita" ? "income" : "expense";
  const { reply } = await commitBotIntent(intent, data, { source: "telegram" });
  return reply;
}

// ============================== parcela ==============================

async function startParcela(session) {
  await updateStep(session, "valor", {});
  await ask(session, "Compra parcelada 🔁\n\nQual o valor total?");
}

async function finishParcelaConfirm(session) {
  const summary = [
    "Confirma?", "",
    `🔁 ${session.data.description}`,
    `💰 ${formatMoney(session.data.amount)} em ${session.data.installmentCount}x`,
    `🏷️ ${session.data.category}`,
  ].join("\n");
  await updateStep(session, "confirmar", {});
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD });
}

async function commitParcela(session) {
  const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
  const data = {
    amount: session.data.amount,
    installmentCount: session.data.installmentCount,
    category: session.data.category,
    description: session.data.description,
    rawMessage: "assistente guiado",
    target: { type: "card", card },
  };
  const { reply } = await commitBotIntent("installment_purchase", data, { source: "telegram" });
  return reply;
}

// ============================== vou_pagar (menu) ==============================

async function startVouPagarMenu(session) {
  const keyboard = buildInlineKeyboard([
    [{ text: "🆕 Nova conta", data: "pagmenu:nova" }],
    [{ text: "✅ Marcar como paga", data: "pagmenu:marcar" }],
    [{ text: "💳 Pagar fatura", data: "pagmenu:fatura" }],
    [{ text: "⏩ Antecipar fatura", data: "pagmenu:antecipar" }],
  ]);
  await updateStep(session, "acao", {});
  await ask(session, "Vou ter que pagar 📋\n\nO que você quer fazer?", { replyMarkup: keyboard });
}

async function startMarcarPaga(session) {
  const bills = await listBills({ status: ["pending", "overdue"], withinDays: 90 });
  if (bills.length === 0) {
    await finish(session, "Você não tem nenhuma conta pendente registrada. Use \"🆕 Nova conta\" primeiro.");
    return;
  }
  const buttons = bills.slice(0, 8).map((b) => [{ text: `${b.description} — ${formatMoney(b.amount)}`, data: `bill:${b.id}` }]);
  await updateStep(session, "escolher_bill", {}, { flow: "marcar_paga" });
  await ask(session, "Qual conta você pagou?", { replyMarkup: buildInlineKeyboard(buttons) });
}

async function finishMarcarPagaConfirm(session) {
  const bill = await prisma.bill.findUnique({ where: { id: session.data.billId } });
  const summary = [
    "Confirma o pagamento?", "",
    `✅ ${bill.description} — ${formatMoney(bill.amount)}`,
    `🏦 ${session.data.targetLabel}`,
  ].join("\n");
  await updateStep(session, "confirmar", {});
  await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD });
}

async function commitMarcarPaga(session) {
  const { bill, expense } = await markBillPaid(session.data.billId, { accountId: session.data.targetId });
  return `✅ Conta "${bill.description}" marcada como paga: ${formatMoney(expense.amount)}.`;
}

async function startFaturaValor(session, flow) {
  await updateStep(session, "valor", {}, { flow });
  await ask(session, flow === "antecipar_fatura" ? "Antecipar fatura ⏩\n\nQuanto você quer antecipar?" : "Pagar fatura 💳\n\nQuanto você pagou?");
}

async function commitFatura(session) {
  const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
  const data = {
    amount: session.data.amount,
    description: "assistente guiado",
    rawMessage: "assistente guiado",
    target: { type: "card", card },
    billPaymentKind: session.flow === "antecipar_fatura" ? "installment_anticipation" : "card_bill_payment",
  };
  const { reply } = await commitBotIntent("bill_payment", data, { source: "telegram" });
  return reply;
}

// ============================== dispatch ==============================

export async function handleWizardCallback(chatId, callbackData) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return;

  if (session.step === "categoria" && callbackData.startsWith("cat:")) {
    const category = callbackData.slice(4);
    if (session.flow === "nova_conta") {
      await updateStep(session, "descricao", { category });
      await ask(session, `Categoria: ${category}\n\nQual a descrição? (ex: Internet, aluguel...)`);
    } else if (session.flow === "parcela") {
      await finishParcelaConfirm(await updateStep(session, "confirmar", { category }));
    } else {
      await updateStep(session, "alvo", { category });
      await ask(session, `Categoria: ${category}\n\nDe onde sai/entra o dinheiro?`, { replyMarkup: await targetKeyboard() });
    }
    return;
  }

  if (session.step === "alvo" && callbackData.startsWith("tgt:")) {
    const target = await resolveTarget(callbackData);
    const label = target.type === "card" ? `Cartão ${target.card.name}` : target.account.name;
    await updateStep(session, "confirmar", { targetType: target.type, targetId: target.type === "card" ? target.card.id : target.account.id, targetLabel: label });
    await finishGastoReceitaConfirm(session);
    return;
  }

  if (session.step === "parcelas" && callbackData.startsWith("qtd:")) {
    const installmentCount = parseInt(callbackData.slice(4), 10);
    await updateStep(session, "descricao", { installmentCount });
    await ask(session, `${installmentCount}x\n\nQual a descrição da compra?`);
    return;
  }

  if (session.step === "vencimento" && callbackData.startsWith("due:")) {
    const value = callbackData.slice(4);
    if (value === "outra") {
      await updateStep(session, "vencimento_texto", {});
      await ask(session, "Digite a data (ex: \"dia 25\", \"mês que vem\"):");
      return;
    }
    const dueDate = await resolveDate(value);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null });
    await finishNovaContaDate(session);
    return;
  }

  if (session.step === "acao" && callbackData.startsWith("pagmenu:")) {
    const choice = callbackData.slice(8);
    if (choice === "nova") await startNovaConta(session);
    else if (choice === "marcar") await startMarcarPaga(session);
    else if (choice === "fatura") await startFaturaValor(session, "pagar_fatura");
    else if (choice === "antecipar") await startFaturaValor(session, "antecipar_fatura");
    return;
  }

  if (session.step === "escolher_bill" && callbackData.startsWith("bill:")) {
    const billId = callbackData.slice(5);
    await updateStep(session, "conta_origem", { billId });
    await ask(session, "Pago com qual conta?", { replyMarkup: await targetKeyboard() });
    return;
  }

  if (session.step === "conta_origem" && callbackData.startsWith("tgt:")) {
    const target = await resolveTarget(callbackData);
    if (target.type !== "account") {
      await ask(session, "Escolhe uma conta (não um cartão) pra pagar essa conta.", { replyMarkup: await targetKeyboard() });
      return;
    }
    await updateStep(session, "confirmar", { targetType: "account", targetId: target.account.id, targetLabel: target.account.name });
    await finishMarcarPagaConfirm(session);
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:no") {
    await finish(session, "Cancelado.");
    return;
  }

  if (session.step === "confirmar" && callbackData === "confirm:yes") {
    let reply;
    if (session.flow === "nova_conta") reply = await commitNovaConta(session);
    else if (session.flow === "gasto" || session.flow === "receita") reply = await commitGastoReceita(session);
    else if (session.flow === "parcela") reply = await commitParcela(session);
    else if (session.flow === "marcar_paga") reply = await commitMarcarPaga(session);
    else if (session.flow === "pagar_fatura" || session.flow === "antecipar_fatura") reply = await commitFatura(session);
    await finish(session, reply);
    return;
  }
}

export async function handleWizardText(chatId, text) {
  const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
  if (!session) return false;
  const trimmed = text.trim();

  if (session.flow === "nova_conta" && session.step === "descricao") {
    await updateStep(session, "valor", { description: trimmed });
    await ask(session, `Descrição: ${trimmed}\n\nQuanto é?`);
    return true;
  }
  if (session.flow === "nova_conta" && session.step === "vencimento_texto") {
    const dueDate = await resolveDate(trimmed);
    await updateStep(session, session.step, { pendingDate: dueDate ? dueDate.toISOString() : null });
    await finishNovaContaDate(session);
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
      await updateStep(session, "vencimento", { amount });
      await ask(session, `Valor: ${formatMoney(amount)}\n\nVence quando?`, { replyMarkup: keyboard });
    } else if (session.flow === "gasto" || session.flow === "receita") {
      const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
      await updateStep(session, "categoria", { amount });
      await ask(session, `Valor: ${formatMoney(amount)}\n\nQue categoria?`, { replyMarkup: keyboard });
    } else if (session.flow === "parcela") {
      const keyboard = buildInlineKeyboard(chunk(QUICK_INSTALLMENT_COUNTS.map((n) => ({ text: `${n}x`, data: `qtd:${n}` })), 3));
      await updateStep(session, "parcelas", { amount });
      await ask(session, `Valor total: ${formatMoney(amount)}\n\nEm quantas vezes?`, { replyMarkup: keyboard });
    } else if (session.flow === "pagar_fatura" || session.flow === "antecipar_fatura") {
      await updateStep(session, "confirmar", { amount });
      const summary = [
        "Confirma?", "",
        `${session.flow === "antecipar_fatura" ? "⏩ Antecipação" : "💳 Pagamento de fatura"}: ${formatMoney(amount)}`,
      ].join("\n");
      await ask(session, summary, { replyMarkup: CONFIRM_KEYBOARD });
    }
    return true;
  }

  if (session.flow === "parcela" && session.step === "descricao") {
    const keyboard = buildInlineKeyboard(chunk(CATEGORIES.map((c) => ({ text: c, data: `cat:${c}` })), 2));
    await updateStep(session, "categoria", { description: trimmed });
    await ask(session, `Descrição: ${trimmed}\n\nQue categoria?`, { replyMarkup: keyboard });
    return true;
  }

  // dentro do assistente, num passo que só aceita botão — avisa em vez de ignorar quieto
  await sendMessage(session.chatId, "Usa os botões aí em cima 👆 (ou manda /cancelar pra desistir).");
  return true;
}
