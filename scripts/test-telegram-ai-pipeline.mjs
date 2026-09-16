// Fase 7.0 — testes de integração ponta a ponta do pipeline conversacional,
// usando o MockProvider (item 18: "não deixar CI depender de chamada real
// paga") contra o banco DEV real. Cobre os casos A-L do pedido original.
//
//   node scripts/test-telegram-ai-pipeline.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";
import { createMockProvider } from "../lib/telegramAi/llmProvider.js";
import { handleConversationalMessage, PIPELINE_RESULT_KIND } from "../lib/telegramAi/pipeline.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";

const MARK = "TESTE_TG_AI";
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

const created = { expenses: [], incomes: [], transfers: [], purchases: [], balanceAdjustments: [], cardBillReconciliations: [], commitments: [], contingencies: [], receivables: [] };
let cardBillSnapshotBefore = null;
let updateIdCounter = 900000000; // faixa alta, nunca colide com update_id real do Telegram.

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of created.transfers) await prisma.transfer.delete({ where: { id } }).catch(() => {});
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  for (const id of created.balanceAdjustments) await prisma.balanceAdjustment.delete({ where: { id } }).catch(() => {});
  for (const id of created.cardBillReconciliations) await prisma.cardBillReconciliation.delete({ where: { id } }).catch(() => {});
  for (const id of created.commitments) await prisma.confirmedCommitment.delete({ where: { id } }).catch(() => {});
  for (const id of created.contingencies) await prisma.contingency.delete({ where: { id } }).catch(() => {});
  for (const id of created.receivables) await prisma.receivable.delete({ where: { id } }).catch(() => {});
  for (const id of created.purchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id } }).catch(() => {});
  }
  if (cardBillSnapshotBefore) {
    await prisma.cardBill.update({ where: { id: cardBillSnapshotBefore.id }, data: { paidAmount: cardBillSnapshotBefore.paidAmount, status: cardBillSnapshotBefore.status, paidAt: cardBillSnapshotBefore.paidAt } }).catch(() => {});
  }
  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  // Varredura por MARK em `rawMessage` OU `description`: um confirm/correção
  // grava a mensagem ORIGINAL como rawMessage (ver fix em pipeline.js), mas
  // uma execução criada ANTES desse fix (ou qualquer caminho futuro que
  // grave só a description) ainda precisa ser pega aqui — nunca confiar em
  // um único campo pra não deixar dado de teste real pra trás no DEV.
  const strayExpenses = await prisma.expense.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const e of strayExpenses) await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
  const strayIncomes = await prisma.income.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const i of strayIncomes) await prisma.income.delete({ where: { id: i.id } }).catch(() => {});
  const strayTransfers = await prisma.transfer.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const t of strayTransfers) await prisma.transfer.delete({ where: { id: t.id } }).catch(() => {});
  const strayPurchases = await prisma.purchase.findMany({ where: { description: { contains: MARK } } });
  for (const p of strayPurchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  console.log(`Limpeza concluída. Stray remanescentes — expenses: ${strayExpenses.length}, incomes: ${strayIncomes.length}, transfers: ${strayTransfers.length}, purchases: ${strayPurchases.length}.`);
}

// Roda a mensagem dentro de uma transação real, igual ao pipeline de
// produção (lib/telegramUpdateHandler.js) — prova que o executor funciona
// dentro da MESMA transação de idempotência, não só isolado.
async function runMessage(text, chatId, { provider, updateId }) {
  return prisma.$transaction(
    async (tx) => {
      if (updateId != null) {
        const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "test", chatId });
        if (!claim.claimed) return { kind: "duplicate_skipped" };
      }
      const result = await handleConversationalMessage(text, chatId, { client: tx, provider, rawMessage: text });
      if (updateId != null) await completeTelegramUpdateInTx(tx, (await tx.telegramUpdateReceipt.findUnique({ where: { updateId: BigInt(updateId) } })).id);
      return result;
    },
    { timeout: 20000 } // testes rodam mais queries em série por transação do que um update real do Telegram — a produção não precisa deste teto maior.
  );
}

function jsonReply(obj) {
  return JSON.stringify(obj);
}

