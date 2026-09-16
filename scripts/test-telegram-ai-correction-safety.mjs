// Fase 7.0.1, item 3 — correção/exclusão de um registro JÁ APLICADO precisa
// passar por preview+confirmação, guard de estado obsoleto, trilha de
// auditoria e undo real — nunca um update/delete Prisma bruto e direto.
//
//   node scripts/test-telegram-ai-correction-safety.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { createMockProvider } from "../lib/telegramAi/llmProvider.js";
import { handleConversationalMessage, PIPELINE_RESULT_KIND } from "../lib/telegramAi/pipeline.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";

const MARK = "TESTE_TG_AI_CORR";
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

const createdExpenseIds = [];
let updateIdCounter = 950000000;

async function cleanup() {
  for (const id of createdExpenseIds) await prisma.expense.delete({ where: { id } }).catch(() => {});
  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  const stray = await prisma.expense.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const e of stray) await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
}

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
    { timeout: 20000 }
  );
}

function jsonReply(obj) {
  return JSON.stringify(obj);
}

async function main() {
  const acct = await prisma.account.findFirst({ where: { type: "checking" } });
  if (!acct) {
    check("[pré] existe conta checking real", false);
    return;
  }

  // ==========================================================================
  // A) CORRECTION SUCCESS — preview mostra o diff, "sim" aplica, audit trail
  //    guarda a pré-imagem.
  // ==========================================================================
  let correctionTargetId;
  {
    const chatId = `${MARK}_A`;
    const expense = await prisma.expense.create({ data: { amount: "80.00", description: `${MARK} mercado`, category: "Alimentação", accountId: acct.id, occurredAt: new Date(), source: "telegram_ai", rawMessage: `${MARK} gastei 80 no mercado` } });
    correctionTargetId = expense.id;
    createdExpenseIds.push(expense.id);
    const updatedAtBefore = expense.updatedAt.toISOString();

    const correctionPlan = { kind: "financial_plan", actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "c1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: expense.id }, fieldChanges: { amount: "90.00" } }] };
    const provider = createMockProvider([[(p) => p.includes("na verdade foi 90"), () => jsonReply(correctionPlan)]]);
    const preview = await runMessage(`${MARK} na verdade foi 90`, chatId, { provider });
    check("[A] preview mostra o diff (de 80 pra 90) ANTES de aplicar, nunca aplica direto", preview.kind === PIPELINE_RESULT_KIND.REPLY && /80,00/.test(preview.reply) && /90,00/.test(preview.reply) && /[Cc]onfirma/.test(preview.reply), preview.reply);
    const stillEighty = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[A] preview NÃO escreveu nada ainda (valor continua 80)", Number(stillEighty.amount) === 80);
    check("[A] updatedAt não mudou só de fazer o preview (preview é read-only)", stillEighty.updatedAt.toISOString() === updatedAtBefore);

    const confirmed = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[A] "sim" aplica a correção de verdade', confirmed.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmed.reply), confirmed.reply);
    const corrected = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[A] valor final é 90 (corrigido)", Number(corrected.amount) === 90);

    const audit = await prisma.telegramCorrectionAudit.findFirst({ where: { model: "expense", recordId: expense.id, action: "correct" } });
    check("[A] TelegramCorrectionAudit real criado com a PRÉ-IMAGEM completa (amount=80 antes da mudança)", !!audit && Number(audit.preimage.amount) === 80, JSON.stringify(audit));
    check("[A] audit guarda referência do chat e da mensagem que DISPAROU a correção (rastreabilidade)", audit.chatId === chatId && audit.rawMessage === `${MARK} na verdade foi 90`, JSON.stringify(audit));
  }

  // ==========================================================================
  // B) STALE CORRECTION — registro muda entre o preview e a confirmação
  //    (ex.: editado no dashboard nesse meio tempo) -> rejeitado, zero write.
  // ==========================================================================
  {
    const chatId = `${MARK}_B`;
    const expense = await prisma.expense.create({ data: { amount: "50.00", description: `${MARK} farmacia`, category: "Saúde", accountId: acct.id, occurredAt: new Date(), source: "telegram_ai", rawMessage: `${MARK} gastei 50 na farmacia` } });
    createdExpenseIds.push(expense.id);

    const correctionPlan = { kind: "financial_plan", actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "c1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: expense.id }, fieldChanges: { amount: "55.00" } }] };
    const provider = createMockProvider([[(p) => p.includes("foi 55"), () => jsonReply(correctionPlan)]]);
    const preview = await runMessage(`${MARK} foi 55`, chatId, { provider });
    check("[B] preview criado normalmente", preview.kind === PIPELINE_RESULT_KIND.REPLY);

    // Simula uma edição concorrente (ex.: alguém mexeu no dashboard) ENTRE o
    // preview e a confirmação — isso muda updatedAt.
    await new Promise((r) => setTimeout(r, 10));
    await prisma.expense.update({ where: { id: expense.id }, data: { description: `${MARK} farmacia (editado por fora)` } });

    const confirmed = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check("[B] confirmação de correção OBSOLETA é rejeitada, nunca aplica por cima", confirmed.kind === PIPELINE_RESULT_KIND.REPLY && /mudou desde/i.test(confirmed.reply), confirmed.reply);
    const stillFifty = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[B] valor continua 50 (correção obsoleta nunca foi aplicada)", Number(stillFifty.amount) === 50);
    const noAudit = await prisma.telegramCorrectionAudit.findFirst({ where: { model: "expense", recordId: expense.id, action: "correct" } });
    check("[B] nenhum audit de correção foi criado (nada foi de fato alterado)", !noAudit);
  }

  // ==========================================================================
  // C) DELETE + UNDO — apaga um registro (guardado/auditado), depois desfaz
  //    (recria com o MESMO id, via a trilha de auditoria).
  // ==========================================================================
  {
    const chatId = `${MARK}_C`;
    const expense = await prisma.expense.create({ data: { amount: "35.00", description: `${MARK} lanche`, category: "Alimentação", accountId: acct.id, occurredAt: new Date(), source: "telegram_ai", rawMessage: `${MARK} gastei 35 no lanche` } });
    const originalId = expense.id;

    const deletePlan = { kind: "financial_plan", actions: [{ type: "DELETE_OR_UNDO_PREVIOUS_ACTION", localId: "d1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: originalId } }] };
    const provider1 = createMockProvider([[(p) => p.includes("apaga o lanche"), () => jsonReply(deletePlan)]]);
    const preview = await runMessage(`${MARK} apaga o lanche`, chatId, { provider: provider1 });
    check("[C] preview de exclusão pede confirmação, nunca apaga direto", preview.kind === PIPELINE_RESULT_KIND.REPLY && /[Cc]onfirma/.test(preview.reply), preview.reply);
    const stillThere = await prisma.expense.findUnique({ where: { id: originalId } });
    check("[C] preview NÃO apagou nada ainda", !!stillThere);

    const confirmedDelete = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[C] "sim" apaga de verdade (guardado/auditado)', confirmedDelete.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmedDelete.reply), confirmedDelete.reply);
    const gone = await prisma.expense.findUnique({ where: { id: originalId } });
    check("[C] registro realmente foi apagado", !gone);
    const deleteAudit = await prisma.telegramCorrectionAudit.findFirst({ where: { model: "expense", recordId: originalId, action: "delete" } });
    check("[C] audit de delete guarda a pré-imagem completa (pra poder recriar)", !!deleteAudit && Number(deleteAudit.preimage.amount) === 35, JSON.stringify(deleteAudit));

    // Agora desfaz — mesma mensagem de "desfazer", mas como já existe um
    // audit de delete pra esse id, o sistema entende como UNDO, não como
    // "apagar de novo".
    const undoPlan = { kind: "financial_plan", actions: [{ type: "DELETE_OR_UNDO_PREVIOUS_ACTION", localId: "u1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: originalId } }] };
    const provider2 = createMockProvider([[(p) => p.includes("desfaz isso"), () => jsonReply(undoPlan)]]);
    const undoPreview = await runMessage(`${MARK} desfaz isso`, chatId, { provider: provider2 });
    check("[C] preview de UNDO reconhece que é um desfazer (não tenta apagar de novo algo que já não existe)", undoPreview.kind === PIPELINE_RESULT_KIND.REPLY && /desfazer/i.test(undoPreview.reply), undoPreview.reply);

    const confirmedUndo = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[C] "sim" desfaz de verdade — registro recriado', confirmedUndo.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmedUndo.reply), confirmedUndo.reply);
    const recreated = await prisma.expense.findUnique({ where: { id: originalId } });
    check("[C] registro recriado com o MESMO id e os MESMOS valores (lanche, 35.00)", !!recreated && Number(recreated.amount) === 35 && recreated.description === `${MARK} lanche`, JSON.stringify(recreated));
    if (recreated) createdExpenseIds.push(recreated.id);

    const undoAuditRow = await prisma.telegramCorrectionAudit.findFirst({ where: { model: "expense", recordId: originalId, action: "undo_delete" } });
    check("[C] audit de undo_delete criado, referenciando o audit original (undoesAuditId)", !!undoAuditRow && undoAuditRow.undoesAuditId === deleteAudit.id, JSON.stringify(undoAuditRow));
  }

  // ==========================================================================
  // D) UNDO CORRECTION — desfaz uma correção (reverte o campo, sem apagar o registro).
  // ==========================================================================
  {
    const chatId = `${MARK}_D`;
    const expense = await prisma.expense.create({ data: { amount: "20.00", description: `${MARK} cafe`, category: "Alimentação", accountId: acct.id, occurredAt: new Date(), source: "telegram_ai", rawMessage: `${MARK} gastei 20 no cafe` } });
    createdExpenseIds.push(expense.id);

    const correctionPlan = { kind: "financial_plan", actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "c1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: expense.id }, fieldChanges: { amount: "25.00" } }] };
    const provider1 = createMockProvider([[(p) => p.includes("foi 25"), () => jsonReply(correctionPlan)]]);
    await runMessage(`${MARK} foi 25`, chatId, { provider: provider1 });
    await runMessage("sim", chatId, { provider: createMockProvider([]) });
    const corrected = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[D] correção aplicada primeiro (valor = 25)", Number(corrected.amount) === 25);

    const undoPlan = { kind: "financial_plan", actions: [{ type: "DELETE_OR_UNDO_PREVIOUS_ACTION", localId: "u1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: expense.id } }] };
    const provider2 = createMockProvider([[(p) => p.includes("desfaz essa correção"), () => jsonReply(undoPlan)]]);
    const undoPreview = await runMessage(`${MARK} desfaz essa correção`, chatId, { provider: provider2 });
    check("[D] preview reconhece que existe uma correção recente pra desfazer", undoPreview.kind === PIPELINE_RESULT_KIND.REPLY && /correção/i.test(undoPreview.reply), undoPreview.reply);

    const confirmedUndo = await runMessage("sim", chatId, { provider: createMockProvider([]) });
    check('[D] "sim" reverte o valor de volta (25 -> 20), SEM apagar o registro', confirmedUndo.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(confirmedUndo.reply), confirmedUndo.reply);
    const reverted = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[D] valor voltou pro original (20), registro continua existindo com o MESMO id", !!reverted && Number(reverted.amount) === 20, JSON.stringify(reverted));
  }

  // ==========================================================================
  // E) RETRY / IDEMPOTENCY — confirmar a mesma correção duas vezes com o
  //    MESMO update_id do Telegram nunca aplica duas vezes.
  // ==========================================================================
  {
    const chatId = `${MARK}_E`;
    const expense = await prisma.expense.create({ data: { amount: "10.00", description: `${MARK} retry corr`, category: "Outros", accountId: acct.id, occurredAt: new Date(), source: "telegram_ai", rawMessage: `${MARK} gastei 10` } });
    createdExpenseIds.push(expense.id);

    const correctionPlan = { kind: "financial_plan", actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "c1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: expense.id }, fieldChanges: { amount: "15.00" } }] };
    const provider = createMockProvider([[(p) => p.includes("retry corr foi 15"), () => jsonReply(correctionPlan)]]);
    await runMessage(`${MARK} retry corr foi 15`, chatId, { provider });

    const updateId = ++updateIdCounter;
    const first = await runMessage("sim", chatId, { provider: createMockProvider([]), updateId });
    check("[E] primeira confirmação aplica normalmente", first.kind === PIPELINE_RESULT_KIND.REPLY && /✅/.test(first.reply));
    const second = await runMessage("sim", chatId, { provider: createMockProvider([]), updateId });
    check("[E] segunda tentativa com o MESMO update_id é bloqueada pela idempotência", second.kind === "duplicate_skipped", JSON.stringify(second));

    const audits = await prisma.telegramCorrectionAudit.findMany({ where: { model: "expense", recordId: expense.id, action: "correct" } });
    check("[E] EXATAMENTE 1 audit de correção, apesar de 2 tentativas com o mesmo update_id", audits.length === 1, String(audits.length));
    const final = await prisma.expense.findUnique({ where: { id: expense.id } });
    check("[E] valor final é 15 (aplicado só uma vez)", Number(final.amount) === 15);
  }

  // ==========================================================================
  // F) FAIL-CLOSED PRA MODEL NÃO SUPORTADO — nunca tenta corrigir/apagar
  //    fora de expense/income/transfer.
  // ==========================================================================
  {
    const chatId = `${MARK}_F`;
    const plan = { kind: "financial_plan", actions: [{ type: "DELETE_OR_UNDO_PREVIOUS_ACTION", localId: "d1", confidence: "HIGH", target: { kind: "applied_record", model: "confirmedCommitment", id: "algum-id-fake" } }] };
    const provider = createMockProvider([[(p) => p.includes("desfaz aquele compromisso"), () => jsonReply(plan)]]);
    const result = await runMessage(`${MARK} desfaz aquele compromisso`, chatId, { provider });
    check("[F] model não suportado -> resposta explícita de 'ainda não suportado', nunca tenta mexer", result.kind === PIPELINE_RESULT_KIND.REPLY && /ainda não sei/i.test(result.reply), result.reply);
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
