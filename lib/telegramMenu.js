// ============================================================================
// Fase 7D — Telegram determinístico / menu-driven. Este arquivo é a UI de
// NAVEGAÇÃO (menu raiz + submenus + leituras canônicas A-L + projeção +
// simulador/correção "stateless") — tudo aqui é ZERO WRITE ou dispara um
// wizard determinístico (lib/botWizard.js) pra qualquer coisa que precise de
// múltiplos passos ou escreva no banco. Nenhuma chamada a Groq/Anthropic em
// lugar nenhum deste arquivo — a UI inteira funciona 100% offline de LLM
// (item 36 do pedido).
//
// Convenção de callback_data (item 33 — curta, allowlisted, nunca payload
// financeiro arbitrário, nunca um model/id cru sem resolução server-side):
//   m:<key>        navega pra um (sub)menu
//   w:<flow>       inicia um wizard determinístico (lib/botWizard.js)
//   r:<key>        roda uma leitura canônica (zero write) e responde
//   cor:list       lista últimos lançamentos elegíveis pra correção
//   cor:pick:<model>:<id>     mostra o menu de ações pra ESSE lançamento
//   cor:f:<model>:<id>:<field> inicia a edição determinística desse campo
//   cor:delask:<model>:<id>   pede confirmação de exclusão
//   cor:delyes:<model>:<id>   executa a exclusão (via correctionService)
//   cor:delno                cancela a exclusão
// ============================================================================
import { prisma } from "./prisma.js";
import { runGuarded, friendlyErrorMessage } from "./txGuard.js";
import { buildInlineKeyboard, chunk } from "./telegramApi.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { serializeMoney } from "./money.js";
import { handleReadIntent } from "./telegramReads.js";
import { computeCategoryBreakdown } from "./categoryBreakdown.js";
import { formatCategoryBreakdownReply } from "./telegramAi/responseFormatter.js";
import { buildExpectedProjection } from "./financialProjection.js";
import { listPurchasesWithProgress } from "./installments.js";
import { applyGuardedDelete, StaleRecordError, RecordNotFoundError, undoAudit } from "./telegramAi/correctionService.js";
import { startWizard, startCorrectionFieldEdit, isStartableFlow } from "./botWizard.js";

// ----------------------------------------------------------------------------
// Menu raiz + submenus (item 3, item 39 — mensagens curtas, sem enum técnico).
// ----------------------------------------------------------------------------
export function rootMenuKeyboard() {
  return buildInlineKeyboard([
    [{ text: "📝 Registrar", data: "m:registrar" }, { text: "💳 Cartão", data: "m:cartao" }],
    [{ text: "💰 Saldos e reconciliação", data: "m:saldos" }],
    [{ text: "📊 Consultar", data: "m:consultar" }, { text: "🧮 Simular", data: "w:simulador" }],
    [{ text: "📌 Planejamento", data: "m:planejamento" }, { text: "↩️ Corrigir/desfazer", data: "m:corrigir" }],
    [{ text: "❓ Ajuda", data: "m:ajuda" }],
  ]);
}

export const ROOT_MENU_TEXT = "🏠 Norte\n\nO que você quer fazer?";

function backRow(target = "m:root") {
  return [{ text: "⬅️ Voltar", data: target }, { text: "🏠 Menu", data: "m:root" }];
}