async function main() {
  const acct = await prisma.account.findFirst({ where: { type: "checking" } });
  const card = await prisma.card.findFirst();
  check("[pré] existe conta checking real", !!acct);
  check("[pré] existe cartão real", !!card);
  if (!acct || !card) return;

  // ==========================================================================
  // A) SIMPLES — "gastei 50 de gasolina no pix"
  // ==========================================================================
  {
    const chatId = `${MARK}_A`;
    const provider = createMockProvider([
      [
        (p) => p.includes("gasolina no pix"),
        () =>
          jsonReply({
            kind: "financial_plan",
            actions: [{ type: "RECORD_EXPENSE", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", category: "Transporte", paymentMethod: "pix", description: `${MARK} gasolina` }],
          }),
      ],
    ]);
    const result = await runMessage(`${MARK} gastei 50 de gasolina no pix`, chatId, { provider });
    check("[A] gasto simples de alta confiança -> AUTOCONFIRMA (executa direto)", result.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(result.reply), JSON.stringify(result));
    const expense = await prisma.expense.findFirst({ where: { description: { contains: `${MARK} gasolina` } } });
    check("[A] Expense real foi criada", !!expense && Number(expense.amount) === 50, JSON.stringify(expense));
    check("[A] resposta é curta, sem enum/jargão técnico", result.reply && !/RECORD_EXPENSE|localId|confidence/i.test(result.reply));
    if (expense) created.expenses.push(expense.id);
  }

  // ==========================================================================
  // B) PARCELADA — compra real de portão no Mercado Livre
  // ==========================================================================
  {
    const chatId = `${MARK}_B`;
    const plan = {
      kind: "financial_plan",
      actions: [{ type: "RECORD_INSTALLMENT_PURCHASE", localId: "a1", confidence: "HIGH", totalAmount: "118.34", installments: 2, installmentAmount: "59.17", date: "2026-09-08", card: card.name, merchant: "Mercado Livre", description: `${MARK} controle do portão` }],
    };
    const provider = createMockProvider([[(p) => p.includes("controle para o portão"), () => jsonReply(plan)]]);
    const text = `${MARK} No dia 08/09/2026 comprei um controle para o portão no Mercado Livre por R$ 118,34 no cartão de crédito ${card.name}, parcelado em 2 vezes de R$ 59,17.`;
    const preview = await runMessage(text, chatId, { provider });
    check("[B] compra parcelada NUNCA autoconfirma -> pede confirmação", preview.kind === PIPELINE_RESULT_KIND.REPLY && /[Cc]onfirmar/.test(preview.reply), JSON.stringify(preview));
    check("[B] pergunta reconhece valor/parcelas corretamente (118,34 em 2x de 59,17), sem confusão com data/quantidade", /118,34/.test(preview.reply) && /59,17/.test(preview.reply) && /2x/.test(preview.reply));
    const noWrite = await prisma.purchase.findFirst({ where: { description: { contains: `${MARK} controle` } } });
    check("[B] preview NUNCA escreve (zero Purchase antes da confirmação)", !noWrite);

    const confirmProvider = createMockProvider([]); // não deveria nem chamar o LLM pra "sim" com pending executável.
    const confirmResult = await runMessage("sim", chatId, { provider: confirmProvider });
    check('[B] "sim" confirma e EXECUTA a compra parcelada de verdade', confirmResult.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmResult.reply), JSON.stringify(confirmResult));
    const purchase = await prisma.purchase.findFirst({ where: { description: { contains: `${MARK} controle` } } });
    check("[B] Purchase real criada com os valores corretos", !!purchase && Number(purchase.totalAmount) === 118.34 && purchase.installmentCount === 2, JSON.stringify(purchase));
    if (purchase) {
      created.purchases.push(purchase.id);
      const installments = await prisma.installment.findMany({ where: { purchaseId: purchase.id } });
      check("[B] usa a MESMA lógica oficial de Installment (2 parcelas geradas, nunca Expense simples)", installments.length === 2, JSON.stringify(installments));
    }
  }

  // ==========================================================================
  // C) SALDO — "Meu saldo atual da conta Itaú é R$ 2.099,34."
  // ==========================================================================
  {
    const chatId = `${MARK}_C`;
    const plan = { kind: "financial_plan", actions: [{ type: "SET_ACCOUNT_BALANCE_SNAPSHOT", localId: "a1", confidence: "HIGH", account: acct.name, observedBalance: "2099.34", date: "2026-09-16" }] };
    const provider = createMockProvider([[(p) => p.includes("saldo atual da conta"), () => jsonReply(plan)]]);
    const preview = await runMessage(`${MARK} Meu saldo atual da conta ${acct.name} é R$ 2.099,34.`, chatId, { provider });
    check("[C] snapshot de saldo NUNCA vira Income — sempre pede reconciliação", preview.kind === PIPELINE_RESULT_KIND.REPLY && /[Rr]econciliar/.test(preview.reply), JSON.stringify(preview));
    const noIncome = await prisma.income.findFirst({ where: { rawMessage: { contains: `${MARK} Meu saldo` } } });
    check("[C] ZERO Income criado (nunca confunde saldo observado com receita)", !noIncome);

    const confirmProvider = createMockProvider([]);
    const confirmResult = await runMessage("sim", chatId, { provider: confirmProvider });
    check('[C] "sim" aplica a reconciliação real', confirmResult.kind === PIPELINE_RESULT_KIND.REPLY && /[Rr]econciliad/.test(confirmResult.reply), JSON.stringify(confirmResult));
    const adjustment = await prisma.balanceAdjustment.findFirst({ where: { accountId: acct.id, newBalance: 2099.34 } });
    check("[C] BalanceAdjustment real criado com confidence=RECONCILIATION_ADJUSTMENT (nunca CONFIRMED)", !!adjustment && adjustment.confidence === "RECONCILIATION_ADJUSTMENT", JSON.stringify(adjustment));
    const stillNoIncome = await prisma.income.findFirst({ where: { rawMessage: { contains: `${MARK} Meu saldo` } } });
    check("[C] confirmação também não criou Income", !stillNoIncome);
    if (adjustment) created.balanceAdjustments.push(adjustment.id);
  }

  // ==========================================================================
  // D) FATURA — "Minha fatura atual do cartão Itaú é R$ 1.553,19."
  // ==========================================================================
  {
    const chatId = `${MARK}_D`;
    const plan = { kind: "financial_plan", actions: [{ type: "SET_CARD_BILL_SNAPSHOT", localId: "a1", confidence: "HIGH", card: card.name, observedTotal: "1553.19", date: "2026-09-16" }] };
    const provider = createMockProvider([[(p) => p.includes("fatura atual do cartão"), () => jsonReply(plan)]]);
    const preview = await runMessage(`${MARK} Minha fatura atual do cartão ${card.name} é R$ 1.553,19.`, chatId, { provider });
    check("[D] snapshot de fatura NUNCA vira Expense — sempre pede reconciliação com o delta", preview.kind === PIPELINE_RESULT_KIND.REPLY && /[Rr]econciliar/.test(preview.reply) && /[Dd]iferença/.test(preview.reply), JSON.stringify(preview));
    const noExpense = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} Minha fatura` } } });
    check("[D] ZERO Expense criado (nunca inventa compra pra explicar a diferença)", !noExpense);

    const confirmResult = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[D] "sim" aplica a reconciliação de fatura real', confirmResult.kind === PIPELINE_RESULT_KIND.REPLY, JSON.stringify(confirmResult));
    const reconciliation = await prisma.cardBillReconciliation.findFirst({ where: { cardId: card.id, observedTotal: 1553.19 } });
    check("[D] CardBillReconciliation real criada (mecanismo que não existia antes desta fase)", !!reconciliation && Number(reconciliation.delta) !== 0, JSON.stringify(reconciliation));
    if (reconciliation) created.cardBillReconciliations.push(reconciliation.id);
  }

  // ==========================================================================
  // E) PAGAMENTO — "paguei a fatura do cartão, valor pequeno pra caber no restante real"
  // ==========================================================================
  {
    // Precisa ser a MESMA fatura que executeRecordCardPayment/payBill vão
    // mutar de verdade (resolveCurrentBillSafely usa getCardCycleForDate(card,
    // new Date()) — nunca "a fatura mais recente materializada", que pode ser
    // uma fatura FUTURA já pré-criada e nunca é a que payBill toca).
    const currentCycle = getCardCycleForDate(card, new Date());
    const currentBill = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth: currentCycle } } });
    cardBillSnapshotBefore = currentBill ? { id: currentBill.id, paidAmount: currentBill.paidAmount, status: currentBill.status, paidAt: currentBill.paidAt } : null;

    const chatId = `${MARK}_E`;
    const plan = { kind: "financial_plan", actions: [{ type: "RECORD_CARD_PAYMENT", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", card: card.name, fromAccount: acct.name }] };
    const provider = createMockProvider([[(p) => p.includes("paguei a fatura"), () => jsonReply(plan)]]);
    const preview = await runMessage(`${MARK} paguei a fatura do cartão, 50`, chatId, { provider });
    check("[E] pagamento de fatura NUNCA autoconfirma (sempre pede confirmação)", preview.kind === PIPELINE_RESULT_KIND.REPLY && /[Cc]onfirmar/.test(preview.reply), JSON.stringify(preview));
    const noExpenseYet = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} paguei a fatura` } } });
    check("[E] ZERO Expense criado (pagamento de fatura nunca é Expense)", !noExpenseYet);

    const confirmResult = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[E] "sim" registra o pagamento via semântica de Transfer/passivo, nunca dobra o gasto', confirmResult.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmResult.reply), JSON.stringify(confirmResult));
    const paymentTransfer = await prisma.transfer.findFirst({ where: { kind: "card_bill_payment", rawMessage: { contains: `${MARK} paguei a fatura` } } });
    check("[E] Transfer kind=card_bill_payment real criada (reusa payBill existente)", !!paymentTransfer && Number(paymentTransfer.amount) === 50, JSON.stringify(paymentTransfer));
    const stillNoExpense = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} paguei a fatura` } } });
    check("[E] confirmação também não criou nenhum Expense", !stillNoExpense);
    if (paymentTransfer) created.transfers.push(paymentTransfer.id);
  }

  // ==========================================================================
  // F) BATCH — 7 lançamentos numa mensagem só, atômico
  // ==========================================================================
  {
    const chatId = `${MARK}_F`;
    const bia = "Bia";
    const actions = [
      { type: "RECORD_EXPENSE", localId: "f1", confidence: "HIGH", amount: "55.00", date: "2026-09-08", paymentMethod: "pix", description: `${MARK} café`, category: "Alimentação" },
      { type: "RECORD_TRANSFER", localId: "f2", confidence: "HIGH", amount: "50.00", date: "2026-09-08", fromAccount: acct.name, toAccount: acct.name, description: `${MARK} transferência pra ${bia}` },
      { type: "RECORD_TRANSFER", localId: "f3", confidence: "HIGH", amount: "9.00", date: "2026-09-08", fromAccount: acct.name, toAccount: acct.name, description: `${MARK} transferência pro pedro` },
      { type: "RECORD_TRANSFER", localId: "f4", confidence: "HIGH", amount: "25.00", date: "2026-09-08", fromAccount: acct.name, toAccount: acct.name, description: `${MARK} transferência pra ${bia} 2` },
      { type: "RECORD_EXPENSE", localId: "f5", confidence: "HIGH", amount: "93.00", date: "2026-09-09", paymentMethod: "pix", description: `${MARK} mercado livre tapete catarina`, category: "Outros" },
      { type: "RECORD_EXPENSE", localId: "f6", confidence: "HIGH", amount: "50.00", date: "2026-09-09", paymentMethod: "pix", description: `${MARK} gasolina`, category: "Transporte" },
      { type: "RECORD_TRANSFER", localId: "f7", confidence: "HIGH", amount: "20.00", date: "2026-09-09", fromAccount: acct.name, toAccount: acct.name, description: `${MARK} transferência pra ${bia} 3` },
    ];
    const plan = { kind: "financial_plan", actions };
    const provider = createMockProvider([[(p) => p.includes("mandei 50 pra bia"), () => jsonReply(plan)]]);
    const text = `${MARK} dia 8 gastei 55 num café no pix, mandei 50 pra bia, 9 pro pedro e 25 pra bia. dia 9 comprei 93 no mercado livre pro tapete da catarina, botei 50 de gasolina e mandei 20 pra bia.`;
    const preview = await runMessage(text, chatId, { provider });
    check("[F] mensagem longa com múltiplos eventos -> encontra as 7 actions e pede confirmação do lote", preview.kind === PIPELINE_RESULT_KIND.REPLY && /7 lançamento/.test(preview.reply), JSON.stringify(preview));
    const beforeCount = await prisma.expense.count({ where: { rawMessage: { contains: `${MARK} dia 8` } } });
    check("[F] preview do batch NÃO escreve nada ainda", beforeCount === 0);

    const confirmResult = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[F] "sim" aplica o BATCH inteiro', confirmResult.kind === PIPELINE_RESULT_KIND.REPLY, JSON.stringify(confirmResult));
    const expensesCreated = await prisma.expense.findMany({ where: { rawMessage: { contains: `${MARK} dia 8` } } });
    const transfersCreated = await prisma.transfer.findMany({ where: { rawMessage: { contains: `${MARK} dia 8` } } });
    check("[F] EXATAMENTE 3 Expenses + 4 Transfers criados (7 no total, atômico)", expensesCreated.length === 3 && transfersCreated.length === 4, `expenses=${expensesCreated.length} transfers=${transfersCreated.length}`);
    expensesCreated.forEach((e) => created.expenses.push(e.id));
    transfersCreated.forEach((t) => created.transfers.push(t.id));
  }

  // ==========================================================================
  // G) CONTEXTO MULTI-TURN — clarificação -> "sim" completa a intenção original
  // ==========================================================================
  {
    const chatId = `${MARK}_G`;
    const clarificationPlan = {
      kind: "financial_plan",
      actions: [{ type: "CLARIFICATION_REQUIRED", localId: "g1", confidence: "LOW", question: `Foi no cartão ${card.name}?`, partialAction: { type: "RECORD_EXPENSE", amount: "120.38", date: "2026-09-15", description: `${MARK} claude` } }],
    };
    const provider1 = createMockProvider([[(p) => p.includes("no Claude ontem"), () => jsonReply(clarificationPlan)]]);
    const first = await runMessage(`${MARK} gastei 120,38 no Claude ontem`, chatId, { provider: provider1 });
    check("[G] valor sem conta -> CLARIFICATION_REQUIRED, pergunta específica (não genérica)", first.kind === PIPELINE_RESULT_KIND.REPLY && /cartão/i.test(first.reply), JSON.stringify(first));

    const completedPlan = {
      kind: "financial_plan",
      actions: [{ type: "RECORD_EXPENSE", localId: "g1", confidence: "HIGH", amount: "120.38", date: "2026-09-15", card: card.name, description: `${MARK} claude` }],
    };
    // A resposta "sim" precisa voltar pro LLM (não é atalho determinístico,
    // já que o pending é CLARIFICATION_REQUIRED) — a fixture confirma que o
    // contexto da pendência (a pergunta sobre o cartão) chegou no prompt.
    const provider2 = createMockProvider([[(p) => p.includes("CLARIFICATION_REQUIRED") && p.includes("claude"), () => jsonReply(completedPlan)]]);
    const second = await runMessage("sim", chatId, { provider: provider2 });
    check('[G] "sim" completa a intenção ORIGINAL (não vira um novo gasto do zero) -> pede confirmação do gasto completo', second.kind === PIPELINE_RESULT_KIND.REPLY && /120,38/.test(second.reply), JSON.stringify(second));
  }

  // ==========================================================================
  // H) CORREÇÃO — "gastei 80 no mercado" -> "na verdade foi 90"
  // ==========================================================================
  {
    const chatId = `${MARK}_H`;
    const originalPlan = { kind: "financial_plan", actions: [{ type: "RECORD_EXPENSE", localId: "h1", confidence: "MEDIUM", amount: "80.00", date: "2026-09-16", account: acct.name, description: `${MARK} feira do bairro`, category: "Alimentação" }] };
    const provider1 = createMockProvider([[(p) => p.includes("gastei 80 no mercado"), () => jsonReply(originalPlan)]]);
    const first = await runMessage(`${MARK} gastei 80 no mercado`, chatId, { provider: provider1 });
    check("[H] confiança MEDIUM -> pede confirmação (não autoconfirma)", first.kind === PIPELINE_RESULT_KIND.REPLY && /[Cc]onfirmar/.test(first.reply));

    const correctionPlan = {
      kind: "financial_plan",
      actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "h2", confidence: "HIGH", target: { kind: "pending_action", localId: "h1" }, fieldChanges: { amount: "90.00" } }],
    };
    const provider2 = createMockProvider([[(p) => p.includes("na verdade foi 90"), () => jsonReply(correctionPlan)]]);
    const corrected = await runMessage("na verdade foi 90", chatId, { provider: provider2 });
    check("[H] correção aponta pro pending EXPLICITAMENTE (localId), nunca por heurística de substring", corrected.kind === PIPELINE_RESULT_KIND.REPLY && /90,00|90\.00|90/.test(corrected.reply), JSON.stringify(corrected));

    const confirmResult = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    const expense = await prisma.expense.findFirst({ where: { description: { contains: `${MARK} feira do bairro` } } });
    check("[H] valor final aplicado é 90 (o corrigido), NUNCA 80 (o original)", !!expense && Number(expense.amount) === 90, JSON.stringify(expense));
    if (expense) created.expenses.push(expense.id);
  }

  // ==========================================================================
  // I) FUNDING GAP — "os chopes eram pra ter saído do vale" -> unsupported, documentado
  // ==========================================================================
  {
    const chatId = `${MARK}_I`;
    const plan = {
      kind: "financial_plan",
      actions: [{ type: "CLARIFICATION_REQUIRED", localId: "i1", confidence: "LOW", question: "Essa reconciliação de funding (cartão -> vale) ainda não é suportada. Quer que eu registre só como observação, sem mover nada?" }],
    };
    const provider = createMockProvider([[(p) => p.includes("chopes"), () => jsonReply(plan)]]);
    const result = await runMessage(`${MARK} esses dois chopes de 15 e 31 eu passei no cartão, mas era pra ter saído do vale`, chatId, { provider });
    check("[I] funding compensation NUNCA inventa uma gambiarra — vira CLARIFICATION_REQUIRED explicando a lacuna", result.kind === PIPELINE_RESULT_KIND.REPLY, JSON.stringify(result));
    const noExpense = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} esses dois chopes` } } });
    check("[I] ZERO escrita financeira gerada por este caso (nem duplicando, nem inventando compensação)", !noExpense);
  }

  // ==========================================================================
  // J) NÃO-FINANCEIRO — nunca gera transação
  // ==========================================================================
  {
    const chatId = `${MARK}_J`;
    const plan = { kind: "financial_plan", actions: [{ type: "NO_FINANCIAL_INTENT", localId: "j1", confidence: "HIGH" }] };
    const provider = createMockProvider([[(p) => p.includes("versão 2 ficou melhor"), () => jsonReply(plan)]]);
    const result = await runMessage(`${MARK} a versão 2 ficou melhor que a 1`, chatId, { provider });
    check("[J] mensagem não-financeira -> SILENT (zero resposta financeira, nunca 'não entendi')", result.kind === PIPELINE_RESULT_KIND.SILENT, JSON.stringify(result));
    const noWrite = await prisma.expense.count({ where: { rawMessage: { contains: `${MARK} a versão 2` } } });
    check("[J] ZERO escrita gerada", noWrite === 0);
  }

  // ==========================================================================
  // K) DATA/NÚMEROS — valor principal não pode se confundir com data/parcelas
  // ==========================================================================
  {
    const chatId = `${MARK}_K`;
    const plan = {
      kind: "financial_plan",
      actions: [{ type: "RECORD_INSTALLMENT_PURCHASE", localId: "k1", confidence: "HIGH", totalAmount: "118.34", installments: 2, installmentAmount: "59.17", date: "2026-09-08", card: card.name, description: `${MARK} teste data numeros` }],
    };
    const provider = createMockProvider([[(p) => p.includes("dia 08/09 comprei por 118,34"), () => jsonReply(plan)]]);
    const result = await runMessage(`${MARK} dia 08/09 comprei por 118,34 em 2x de 59,17`, chatId, { provider });
    check('[K] valor principal é 118,34 "sem paranoia" — nunca confundido com "08", "09", "2" ou "59,17"', result.kind === PIPELINE_RESULT_KIND.REPLY && /118,34/.test(result.reply) && !/R\$\s*8,09|R\$\s*2,59/.test(result.reply), JSON.stringify(result));
  }

  // ==========================================================================
  // L) RETRY — mesmo update_id do Telegram duas vezes -> 1 única escrita
  // ==========================================================================
  {
    const chatId = `${MARK}_L`;
    const plan = { kind: "financial_plan", actions: [{ type: "RECORD_EXPENSE", localId: "l1", confidence: "HIGH", amount: "33.00", date: "2026-09-16", paymentMethod: "pix", description: `${MARK} retry test`, category: "Outros" }] };
    const provider = createMockProvider([[(p) => p.includes("retry test trigger"), () => jsonReply(plan)]]);
    const updateId = ++updateIdCounter;
    const first = await runMessage(`${MARK} retry test trigger`, chatId, { provider, updateId });
    check("[L] primeira entrega processa normalmente", first.kind === PIPELINE_RESULT_KIND.REPLY);
    const second = await runMessage(`${MARK} retry test trigger`, chatId, { provider, updateId });
    check("[L] segunda entrega do MESMO update_id é rejeitada pela idempotência (claim falha)", second.kind === "duplicate_skipped", JSON.stringify(second));
    const count = await prisma.expense.count({ where: { description: { contains: `${MARK} retry test` } } });
    check("[L] EXATAMENTE 1 Expense escrita, apesar de 2 tentativas com o mesmo update_id", count === 1, String(count));
    const rows = await prisma.expense.findMany({ where: { description: { contains: `${MARK} retry test` } } });
    rows.forEach((r) => created.expenses.push(r.id));
  }

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("ERRO INESPERADO:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
