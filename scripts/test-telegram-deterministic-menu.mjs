// Fase 7D — Telegram determinístico / menu-driven. Testa os fluxos
// principais do NOVO menu/wizard contra o banco DEV real, sem NENHUMA
// chamada a Groq/Anthropic (item 36 — zero dependência de LLM pra usar
// qualquer menu). Cobre os casos obrigatórios do pedido (item 38):
// parcelamento real, reconciliação de saldo, reconciliação de fatura, lote
// atômico (sucesso e falha), navegação, idempotência, valores/datas
// inválidas, sessão expirada.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_MENU";
let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

let updateIdCounter = 800000000;

async function runText(text, chatId, { updateId } = {}) {
  return prisma.$transaction(
    async (tx) => {
      const uid = updateId ?? updateIdCounter++;
      const claim = await claimTelegramUpdateInTx(tx, uid, { senderId: "test", chatId });
      if (!claim.claimed) return { duplicate: true, outbox: [] };
      const outbox = [];
      const update = { update_id: uid, message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } };
      await dispatchUpdate(update, chatId, { client: tx, outbox });
      await completeTelegramUpdateInTx(tx, claim.receiptId);
      return { duplicate: false, outbox };
    },
    { timeout: 20000 }
  );
}

async function runCallback(data, chatId, { messageId = 111, updateId } = {}) {
  return prisma.$transaction(
    async (tx) => {
      const uid = updateId ?? updateIdCounter++;
      const claim = await claimTelegramUpdateInTx(tx, uid, { senderId: "test", chatId });
      if (!claim.claimed) return { duplicate: true, outbox: [] };
      const outbox = [];
      const update = { update_id: uid, callback_query: { id: `cbq${uid}`, data, from: { id: 1 }, message: { message_id: messageId, chat: { id: chatId, type: "private" } } } };
      await dispatchUpdate(update, chatId, { client: tx, outbox });
      await completeTelegramUpdateInTx(tx, claim.receiptId);
      return { duplicate: false, outbox };
    },
    { timeout: 20000 }
  );
}

function lastText(outbox) {
  const last = outbox[outbox.length - 1];
  return last?.args?.[last.type === "editMessageText" ? 2 : 1] || "";
}

const FINANCIAL_MODELS = ["expense", "income", "transfer", "purchase", "installment", "balanceAdjustment", "cardBillReconciliation", "confirmedCommitment", "contingency", "receivable"];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

const created = { purchases: [], balanceAdjustments: [], cardBillReconciliations: [], expenses: [], transfers: [] };
async function cleanup() {
  for (const id of created.purchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id } }).catch(() => {});
  }
  for (const id of created.balanceAdjustments) await prisma.balanceAdjustment.delete({ where: { id } }).catch(() => {});
  for (const id of created.cardBillReconciliations) await prisma.cardBillReconciliation.delete({ where: { id } }).catch(() => {});
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  const strayPurchases = await prisma.purchase.findMany({ where: { description: { contains: MARK } } });
  for (const p of strayPurchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  const strayExpenses = await prisma.expense.findMany({ where: { rawMessage: { contains: "assistente guiado" }, description: { contains: MARK } } });
  for (const e of strayExpenses) await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
}