const MENUS = {
  root: () => ({ text: ROOT_MENU_TEXT, keyboard: rootMenuKeyboard() }),

  registrar: () => ({
    text: "📝 Registrar\n\nO que você quer lançar?",
    keyboard: buildInlineKeyboard([
      [{ text: "🧾 Despesa", data: "w:gasto" }, { text: "💰 Receita", data: "w:receita" }],
      [{ text: "📚 Vários lançamentos", data: "w:multipla" }],
      [{ text: "🔄 Transferência", data: "w:transferencia" }],
      [{ text: "💳 Compra no cartão", data: "w:cartao_compra" }, { text: "🧩 Compra parcelada", data: "w:parcela" }],
      [{ text: "📥 Valor a receber", data: "w:recebivel" }, { text: "📌 Compromisso", data: "w:compromisso" }],
      [{ text: "⚠️ Contingência", data: "w:contingencia" }],
      backRow(),
    ]),
  }),

  cartao: () => ({
    text: "💳 Cartão",
    keyboard: buildInlineKeyboard([
      [{ text: "💳 Compra no cartão", data: "w:cartao_compra" }, { text: "🧩 Compra parcelada", data: "w:parcela" }],
      [{ text: "🧾 Informar fatura atual", data: "w:fatura_atual" }],
      [{ text: "✅ Pagar fatura", data: "w:fatura_pagar" }],
      [{ text: "📆 Próximas faturas", data: "r:proximas_faturas" }],
      [{ text: "📉 Parcelas ativas", data: "r:parcelas_ativas" }],
      backRow(),
    ]),
  }),

  saldos: () => ({
    text: "💰 Saldos e reconciliação",
    keyboard: buildInlineKeyboard([
      [{ text: "🏦 Informar saldo Itaú", data: "w:saldo_itau" }],
      [{ text: "🥗 Informar saldo VA", data: "w:saldo_va" }],
      [{ text: "💳 Informar fatura atual", data: "w:fatura_atual" }],
      [{ text: "🔎 Conferir diferenças", data: "r:diferencas" }],
      backRow(),
    ]),
  }),

  consultar: () => ({
    text: "📊 Consultar\n\nEssas são as perguntas do Norte — clica na que quiser saber:",
    keyboard: buildInlineKeyboard([
      [{ text: "💰 Como eu tô?", data: "r:summary" }],
      [{ text: "💵 Quanto tenho de verdade?", data: "r:balance" }],
      [{ text: "💳 Quanto está comprometido?", data: "r:committed" }],
      [{ text: "💸 Quanto está livre?", data: "r:free" }, { text: "🛟 Seguro pra gastar?", data: "r:safe" }],
      [{ text: "📊 Onde foi meu dinheiro?", data: "m:onde_foi" }],
      [{ text: "📅 O que vence antes da renda?", data: "r:nextincome" }],
      [{ text: "💼 Quanto do salário já comprometi?", data: "r:nextincome" }],
      [{ text: "📉 Quando as parcelas aliviam?", data: "r:installment_relief" }],
      [{ text: "🔮 Projeção 30/60/90", data: "r:projection" }],
      [{ text: "🧮 Posso comprar X?", data: "w:simulador" }],
      [{ text: "🥗 Quanto tenho de VA?", data: "r:va" }],
      backRow(),
    ]),
  }),

  onde_foi: () => ({
    text: "📊 Onde foi meu dinheiro?\n\nQual período?",
    keyboard: buildInlineKeyboard([
      [{ text: "Este mês", data: "r:cat:mes" }, { text: "Mês passado", data: "r:cat:mespassado" }],
      [{ text: "Período personalizado", data: "w:categoria_periodo" }],
      backRow("m:consultar"),
    ]),
  }),

  planejamento: () => ({
    text: "📌 Planejamento",
    keyboard: buildInlineKeyboard([
      [{ text: "📌 Compromissos", data: "m:compromissos" }],
      [{ text: "⚠️ Contingências", data: "m:contingencias" }],
      [{ text: "📥 Valores a receber", data: "m:recebiveis" }],
      [{ text: "🎯 Metas", data: "m:metas" }],
      backRow(),
    ]),
  }),

  compromissos: () => ({
    text: "📌 Compromissos",
    keyboard: buildInlineKeyboard([
      [{ text: "➕ Novo compromisso", data: "w:compromisso" }],
      [{ text: "📋 Ver ativos", data: "r:compromissos_ativos" }],
      [{ text: "✅ Marcar como pago/resolvido", data: "w:compromisso_pagar" }],
      [{ text: "✏️ Editar", data: "w:compromisso_editar" }],
      backRow("m:planejamento"),
    ]),
  }),

  contingencias: () => ({
    text: "⚠️ Contingências",
    keyboard: buildInlineKeyboard([
      [{ text: "➕ Nova contingência", data: "w:contingencia" }],
      [{ text: "📋 Ver abertas", data: "r:contingencias_abertas" }],
      [{ text: "✏️ Atualizar contingência", data: "w:contingencia_editar" }],
      [{ text: "✅ Resolver contingência", data: "w:contingencia_resolver" }],
      backRow("m:planejamento"),
    ]),
  }),

  recebiveis: () => ({
    text: "📥 Valores a receber",
    keyboard: buildInlineKeyboard([
      [{ text: "➕ Novo valor a receber", data: "w:recebivel" }],
      [{ text: "📋 Ver pendentes", data: "r:recebiveis_pendentes" }],
      [{ text: "✅ Marcar recebido", data: "w:recebivel_receber" }],
      [{ text: "✏️ Editar", data: "w:recebivel_editar" }],
      backRow("m:planejamento"),
    ]),
  }),

  metas: () => ({
    text: "🎯 Metas",
    keyboard: buildInlineKeyboard([
      [{ text: "📋 Ver metas", data: "r:metas" }],
      [{ text: "➕ Nova meta", data: "w:meta_nova" }],
      [{ text: "✏️ Editar meta", data: "w:meta_editar" }],
      backRow("m:planejamento"),
    ]),
  }),

  corrigir: () => ({
    text: "↩️ Corrigir / desfazer",
    keyboard: buildInlineKeyboard([
      [{ text: "🕘 Últimos lançamentos", data: "cor:recentes" }],
      [{ text: "↩️ Desfazer último", data: "cor:undolast" }],
      [{ text: "✏️ Corrigir lançamento", data: "cor:list" }],
      [{ text: "🗑 Excluir lançamento", data: "cor:list" }],
      backRow(),
    ]),
  }),

  ajuda: () => ({
    text: "❓ Ajuda\n\nEscolhe um tópico:",
    keyboard: buildInlineKeyboard([
      [{ text: "🧾 Despesa", data: "h:despesa" }, { text: "💰 Receita", data: "h:receita" }],
      [{ text: "💳 Cartão", data: "h:cartao" }, { text: "🧩 Parcelado", data: "h:parcelado" }],
      [{ text: "📚 Vários lançamentos", data: "h:varios" }, { text: "🔄 Transferir", data: "h:transferir" }],
      [{ text: "💵 Reconciliar saldo", data: "h:saldo" }, { text: "🧾 Informar fatura", data: "h:fatura" }],
      [{ text: "📌 Compromissos", data: "h:compromissos" }, { text: "🧮 Simular", data: "h:simular" }],
      [{ text: "📊 Consultar", data: "h:consultar" }, { text: "↩️ Corrigir/desfazer", data: "h:corrigir" }],
      [{ text: "⌨️ Ver atalhos", data: "h:atalhos" }],
      backRow(),
    ]),
  }),
};

// Tópicos da Ajuda (item 27) — texto estático, sem lógica financeira.
const HELP_TOPICS = {
  despesa: "🧾 Como registrar despesa\n\nMenu 📝 Registrar → 🧾 Despesa. O Norte pergunta: valor, descrição, como pagou (Pix/Itaú, Cartão, VA ou Dinheiro), categoria e data. No fim mostra um preview — confirma, edita um campo ou cancela.",
  receita: "💰 Como registrar receita\n\nMenu 📝 Registrar → 💰 Receita: valor, origem, conta onde entrou, categoria e data, com preview antes de salvar.",
  cartao: "💳 Como registrar compra no cartão\n\nMenu 💳 Cartão (ou 📝 Registrar) → 💳 Compra no cartão: valor, descrição, cartão, categoria e data. Entra como compra do cartão, nunca como gasto da conta corrente.",
  parcelado: "🧩 Como registrar parcelado\n\nMenu 💳 Cartão → 🧩 Compra parcelada: valor TOTAL, descrição, loja (opcional), quantidade de parcelas, cartão e data. O Norte divide as parcelas sozinho e mostra 'Nx de R$ …' no preview.",
  varios: "📚 Como registrar vários\n\nMenu 📝 Registrar → 📚 Vários lançamentos: adiciona despesa, receita, cartão, parcelado ou transferência item por item, revisa a lista e salva tudo de uma vez — se um item falhar, nada é salvo.",
  transferir: "🔄 Como transferir\n\nMenu 📝 Registrar → 🔄 Transferência: valor, conta de origem, conta de destino (obrigatórias e diferentes), descrição opcional e data.",
  saldo: "💵 Como reconciliar saldo\n\nMenu 💰 Saldos → 🏦 Informar saldo Itaú (ou 🥗 VA): você digita o saldo que vê no app do banco, o Norte mostra o calculado e a diferença. Confirmar cria um ajuste — nunca uma receita.",
  fatura: "🧾 Como informar fatura\n\nMenu 💳 Cartão → 🧾 Informar fatura atual: você digita o valor da fatura no app do banco; o Norte compara com o calculado e registra a reconciliação — nunca uma despesa. Pra pagar: ✅ Pagar fatura.",
  compromissos: "📌 Como usar compromissos\n\nMenu 📌 Planejamento → 📌 Compromissos: cria, lista, edita e marca como pago (aí sim vira uma despesa real). Contingências, valores a receber e metas ficam no mesmo menu.",
  simular: "🧮 Como simular\n\nMenu 🧮 Simular: valor, à vista ou parcelado (e como pagaria). O Norte mostra o impacto no livre e no seguro-pra-gastar sem gravar nada — e tem o botão 🧾 Registrar essa compra.",
  consultar: "📊 Como consultar\n\nMenu 📊 Consultar: perguntas prontas (como eu tô, quanto está livre, o que vence antes da renda, projeção 30/60/90, onde foi meu dinheiro…). Só leitura, nada é alterado.",
  corrigir: "↩️ Como corrigir/desfazer\n\nMenu ↩️ Corrigir/desfazer: veja os últimos lançamentos, corrija valor/descrição/categoria/data, exclua ou desfaça a última correção/exclusão.",
  atalhos: [
    "⌨️ Atalhos (opcionais)",
    "",
    "/menu /despesa /receita /parcelado /multipla /transferencia /saldo /fatura /simular /consultar /ajuda /cancelar",
    "",
    "Palavras soltas também abrem o mesmo wizard/menu: despesa, gasto, receita, recebi, parcelado, parcela, multipla, varios, transferencia, transf, saldo, fatura, simular, ajuda.",
    "",
    "Atalhos SÓ abrem o menu/wizard — nunca interpretam valores da frase.",
  ].join("\n"),
};

export const HELP_TOPIC_KEYS = Object.freeze(Object.keys(HELP_TOPICS));

export function renderHelpTopic(key) {
  const text = HELP_TOPICS[key];
  if (!text) return MENUS.ajuda();
  return { text, keyboard: buildInlineKeyboard([[{ text: "⬅️ Tópicos", data: "m:ajuda" }, { text: "🏠 Menu", data: "m:root" }]]) };
}

export const MENU_KEYS = Object.freeze(Object.keys(MENUS));

export function renderMenu(key) {
  const factory = MENUS[key];
  if (!factory) return MENUS.root();
  return factory();
}