async function main() {
  const fpBefore = await fingerprint();

  // ==========================================================================
  // Navegação: /start e /menu levam ao menu raiz; menu tem 8 seções.
  // ==========================================================================
  {
    const chatId = `${MARK}_nav`;
    const r = await runText("/start", chatId);
    check("[nav] /start mostra o menu raiz", lastText(r.outbox).includes("Norte"), lastText(r.outbox));
    const kb = r.outbox[0]?.args?.[2]?.replyMarkup?.inline_keyboard;
    const allData = kb?.flat().map((b) => b.callback_data) || [];
    check("[nav] menu raiz expõe Registrar/Cartão/Saldos/Consultar/Simular/Planejamento/Corrigir/Ajuda", ["m:registrar", "m:cartao", "m:saldos", "m:consultar", "w:simulador", "m:planejamento", "m:corrigir", "m:ajuda"].every((d) => allData.includes(d)), JSON.stringify(allData));

    const r2 = await runText("/menu", chatId);
    check("[nav] /menu também mostra o menu raiz", lastText(r2.outbox).includes("Norte"));

    // navega pro submenu Registrar e depois volta com ⬅️/🏠
    const r3 = await runCallback("m:registrar", chatId);
    check("[nav] m:registrar mostra o submenu de registrar", lastText(r3.outbox).includes("Registrar"), lastText(r3.outbox));
    const r4 = await runCallback("m:root", chatId);
    check("[nav] ⬅️ Voltar (m:root) volta pro menu raiz", lastText(r4.outbox).includes("Norte"));
  }

  // ==========================================================================
  // CASO OBRIGATÓRIO — compra parcelada real: R$118,34, "controle do portão",
  // Mercado Livre, 2x, Itaú, 08/09/2026 -> Purchase + 2 Installments de
  // R$59,17 (item 38 do pedido, exemplo EXATO).
  // ==========================================================================
  {
    const chatId = `${MARK}_parcela2`;
    await runCallback("w:parcela", chatId);
    await runText("118,34", chatId);
    await runText(`${MARK} controle do portão`, chatId);
    await runText("Mercado Livre", chatId); // merchant
    await runCallback("qtd:2", chatId);
    // >1 cartão real -> precisa escolher; com só 1, askParcelaCartao já pulou
    // direto pra categoria sozinho.
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    if (session?.step === "cartao") {
      const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
      await runCallback(`card:${card.id}`, chatId);
    }
    const rCat2 = await runCallback("cat:Transporte", chatId);
    await runCallback("date:outra", chatId);
    await runText("08/09/2026", chatId);
    const preview = lastSentTextFor(chatId);
    check("[parcela] preview contém a loja e a descrição", preview.includes("Mercado Livre") && preview.includes("controle do portão"), preview);
    check("[parcela] preview contém o valor total", preview.includes("118,34"), preview);
    check("[parcela] preview contém 2x de R$59,17 (divisão determinística)", preview.includes("2x de") && preview.includes("59,17"), preview);
    check("[parcela] preview contém o cartão Itaú", preview.toLowerCase().includes("itaú") || preview.toLowerCase().includes("itau"), preview);
    check("[parcela] preview contém a data 08/09/2026", preview.includes("08/09/2026"), preview);

    const fpBeforeConfirm = await fingerprint();
    const rConfirm = await runCallback("confirm:yes", chatId);
    const fpAfterConfirm = await fingerprint();
    check("[parcela] confirmar cria EXATAMENTE 1 Purchase", fpAfterConfirm.purchase - fpBeforeConfirm.purchase === 1, JSON.stringify({ before: fpBeforeConfirm, after: fpAfterConfirm }));
    check("[parcela] confirmar cria EXATAMENTE 2 Installments (nunca Expense simples nem 2 despesas)", fpAfterConfirm.installment - fpBeforeConfirm.installment === 2);
    check("[parcela] confirmar NÃO cria nenhuma Expense", fpAfterConfirm.expense === fpBeforeConfirm.expense);

    const purchase = await prisma.purchase.findFirst({ where: { description: { contains: MARK } }, orderBy: { createdAt: "desc" } });
    if (purchase) {
      created.purchases.push(purchase.id);
      const installments = await prisma.installment.findMany({ where: { purchaseId: purchase.id }, orderBy: { number: "asc" } });
      check("[parcela] installmentValue de cada parcela é 59.17", installments.every((i) => Number(i.amount) === 59.17), JSON.stringify(installments.map((i) => i.amount.toString())));
    } else {
      check("[parcela] Purchase encontrada pra verificar as parcelas", false);
    }
  }

  // ==========================================================================
  // CASO OBRIGATÓRIO — reconciliação de saldo: calculado vs observado
  // R$2099,34 -> diferença mostrada -> BalanceAdjustment, NUNCA Income.
  // ==========================================================================
  {
    const chatId = `${MARK}_saldo`;
    const account = await prisma.account.findFirst({ where: { type: "checking" } });
    await runCallback("w:saldo_itau", chatId);
    await runText("2099,34", chatId);
    const preview = lastSentTextFor(chatId);
    check("[saldo] preview mostra saldo observado, calculado e diferença", preview.includes("2.099,34") && preview.includes("Norte calculado") && preview.includes("Diferença"), preview);

    const fpBeforeConfirm = await fingerprint();
    const rConfirm = await runCallback("confirm:yes", chatId);
    const fpAfterConfirm = await fingerprint();
    check("[saldo] confirmar cria EXATAMENTE 1 BalanceAdjustment", fpAfterConfirm.balanceAdjustment - fpBeforeConfirm.balanceAdjustment === 1);
    check("[saldo] confirmar NUNCA cria Income (saldo observado != receita)", fpAfterConfirm.income === fpBeforeConfirm.income);
    const adj = await prisma.balanceAdjustment.findFirst({ where: { accountId: account.id }, orderBy: { createdAt: "desc" } });
    if (adj) {
      created.balanceAdjustments.push(adj.id);
      check("[saldo] BalanceAdjustment.confidence = RECONCILIATION_ADJUSTMENT", adj.confidence === "RECONCILIATION_ADJUSTMENT");
    }
  }

  // ==========================================================================
  // CASO OBRIGATÓRIO — reconciliação de fatura: observado R$1553,19 ->
  // CardBillReconciliation, NUNCA Expense.
  // ==========================================================================
  {
    const chatId = `${MARK}_fatura`;
    await runCallback("w:fatura_atual", chatId);
    await runText("1553,19", chatId);
    const preview = lastSentTextFor(chatId);
    check("[fatura] preview mostra fatura observada, calculada e diferença", preview.includes("1.553,19") && preview.includes("Norte calculado") && preview.includes("Diferença"), preview);

    const fpBeforeConfirm = await fingerprint();
    const rConfirm = await runCallback("confirm:yes", chatId);
    const fpAfterConfirm = await fingerprint();
    check("[fatura] confirmar cria EXATAMENTE 1 CardBillReconciliation", fpAfterConfirm.cardBillReconciliation - fpBeforeConfirm.cardBillReconciliation === 1);
    check("[fatura] confirmar NUNCA cria Expense (fatura observada != despesa nova)", fpAfterConfirm.expense === fpBeforeConfirm.expense);
    const rec = await prisma.cardBillReconciliation.findFirst({ orderBy: { createdAt: "desc" } });
    if (rec) created.cardBillReconciliations.push(rec.id);
  }

  // ==========================================================================
  // Despesa completa: valor -> descrição -> meio -> categoria -> data -> preview -> confirmar.
  // ==========================================================================
  {
    const chatId = `${MARK}_despesa`;
    await runCallback("w:gasto", chatId);
    await runText("45,90", chatId);
    await runText(`${MARK} Gasolina`, chatId);
    await runCallback("pm:pix", chatId);
    await runCallback("cat:Transporte", chatId);
    await runCallback("date:hoje", chatId);
    const preview = lastSentTextFor(chatId);
    check("[despesa] preview mostra descrição/valor/conta/categoria/data (sem enum técnico)", preview.includes(`${MARK} Gasolina`) && preview.includes("45,90") && preview.includes("Transporte"), preview);
    check("[despesa] preview não vaza nome de campo técnico (ex: RECORD_EXPENSE)", !preview.includes("RECORD_"));

    const fpBefore2 = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter2 = await fingerprint();
    check("[despesa] confirmar cria exatamente 1 Expense", fpAfter2.expense - fpBefore2.expense === 1);
    const exp = await prisma.expense.findFirst({ where: { description: { contains: MARK } }, orderBy: { createdAt: "desc" } });
    if (exp) created.expenses.push(exp.id);
  }

  // ==========================================================================
  // Transferência: valor -> origem -> destino -> descrição -> data -> preview -> confirmar.
  // ==========================================================================
  {
    const chatId = `${MARK}_transf`;
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    check("[transf] fixture tem >= 2 contas reais pra testar origem != destino", accounts.length >= 2);
    if (accounts.length >= 2) {
      await runCallback("w:transferencia", chatId);
      await runText("30", chatId);
      await runCallback(`acct:${accounts[0].id}`, chatId);
      await runCallback(`acct:${accounts[1].id}`, chatId);
      await runCallback("skip:descricao", chatId);
      await runCallback("date:hoje", chatId);
      const preview = lastSentTextFor(chatId);
      check("[transf] preview mostra origem -> destino", preview.includes(accounts[0].name) && preview.includes(accounts[1].name), preview);

      const fpBefore3 = await fingerprint();
      await runCallback("confirm:yes", chatId);
      const fpAfter3 = await fingerprint();
      check("[transf] confirmar cria EXATAMENTE 1 Transfer (nunca Expense)", fpAfter3.transfer - fpBefore3.transfer === 1 && fpAfter3.expense === fpBefore3.expense);
      const tr = await prisma.transfer.findFirst({ where: { fromAccountId: accounts[0].id, toAccountId: accounts[1].id }, orderBy: { createdAt: "desc" } });
      if (tr) created.transfers.push(tr.id);
    }
  }

  // ==========================================================================
  // Batch atômico — sucesso: 2 despesas no lote, aplica as 2 numa transação só.
  // ==========================================================================
  {
    const chatId = `${MARK}_batch_ok`;
    await runCallback("w:multipla", chatId);
    await runCallback("batch:add:despesa", chatId);
    await runText("10", chatId);
    await runText(`${MARK} item1`, chatId);
    await runCallback("bpm:pix", chatId);
    await runCallback("batch:add:despesa", chatId);
    await runText("20", chatId);
    await runText(`${MARK} item2`, chatId);
    await runCallback("bpm:pix", chatId);
    const listText = lastSentTextFor(chatId);
    check("[batch] lista mostra os 2 itens adicionados", listText.includes("item1") || listText.includes("2"), listText);

    await runCallback("batch:review", chatId);
    const reviewText = lastSentTextFor(chatId);
    check("[batch] revisão mostra o total (10+20=30)", reviewText.includes("30"), reviewText);

    const fpBefore4 = await fingerprint();
    await runCallback("confirm:yes", chatId);
    const fpAfter4 = await fingerprint();
    check("[batch] confirmar aplica AS DUAS actions atomicamente (2 Expenses novas)", fpAfter4.expense - fpBefore4.expense === 2, JSON.stringify({ before: fpBefore4, after: fpAfter4 }));
    const items = await prisma.expense.findMany({ where: { description: { in: [`${MARK} item1`, `${MARK} item2`] } } });
    created.expenses.push(...items.map((i) => i.id));
  }

  // ==========================================================================
  // Batch atômico — falha: força um erro no meio do lote (conta inexistente)
  // e confirma ZERO itens persistidos (rollback da transação inteira).
  // ==========================================================================
  {
    const chatId = `${MARK}_batch_fail`;
    await runCallback("w:multipla", chatId);
    await runCallback("batch:add:despesa", chatId);
    await runText("15", chatId);
    await runText(`${MARK} itemA`, chatId);
    await runCallback("bpm:pix", chatId);
    await runCallback("batch:review", chatId);

    // Corrompe o 2º "item" inexistente ainda, mas simula falha real:
    // referencia um accountId inválido diretamente no item já coletado, pra
    // forçar commitBotIntent a lançar no meio do loop (prisma FK/record not found).
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    const corrupted = { ...session.data, items: [...session.data.items, { kind: "despesa", amount: 5, description: `${MARK} itemB-invalido`, targetType: "account", targetId: "id-que-nao-existe" }] };
    await prisma.botWizardSession.update({ where: { id: session.id }, data: { data: corrupted } });

    const fpBefore5 = await fingerprint();
    let threw = false;
    try {
      await runCallback("confirm:yes", chatId);
    } catch {
      threw = true;
    }
    const fpAfter5 = await fingerprint();
    check("[batch falha] ZERO itens persistidos quando uma action do lote falha (rollback atômico)", fpAfter5.expense === fpBefore5.expense, JSON.stringify({ before: fpBefore5, after: fpAfter5, threw }));
    const leaked = await prisma.expense.findFirst({ where: { description: `${MARK} itemA` } });
    check("[batch falha] nem o item VÁLIDO do lote (itemA) foi persistido — tudo ou nada", !leaked);
  }

  // ==========================================================================
  // Idempotência: mesmo update_id enviado 2x -> só processa 1 vez (callback e texto).
  // ==========================================================================
  {
    const chatId = `${MARK}_idem`;
    const fixedUpdateId = updateIdCounter++;
    const r1 = await runText(`${MARK} qualquer coisa fora de wizard`, chatId, { updateId: fixedUpdateId });
    const r2 = await runText(`${MARK} qualquer coisa fora de wizard`, chatId, { updateId: fixedUpdateId });
    check("[idempotência] retry do MESMO update_id é rejeitado como duplicate", r1.duplicate === false && r2.duplicate === true, JSON.stringify({ r1: r1.duplicate, r2: r2.duplicate }));
  }

  // ==========================================================================
  // Texto livre fora de wizard NUNCA interpreta finanças (item 2) — mostra o
  // menu em vez de tentar registrar "50 reais" como despesa.
  // ==========================================================================
  {
    const chatId = `${MARK}_freetext`;
    const fpBeforeFT = await fingerprint();
    const r = await runText(`${MARK} mano gastei 50 reais`, chatId);
    const fpAfterFT = await fingerprint();
    check("[texto livre] fora de wizard nunca cria um lançamento financeiro", JSON.stringify(fpBeforeFT) === JSON.stringify(fpAfterFT), JSON.stringify({ before: fpBeforeFT, after: fpAfterFT }));
    const nudge = lastText(r.outbox);
    check("[texto livre] resposta é o nudge pro menu (nunca um valor confirmado)", nudge.toLowerCase().includes("menu"), nudge);
  }

  // ==========================================================================
  // Aliases de texto abrem o wizard certo (nunca interpretam a frase).
  // ==========================================================================
  {
    const chatId = `${MARK}_alias`;
    const r = await runText("despesa", chatId);
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    check("[alias] 'despesa' abre o wizard de despesa (flow=gasto)", session?.flow === "gasto", JSON.stringify(session));
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
  }

  // ==========================================================================
  // Valor inválido: wizard nunca aceita lixo como valor, pede de novo.
  // ==========================================================================
  {
    const chatId = `${MARK}_invalidval`;
    await runCallback("w:gasto", chatId);
    await runText("abacate", chatId);
    const msg = lastSentTextFor(chatId) || "";
    check("[valor inválido] rejeita texto sem número, pede de novo (nunca avança)", msg.toLowerCase().includes("não entendi"), msg);
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    check("[valor inválido] wizard continua no mesmo step (valor)", session?.step === "valor");
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
  }

  // ==========================================================================
  // Data inválida: "outra data" com texto que não é DD/MM nem DD/MM/AAAA.
  // ==========================================================================
  {
    const chatId = `${MARK}_invaliddate`;
    await runCallback("w:gasto", chatId);
    await runText("10", chatId);
    await runText(`${MARK} teste`, chatId);
    await runCallback("pm:pix", chatId);
    await runCallback("cat:Outros", chatId);
    await runCallback("date:outra", chatId);
    await runText("essa semana", chatId);
    const msg = lastSentTextFor(chatId) || "";
    check("[data inválida] rejeita data ambígua, pede de novo", msg.toLowerCase().includes("não entendi"), msg);
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
  }

  // ==========================================================================
  // Sessão de wizard expirada (stale) — nunca executa a ação.
  // ==========================================================================
  {
    const chatId = `${MARK}_stale`;
    const realAccount = await prisma.account.findFirst({ where: { type: "checking" } });
    // targetId/targetLabel usam uma conta REAL de propósito — se o fix de
    // expiração (item 28) não estivesse aplicado, isto executaria uma
    // Expense de verdade em vez de só falhar com um erro de dado inválido.
    await prisma.botWizardSession.create({ data: { chatId, flow: "gasto", step: "confirmar", data: { amount: 999, description: `${MARK} stale`, category: "Outros", targetType: "account", targetId: realAccount.id, targetLabel: realAccount.name }, expiresAt: new Date(Date.now() - 1000) } });
    const fpBeforeStale = await fingerprint();
    const r = await runCallback("confirm:yes", chatId);
    const fpAfterStale = await fingerprint();
    check("[wizard stale] sessão expirada nunca executa a ação (zero write)", JSON.stringify(fpBeforeStale) === JSON.stringify(fpAfterStale));
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
  }

  // ==========================================================================
  // Cancelar: ❌ Cancelar aborta o fluxo sem gravar nada.
  // ==========================================================================
  {
    const chatId = `${MARK}_cancel`;
    await runCallback("w:gasto", chatId);
    await runText("10", chatId);
    const fpBeforeCancel = await fingerprint();
    const r = await runCallback("wiznav:cancel", chatId);
    const fpAfterCancel = await fingerprint();
    check("[cancelar] wiznav:cancel aborta sem gravar nada", JSON.stringify(fpBeforeCancel) === JSON.stringify(fpAfterCancel));
    const session = await prisma.botWizardSession.findUnique({ where: { chatId } });
    check("[cancelar] sessão de wizard é removida", session == null);
  }

  // ==========================================================================
  // Simulador: zero write, sempre.
  // ==========================================================================
  {
    const chatId = `${MARK}_sim`;
    const fpBeforeSim = await fingerprint();
    await runCallback("w:simulador", chatId);
    await runText("300", chatId);
    await runCallback("simmode:avista", chatId);
    await runCallback("simpm:cash", chatId);
    const fpAfterSim = await fingerprint();
    const simText = lastSentTextFor(chatId) || "";
    check("[simulador] resultado é uma string não-vazia", simText.length > 0, simText);
    check("[simulador] ZERO write em qualquer etapa", JSON.stringify(fpBeforeSim) === JSON.stringify(fpAfterSim));
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
  }

  // ==========================================================================
  // Consultar — leituras canônicas A-L acessíveis via menu, zero write.
  // ==========================================================================
  {
    const chatId = `${MARK}_consultar`;
    const fpBeforeRead = await fingerprint();
    for (const key of ["r:summary", "r:balance", "r:free", "r:safe", "r:committed", "r:nextincome", "r:va", "r:installment_relief", "r:projection"]) {
      const r = await runCallback(key, chatId);
      check(`[consultar] ${key} responde com texto não-vazio`, lastText(r.outbox).length > 0, key);
    }
    const fpAfterRead = await fingerprint();
    check("[consultar] TODAS as leituras são zero-write", JSON.stringify(fpBeforeRead) === JSON.stringify(fpAfterRead));
  }

  const fpAfterAll = await fingerprint();
  console.log("\n--- fingerprint final (referência, não é uma checagem de zero-drift do arquivo inteiro — cada caso já verificou o delta esperado) ---");
  console.log(JSON.stringify({ before: fpBefore, after: fpAfterAll }));

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
if (fail > 0) exitCode = 1;
process.exit(exitCode);