// ----------------------------------------------------------------------------
// Correção/desfazer — lista de últimos lançamentos elegíveis (item 26).
// Zero-write; escolher um item leva pro menu de ações (também aqui).
// ----------------------------------------------------------------------------
const CORRECTION_LIST_LIMIT = 8;
// Modelos que o correctionService (Fase 7.0.1) sabe corrigir/excluir de
// verdade (SUPPORTED_CORRECTION_MODELS, escopo deliberadamente restrito).
const CORRECTABLE_MODELS = [
  { model: "expense", label: "Despesa", client: (c) => c.expense },
  { model: "income", label: "Receita", client: (c) => c.income },
  { model: "transfer", label: "Transferência", client: (c) => c.transfer },
];
// Fase 7D.1 — outros tipos de lançamento recente que fazem sentido aparecer
// em "últimos lançamentos" (visibilidade), mas que o correctionService NÃO
// cobre ainda — escolher um destes precisa recusar de forma clara (fail
// closed, item 26: "se model não suportado, fail closed e explicar"), nunca
// silenciosamente sumir da lista nem cair num update/delete cru.
const UNSUPPORTED_RECENT_MODELS = [
  { model: "purchase", label: "Compra parcelada", client: (c) => c.purchase, describe: (r) => `${formatMoney(serializeMoney(r.totalAmount))} · ${r.description}` },
  { model: "balanceAdjustment", label: "Ajuste de saldo", client: (c) => c.balanceAdjustment, describe: (r) => `${formatMoney(serializeMoney(r.newBalance))}` },
];

async function loadRecentRecords(client = prisma, { includeUnsupported = false } = {}) {
  const lists = await Promise.all(
    CORRECTABLE_MODELS.map(async ({ model, label, client: pick }) => {
      const rows = await pick(client).findMany({ orderBy: { createdAt: "desc" }, take: CORRECTION_LIST_LIMIT });
      return rows.map((r) => ({ model, label, row: r, supported: true }));
    })
  );
  const unsupportedLists = includeUnsupported
    ? await Promise.all(
        UNSUPPORTED_RECENT_MODELS.map(async ({ model, label, client: pick, describe }) => {
          const rows = await pick(client).findMany({ orderBy: { createdAt: "desc" }, take: CORRECTION_LIST_LIMIT });
          return rows.map((r) => ({ model, label, row: r, supported: false, describe }));
        })
      )
    : [];
  return [...lists.flat(), ...unsupportedLists.flat()]
    .sort((a, b) => new Date(b.row.createdAt) - new Date(a.row.createdAt))
    .slice(0, CORRECTION_LIST_LIMIT);
}

function describeRecord(model, row) {
  if (model === "transfer") return `${formatMoney(serializeMoney(row.amount))} · ${row.description || "transferência"}`;
  return `${formatMoney(serializeMoney(row.amount))} · ${row.description || row.category || model}`;
}

// "🕘 Últimos lançamentos" — visão pura de leitura (item 26), sem nenhum
// botão de ação por item (só navegação) — distinta de propósito da lista
// interativa de Corrigir/Excluir abaixo.
export async function buildRecentActivityView(client = prisma) {
  const records = await loadRecentRecords(client, { includeUnsupported: true });
  if (records.length === 0) {
    return { text: "🕘 Últimos lançamentos\n\nNenhum lançamento recente ainda.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  }
  const lines = records.map(({ model, label, row, supported, describe }) => `• ${label} · ${supported ? describeRecord(model, row) : describe(row)} · ${formatDate(row.occurredAt || row.createdAt)}`);
  return { text: ["🕘 Últimos lançamentos", "", ...lines].join("\n"), keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
}

export async function buildCorrectionListMenu(client = prisma) {
  const records = await loadRecentRecords(client, { includeUnsupported: true });
  if (records.length === 0) {
    return { text: "↩️ Corrigir / desfazer\n\nNenhum lançamento recente ainda.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  }
  const rows = records.map(({ model, label, row, supported, describe }) => [
    { text: `${label} · ${supported ? describeRecord(model, row) : describe(row)}`, data: supported ? `cor:pick:${model}:${row.id}` : `cor:unsupported:${model}:${row.id}` },
  ]);
  rows.push(backRow("m:corrigir"));
  return { text: "↩️ Corrigir / desfazer\n\nEscolhe o lançamento:", keyboard: buildInlineKeyboard(rows) };
}

// Item 26/38-H — "item não suportado: fail closed e explicar", nunca um
// Prisma update/delete cru pra um model fora de SUPPORTED_CORRECTION_MODELS.
export function buildUnsupportedRecordMenu(model) {
  const label = UNSUPPORTED_RECENT_MODELS.find((m) => m.model === model)?.label || model;
  return {
    text: `"${label}" ainda não pode ser corrigido/excluído por aqui — edita pelo site (dashboard) por enquanto.`,
    keyboard: buildInlineKeyboard([backRow("m:corrigir")]),
  };
}

export async function buildRecordActionMenu(model, id, client = prisma) {
  const table = CORRECTABLE_MODELS.find((m) => m.model === model);
  if (!table) return buildUnsupportedRecordMenu(model);
  const row = await table.client(client).findUnique({ where: { id } });
  if (!row) return { text: "Não achei mais esse lançamento (pode já ter sido excluído/corrigido).", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  const text = [`${table.label}`, describeRecord(model, row), formatDate(row.occurredAt || row.createdAt)].join("\n");
  const keyboard = buildInlineKeyboard([
    [
      { text: "💰 Valor", data: `cor:f:${model}:${id}:amount` },
      { text: "📝 Descrição", data: `cor:f:${model}:${id}:description` },
    ],
    [
      { text: "🏷 Categoria", data: `cor:f:${model}:${id}:category` },
      { text: "📅 Data", data: `cor:f:${model}:${id}:date` },
    ],
    [{ text: "🗑 Excluir", data: `cor:delask:${model}:${id}` }],
    backRow("m:corrigir"),
  ]);
  return { text, keyboard };
}

export function buildDeleteConfirmMenu(model, id) {
  return {
    text: "Tem certeza que quer excluir esse lançamento? (dá pra desfazer logo em seguida, se precisar)",
    keyboard: buildInlineKeyboard([[{ text: "✅ Confirmar exclusão", data: `cor:delyes:${model}:${id}` }, { text: "❌ Cancelar", data: "cor:delno" }]]),
  };
}

// Retorna {text, keyboard} — o caller decide como mandar (keyboard sempre
// oferece "↩️ Desfazer" quando a exclusão de fato aconteceu, item 26/38-E).
export async function performDelete(model, id, { chatId, client }) {
  try {
    const table = CORRECTABLE_MODELS.find((m) => m.model === model);
    const current = table ? await table.client(client).findUnique({ where: { id } }) : null;
    const guarded = await runGuarded(client, () => applyGuardedDelete({ model, id, expectedUpdatedAt: current?.updatedAt?.toISOString(), chatId: String(chatId) }, { client }));
    if (!guarded.ok) throw guarded.error;
    const { auditId } = guarded.value;
    return { text: "✅ Excluído.", keyboard: buildInlineKeyboard([[{ text: "↩️ Desfazer", data: `cor:undoyes:${auditId}` }], backRow("m:corrigir")]) };
  } catch (err) {
    if (err instanceof StaleRecordError) return { text: "⚠️ Esse lançamento mudou desde que eu mostrei ele — abre a lista de novo pra conferir antes de excluir.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
    if (err instanceof RecordNotFoundError) return { text: "⚠️ Não achei mais esse lançamento (já foi excluído?).", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
    return { text: "⚠️ Não consegui excluir esse lançamento por aqui ainda.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  }
}

// ----------------------------------------------------------------------------
// "↩️ Desfazer último" (item 26) — acha a operação auditável mais recente
// (correct OU delete) que ainda não foi desfeita, EM QUALQUER model
// suportado, e mostra preview antes de agir (nunca desfaz direto sem
// confirmar). Sempre revalida contra o banco na hora de confirmar (nunca
// confia num auditId "guardado" de uma renderização antiga sem checar de
// novo — undoAudit já faz isso, mas o preview aqui é só leitura).
// ----------------------------------------------------------------------------
export async function findMostRecentUndoableAudit(client = prisma) {
  const candidates = await client.telegramCorrectionAudit.findMany({
    where: { action: { in: ["correct", "delete"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const undoneIds = new Set((await client.telegramCorrectionAudit.findMany({ where: { undoesAuditId: { not: null } }, select: { undoesAuditId: true } })).map((r) => r.undoesAuditId));
  return candidates.find((a) => !undoneIds.has(a.id)) || null;
}

// Nota: `audit.preimage` já passou por serializeRecord() (Decimal->string,
// Date->ISO string) — NUNCA reusar describeFieldChanges() aqui (ela espera
// um record AO VIVO do Prisma, com occurredAt como Date real; chamaria
// .toISOString() numa string e quebraria). Formatador dedicado, seguro pro
// formato já serializado.
function describeAuditForUndo(audit) {
  const label = { expense: "Despesa", income: "Receita", transfer: "Transferência" }[audit.model] || audit.model;
  if (audit.action === "delete") return `Desfazer EXCLUSÃO de: ${label} · ${describeRecord(audit.model, audit.preimage)}`;
  const fc = audit.fieldChanges || {};
  const lines = [];
  if (fc.amount != null) lines.push(`  valor: ${formatMoney(Number(fc.amount))} -> ${formatMoney(Number(audit.preimage.amount))}`);
  if (fc.description != null) lines.push(`  descrição: "${fc.description}" -> "${audit.preimage.description}"`);
  if (fc.category != null) lines.push(`  categoria: ${fc.category} -> ${audit.preimage.category}`);
  if (fc.date != null) lines.push(`  data: ${fc.date} -> ${String(audit.preimage.occurredAt).slice(0, 10)}`);
  return `Desfazer CORREÇÃO em: ${label} · ${describeRecord(audit.model, audit.preimage)}\n${lines.join("\n")}`;
}

export async function buildUndoLastMenu(client = prisma) {
  const audit = await findMostRecentUndoableAudit(client);
  if (!audit) return { text: "↩️ Desfazer último\n\nNão há nenhuma correção/exclusão recente pra desfazer.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  return {
    text: describeAuditForUndo(audit),
    keyboard: buildInlineKeyboard([[{ text: "✅ Desfazer", data: `cor:undoyes:${audit.id}` }, { text: "❌ Cancelar", data: "cor:undono" }], backRow("m:corrigir")]),
  };
}

export async function performUndo(auditId, { chatId, client }) {
  try {
    const guarded = await runGuarded(client, () => undoAudit(auditId, { chatId: String(chatId) }, { client }));
    if (!guarded.ok) throw guarded.error;
    const result = guarded.value;
    return { text: result.kind === "undo_delete" ? "✅ Exclusão desfeita — o lançamento voltou." : "✅ Correção desfeita — valores originais restaurados.", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  } catch (err) {
    if (err instanceof RecordNotFoundError) return { text: "⚠️ Não achei mais essa operação pra desfazer (pode já ter sido desfeita).", keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
    return { text: `⚠️ Não consegui desfazer isso (${friendlyErrorMessage(err)}).`, keyboard: buildInlineKeyboard([backRow("m:corrigir")]) };
  }
}

// ----------------------------------------------------------------------------
// Consultar — A a L (item 23), sempre ZERO WRITE, sempre via read services
// já existentes (nunca uma fórmula nova). Mapeamento pras 7 leituras
// canônicas já existentes (lib/telegramReads.js) + 3 novas montadas aqui em
// cima de engines já existentes (categoria/projeção/parcelas).
// ----------------------------------------------------------------------------
export async function runCanonicalRead(key) {
  switch (key) {
    case "summary":
      return handleReadIntent("read_summary"); // A — como eu tô
    case "balance":
      return handleReadIntent("read_balance"); // B — quanto tenho de verdade
    case "committed":
    case "free":
    case "safe":
      return handleReadIntent("read_free_money"); // C/D/E — comprometido/livre/seguro (mesma fonte, mesmo texto)
    case "nextincome":
      return handleReadIntent("read_next_income"); // G/H — o que vence antes da renda / % comprometido
    case "va":
      return handleReadIntent("read_va"); // L — VA
    case "installment_relief":
      return readInstallmentRelief(); // I — quando as parcelas aliviam
    case "projection":
      return readProjection30_60_90(); // J — projeção 30/60/90
    case "cat:mes":
      return formatCategoryBreakdownReply(await computeCategoryBreakdown("current_month"));
    case "cat:mespassado":
      return formatCategoryBreakdownReply(await computeCategoryBreakdown("last_month"));
    case "proximas_faturas":
      return readProximasFaturas();
    case "parcelas_ativas":
      return readParcelasAtivas();
    case "diferencas":
      return readDiferencas();
    case "compromissos_ativos":
      return readCompromissosAtivos();
    case "contingencias_abertas":
      return readContingenciasAbertas();
    case "recebiveis_pendentes":
      return readRecebiveisPendentes();
    case "metas":
      return readMetas();
    default:
      return "Ainda não sei responder isso por aqui.";
  }
}

async function readInstallmentRelief() {
  const purchases = (await listPurchasesWithProgress()).filter((p) => p.remainingInstallments > 0);
  if (purchases.length === 0) return "📉 Você não tem nenhuma parcela ativa agora — já está tudo aliviado.";
  const maxRemaining = Math.max(...purchases.map((p) => p.remainingInstallments));
  const finishing = purchases.filter((p) => p.remainingInstallments === maxRemaining);
  const lines = purchases
    .sort((a, b) => a.remainingInstallments - b.remainingInstallments)
    .map((p) => `• ${p.description} — parcela ${p.currentInstallmentNumber}/${p.installmentCount} (faltam ${p.remainingInstallments})`);
  return [
    "📉 Parcelas ativas, da que alivia mais cedo pra mais tarde:",
    ...lines,
    "",
    `A carga mais pesada de parcelas some em ~${maxRemaining} ${maxRemaining === 1 ? "mês" : "meses"} (${finishing.map((p) => p.description).join(", ")}).`,
  ].join("\n");
}

async function readProjection30_60_90() {
  const projection = await buildExpectedProjection({ horizonDays: 90 });
  const line = (cp, label) => `${label}: ${formatMoney(serializeMoney(cp.projectedAvailableAfterProtected))} disponível em ${formatDate(cp.date)}`;
  return ["🔮 Projeção (cenário esperado, já descontando o protegido):", "", line(projection.checkpoints.day30, "30 dias"), line(projection.checkpoints.day60, "60 dias"), line(projection.checkpoints.day90, "90 dias")].join("\n");
}

async function readProximasFaturas() {
  const { listCardsWithLimits } = await import("./cards.js");
  const { listCardBillsView } = await import("./cardBillCalculator.js");
  const cards = await listCardsWithLimits();
  if (cards.length === 0) return "📆 Você ainda não tem nenhum cartão cadastrado.";
  const blocks = await Promise.all(
    cards.map(async (card) => {
      const bills = (await listCardBillsView(card.id, { monthsBack: 0, monthsForward: 3 })).slice(0, 4);
      const lines = bills.map((b) => `  ${b.cycleMonth}: ${formatMoney(serializeMoney(b.totalAmount))}${b.dueAt ? ` · vence ${formatDate(b.dueAt)}` : ""}`);
      return [`💳 ${card.name}`, ...lines].join("\n");
    })
  );
  return ["📆 Próximas faturas:", "", ...blocks].join("\n\n");
}

async function readParcelasAtivas() {
  const purchases = (await listPurchasesWithProgress()).filter((p) => p.remainingInstallments > 0);
  if (purchases.length === 0) return "📉 Nenhuma compra parcelada ativa agora.";
  const lines = purchases.map((p) => `• ${p.description} (${p.card?.name || "cartão"}) — ${p.currentInstallmentNumber}/${p.installmentCount} · ${formatMoney(serializeMoney(p.installmentValue))}/mês · faltam ${p.remainingInstallments}`);
  return ["📉 Parcelas ativas:", "", ...lines].join("\n");
}

async function readDiferencas() {
  const { previewBalanceReconciliation } = await import("./balanceReconciliation.js");
  const { previewCardBillReconciliation } = await import("./cardBillReconciliation.js");
  const accounts = await prisma.account.findMany({ where: { type: { in: ["checking", "food_voucher"] } } });
  const lastAdjustments = await Promise.all(
    accounts.map(async (a) => {
      const last = await prisma.balanceAdjustment.findFirst({ where: { accountId: a.id }, orderBy: { createdAt: "desc" } });
      if (!last) return `${a.name}: sem observação recente registrada.`;
      const preview = await previewBalanceReconciliation(a.id, serializeMoney(last.newBalance));
      return `${a.name}: calculado ${formatMoney(serializeMoney(preview.calculated))} × observado ${formatMoney(serializeMoney(preview.observed))} (diferença ${formatMoney(serializeMoney(preview.delta))})`;
    })
  );
  const cards = await prisma.card.findMany();
  const cardLines = await Promise.all(
    cards.map(async (card) => {
      const last = await prisma.cardBillReconciliation.findFirst({ where: { cardId: card.id }, orderBy: { createdAt: "desc" } });
      if (!last) return `${card.name}: sem observação de fatura recente.`;
      const preview = await previewCardBillReconciliation(card.id, serializeMoney(last.observedTotal));
      return `${card.name}: calculado ${formatMoney(serializeMoney(preview.calculated))} × observado ${formatMoney(serializeMoney(preview.observed))} (diferença ${formatMoney(serializeMoney(preview.delta))})`;
    })
  );
  return ["🔎 Diferenças (calculado × última observação):", "", ...lastAdjustments, ...cardLines].join("\n");
}

async function readCompromissosAtivos() {
  const { listCommitments } = await import("./commitments.js");
  const rows = await listCommitments({ status: undefined });
  const active = rows.filter((r) => r.status !== "SETTLED" && r.status !== "CANCELLED");
  if (active.length === 0) return "📌 Nenhum compromisso ativo agora.";
  return ["📌 Compromissos ativos:", "", ...active.map((r) => `• ${r.description} — ${formatMoney(serializeMoney(r.amount))} · ${r.dueDate ? `vence ${formatDate(r.dueDate)}` : "sem prazo definido"} · ${r.status}`)].join("\n");
}

async function readContingenciasAbertas() {
  const { listContingencies } = await import("./contingencies.js");
  const rows = await listContingencies({ status: undefined });
  const open = rows.filter((r) => r.status === "AWAITING_INFORMATION" || r.status === "CONFIRMED");
  if (open.length === 0) return "⚠️ Nenhuma contingência aberta agora.";
  return ["⚠️ Contingências abertas:", "", ...open.map((r) => `• ${r.description} — até ${formatMoney(serializeMoney(r.maxAmount))} · ${r.status}`)].join("\n");
}

async function readRecebiveisPendentes() {
  const { listReceivables } = await import("./receivables.js");
  const rows = await listReceivables({ status: "PENDING" });
  if (rows.length === 0) return "📥 Nenhum valor a receber pendente agora.";
  return ["📥 Valores a receber pendentes:", "", ...rows.map((r) => `• ${formatMoney(serializeMoney(r.amount))} de ${r.counterparty}${r.expectedDate ? ` · esperado ${formatDate(r.expectedDate)}` : ""}`)].join("\n");
}

async function readMetas() {
  const { listGoals } = await import("./goals.js");
  const goals = await listGoals();
  if (goals.length === 0) return "🎯 Nenhuma meta cadastrada ainda.";
  return ["🎯 Metas:", "", ...goals.map((g) => `• ${g.name}: ${formatMoney(serializeMoney(g.savedAmount))} de ${formatMoney(serializeMoney(g.targetAmount))}`)].join("\n");
}

// ----------------------------------------------------------------------------
// Router de callback de MENU (item 2/33) — nunca confunde com callbacks de
// WIZARD (lib/botWizard.js): só reconhece os prefixos m:/w:/r:/cor:; qualquer
// outro `data` devolve `null` pro caller tentar handleWizardCallback em
// seguida.
// ----------------------------------------------------------------------------
export async function handleMenuCallback(chatId, data, { client = prisma, messageId, outbox } = {}) {
  // Item 25/35 — respostas de callback de MENU (leitura/navegação, nunca
  // efeito financeiro) seguem a MESMA disciplina de outbox do resto do
  // pipeline (lib/telegramUpdateHandler.js): NUNCA chamam a API do Telegram
  // direto daqui dentro (que rodaria dentro da transação Prisma em
  // produção) — só enfileiram, o caller envia depois do commit.
  const reply = async (text, keyboard) => {
    if (outbox) {
      if (messageId) outbox.push({ type: "editMessageText", args: [chatId, messageId, text, { replyMarkup: keyboard }] });
      else outbox.push({ type: "sendMessage", args: [chatId, text, { replyMarkup: keyboard }] });
      return;
    }
    // Fallback só pra chamadores que ainda não passam outbox (nenhum no
    // pipeline real hoje) — nunca usado em produção, existe só pra este
    // helper não quebrar se chamado isoladamente (ex.: script manual).
    const { sendMessage, editMessageText } = await import("./telegramApi.js");
    if (messageId) return editMessageText(chatId, messageId, text, { replyMarkup: keyboard });
    return sendMessage(chatId, text, { replyMarkup: keyboard });
  };

  if (data.startsWith("m:")) {
    const key = data.slice(2);
    const { text, keyboard } = renderMenu(key);
    await reply(text, keyboard);
    return true;
  }

  if (data.startsWith("h:")) {
    const { text, keyboard } = renderHelpTopic(data.slice(2));
    await reply(text, keyboard);
    return true;
  }

  if (data.startsWith("w:")) {
    const flow = data.slice(2);
    // Fail closed: flow desconhecido nunca chega em startWizard (que lança e
    // abortaria a transação do update inteiro).
    if (!isStartableFlow(flow)) {
      await reply("Essa opção não existe mais. Abre o menu de novo 👇", rootMenuKeyboard());
      return true;
    }
    await startWizard(String(chatId), flow, { client });
    return true;
  }

  if (data.startsWith("r:")) {
    const key = data.slice(2);
    const text = await runCanonicalRead(key);
    await reply(text, buildInlineKeyboard([backRow()]));
    return true;
  }

  if (data.startsWith("cor:")) {
    const rest = data.slice(4);
    if (rest === "recentes") {
      const { text, keyboard } = await buildRecentActivityView(client);
      await reply(text, keyboard);
      return true;
    }
    if (rest === "undolast") {
      const { text, keyboard } = await buildUndoLastMenu(client);
      await reply(text, keyboard);
      return true;
    }
    if (rest.startsWith("undoyes:")) {
      const auditId = rest.slice(8);
      const { text, keyboard } = await performUndo(auditId, { chatId, client });
      await reply(text, keyboard);
      return true;
    }
    if (rest === "undono") {
      await reply("Cancelado.", buildInlineKeyboard([backRow("m:corrigir")]));
      return true;
    }
    if (rest === "list") {
      const { text, keyboard } = await buildCorrectionListMenu(client);
      await reply(text, keyboard);
      return true;
    }
    if (rest.startsWith("unsupported:")) {
      const [, model] = rest.split(":");
      const { text, keyboard } = buildUnsupportedRecordMenu(model);
      await reply(text, keyboard);
      return true;
    }
    if (rest.startsWith("pick:")) {
      const [, model, id] = rest.split(":");
      const { text, keyboard } = await buildRecordActionMenu(model, id, client);
      await reply(text, keyboard);
      return true;
    }
    if (rest.startsWith("f:")) {
      const [, model, id, field] = rest.split(":");
      if (!CORRECTABLE_MODELS.some((m) => m.model === model) || !["amount", "description", "category", "date"].includes(field)) {
        await reply("Essa opção não existe mais. Abre o menu de novo 👇", rootMenuKeyboard());
        return true;
      }
      await startCorrectionFieldEdit(String(chatId), { model, id, field }, { client });
      return true;
    }
    if (rest.startsWith("delask:")) {
      const [, model, id] = rest.split(":");
      const { text, keyboard } = buildDeleteConfirmMenu(model, id);
      await reply(text, keyboard);
      return true;
    }
    if (rest.startsWith("delyes:")) {
      const [, model, id] = rest.split(":");
      const { text, keyboard } = await performDelete(model, id, { chatId, client });
      await reply(text, keyboard);
      return true;
    }
    if (rest === "delno") {
      await reply("Cancelado.", buildInlineKeyboard([backRow("m:corrigir")]));
      return true;
    }
  }

  return false;
}

// ----------------------------------------------------------------------------
// Aliases de texto (item 2/27) — SÓ abrem o wizard/menu correspondente,
// NUNCA interpretam valor/data/conta da frase inteira. `/comando` e a
// palavra solta equivalente mapeiam pro MESMO destino.
// ----------------------------------------------------------------------------
const TEXT_ALIASES = {
  menu: { type: "menu", key: "root" },
  despesa: { type: "wizard", flow: "gasto" },
  gasto: { type: "wizard", flow: "gasto" },
  receita: { type: "wizard", flow: "receita" },
  recebi: { type: "wizard", flow: "receita" },
  parcelado: { type: "wizard", flow: "parcela" },
  parcela: { type: "wizard", flow: "parcela" },
  multipla: { type: "wizard", flow: "multipla" },
  varios: { type: "wizard", flow: "multipla" },
  transferencia: { type: "wizard", flow: "transferencia" },
  transf: { type: "wizard", flow: "transferencia" },
  saldo: { type: "menu", key: "saldos" },
  fatura: { type: "wizard", flow: "fatura_atual" },
  simular: { type: "wizard", flow: "simulador" },
  consultar: { type: "menu", key: "consultar" },
  ajuda: { type: "menu", key: "ajuda" },
  cancelar: { type: "cancel" },
};

function normalizeAliasText(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/^\//, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acento — "transferência"/"transferencia" batem igual.
}

export function matchTextAlias(text) {
  if (typeof text !== "string") return null;
  const normalized = normalizeAliasText(text);
  return TEXT_ALIASES[normalized] || null;
}
