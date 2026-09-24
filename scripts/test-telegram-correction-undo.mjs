// Fase 7D.1, item 1 — Corrigir/Desfazer, cobertura completa A-I. Usa
// SEMPRE correctionService (applyGuardedCorrection/applyGuardedDelete/
// undoAudit) via o menu determinístico — nunca Prisma update/delete cru.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_CORR";
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
let uid = 870000000;
async function runText(text, chatId, updateId) {
  return prisma.$transaction(async (tx) => {
    const id = updateId ?? uid++;
    const claim = await claimTelegramUpdateInTx(tx, id, { senderId: "test", chatId });
    if (!claim.claimed) return { duplicate: true, outbox: [] };
    const outbox = [];
    await dispatchUpdate({ update_id: id, message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return { duplicate: false, outbox };
  }, { timeout: 20000 });
}
async function runCallback(data, chatId, updateId) {
  return prisma.$transaction(async (tx) => {
    const id = updateId ?? uid++;
    const claim = await claimTelegramUpdateInTx(tx, id, { senderId: "test", chatId });
    if (!claim.claimed) return { duplicate: true, outbox: [] };
    const outbox = [];
    await dispatchUpdate({ update_id: id, callback_query: { id: `c${id}`, data, from: { id: 1 }, message: { message_id: 1, chat: { id: chatId, type: "private" } } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return { duplicate: false, outbox };
  }, { timeout: 20000 });
}
function lastText(outbox) {
  const last = outbox[outbox.length - 1];
  return last?.args?.[last.type === "editMessageText" ? 2 : 1] || "";
}

async function fingerprint() {
  const [expense, audit] = await Promise.all([prisma.expense.count(), prisma.telegramCorrectionAudit.count()]);
  return { expense, audit };
}

const created = { expenses: [] };
async function makeExpense(description, amount) {
  const account = await prisma.account.findFirst({ where: { type: "checking" } });
  const e = await prisma.expense.create({ data: { amount, description, category: "Outros", accountId: account.id, source: "telegram", confidence: "CONFIRMED", rawMessage: "fixture" } });
  created.expenses.push(e.id);
  return e;
}

async function cleanup() {
  for (const id of created.expenses) {
    await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: id } }).catch(() => {});
    await prisma.expense.delete({ where: { id } }).catch(() => {});
  }
  const stray = await prisma.expense.findMany({ where: { description: { contains: MARK } } });
  for (const e of stray) {
    await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: e.id } }).catch(() => {});
    await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
  }
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function main() {
  // A. Corrigir VALOR.
  {
    const chatId = `${MARK}_A`;
    const exp = await makeExpense(`${MARK} gasolina A`, 50);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:f:expense:${exp.id}:amount`, chatId);
    const askText = lastSentTextFor(chatId);
    check("[A] pergunta o novo valor", askText.toLowerCase().includes("valor"), askText);
    await runText("75,50", chatId);
    const preview = lastSentTextFor(chatId);
    check("[A] preview mostra diff de valor (de X pra Y)", preview.includes("50") && preview.includes("75,5"), preview);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.expense.findUnique({ where: { id: exp.id } });
    check("[A] valor corrigido via applyGuardedCorrection (Expense real atualizada)", Number(updated.amount) === 75.5);
    const audit = await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: exp.id, action: "correct" }, orderBy: { createdAt: "desc" } });
    check("[A] auditoria (TelegramCorrectionAudit) gravada com preimage", audit != null && audit.preimage.amount != null, JSON.stringify(audit));
  }

  // B. Corrigir DESCRIÇÃO.
  {
    const chatId = `${MARK}_B`;
    const exp = await makeExpense(`${MARK} original B`, 30);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:f:expense:${exp.id}:description`, chatId);
    await runText(`${MARK} corrigida B`, chatId);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.expense.findUnique({ where: { id: exp.id } });
    check("[B] descrição corrigida", updated.description === `${MARK} corrigida B`, updated.description);
  }

  // C. Corrigir DATA.
  {
    const chatId = `${MARK}_C`;
    const exp = await makeExpense(`${MARK} data C`, 20);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:f:expense:${exp.id}:date`, chatId);
    await runText("10/03/2026", chatId);
    await runCallback("confirm:yes", chatId);
    const updated = await prisma.expense.findUnique({ where: { id: exp.id } });
    check("[C] data corrigida pra 2026-03-10", updated.occurredAt.toISOString().slice(0, 10) === "2026-03-10", updated.occurredAt);
  }

  // D. EXCLUIR.
  let deletedAuditId = null;
  {
    const chatId = `${MARK}_D`;
    const exp = await makeExpense(`${MARK} deletar D`, 40);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:delask:expense:${exp.id}`, chatId);
    const delResult = await runCallback(`cor:delyes:expense:${exp.id}`, chatId);
    const stillThere = await prisma.expense.findUnique({ where: { id: exp.id } });
    check("[D] Expense realmente excluída", stillThere == null);
    const audit = await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: exp.id, action: "delete" }, orderBy: { createdAt: "desc" } });
    check("[D] auditoria de exclusão gravada com preimage completo", audit != null && audit.preimage.description === `${MARK} deletar D`);
    deletedAuditId = audit?.id;
    const undoText = lastText(delResult.outbox);
    check("[D] resposta oferece Desfazer", undoText.includes("Excluído"), undoText);
  }

  // E. Desfazer EXCLUSÃO (usa o auditId real do caso D).
  {
    const chatId = `${MARK}_E`;
    await runCallback(`cor:undoyes:${deletedAuditId}`, chatId);
    const recreated = await prisma.expense.findFirst({ where: { description: `${MARK} deletar D` } });
    check("[E] Expense recriada com os mesmos dados (undo_delete)", recreated != null && Number(recreated.amount) === 40, JSON.stringify(recreated));
    if (recreated) created.expenses.push(recreated.id);
    const undoAudit = await prisma.telegramCorrectionAudit.findFirst({ where: { undoesAuditId: deletedAuditId } });
    check("[E] nova linha de auditoria undo_delete gravada, vinculada à original", undoAudit != null && undoAudit.action === "undo_delete");
  }

  // F. Desfazer CORREÇÃO (usa o registro do caso A, já corrigido pra 75.50).
  {
    const chatId = `${MARK}_F`;
    // Reaproveita o Expense do caso A, já corrigido de 50 -> 75.50 lá.
    const target = await prisma.expense.findFirst({ where: { amount: 75.5 } });
    check("[F] achou o Expense corrigido no caso A pra desfazer", target != null);
    if (target) {
      const auditForTarget = await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: target.id, action: "correct" }, orderBy: { createdAt: "desc" } });
      await runCallback(`cor:undoyes:${auditForTarget.id}`, chatId);
      const reverted = await prisma.expense.findUnique({ where: { id: target.id } });
      check("[F] valor voltou ao original (50) depois de desfazer a correção", Number(reverted.amount) === 50, reverted.amount.toString());
      const undoAudit = await prisma.telegramCorrectionAudit.findFirst({ where: { undoesAuditId: auditForTarget.id } });
      check("[F] nova linha de auditoria undo_correct gravada", undoAudit != null && undoAudit.action === "undo_correct");
    }
  }

  // G. STALE OBJECT — corrigir um registro que mudou desde que o preview foi mostrado.
  {
    const chatId = `${MARK}_G`;
    const exp = await makeExpense(`${MARK} stale G`, 60);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:f:expense:${exp.id}:amount`, chatId);
    await runText("100", chatId); // monta o preview com expectedUpdatedAt = updatedAt ORIGINAL.
    // Simula concorrência: outro processo mudou o registro ANTES da confirmação.
    await prisma.expense.update({ where: { id: exp.id }, data: { description: `${MARK} mudou por fora` } });
    const fpBefore = await fingerprint();
    const confirmResult = await runCallback("confirm:yes", chatId);
    const fpAfter = await fingerprint();
    const stillOld = await prisma.expense.findUnique({ where: { id: exp.id } });
    check("[G] correção REJEITADA (stale) — valor NUNCA foi de 60 pra 100", Number(stillOld.amount) === 60, stillOld.amount.toString());
    check("[G] nenhuma auditoria nova de 'correct' foi criada pro registro stale", fpAfter.audit === fpBefore.audit);
    const msg = lastText(confirmResult.outbox);
    check("[G] resposta explica que o registro mudou (nunca um erro genérico)", msg.toLowerCase().includes("mudou"), msg);
  }

  // H. ITEM NÃO SUPORTADO — Purchase (compra parcelada) aparece na lista mas
  // é recusado explicitamente (fail closed), nunca um Prisma update/delete cru.
  {
    const chatId = `${MARK}_H`;
    const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
    const purchase = await prisma.purchase.create({ data: { description: `${MARK} compra H`, totalAmount: 100, installmentCount: 2, installmentValue: 50, category: "Outros", cardId: card.id, firstInstallmentMonth: "2026-01", source: "telegram" } });
    const unsupResult = await runCallback(`cor:unsupported:purchase:${purchase.id}`, chatId);
    const msg = lastText(unsupResult.outbox);
    check("[H] recusa explícita (fail closed), nunca tenta editar/excluir", msg.toLowerCase().includes("não pode") || msg.toLowerCase().includes("site"), msg);
    const stillThere = await prisma.purchase.findUnique({ where: { id: purchase.id } });
    check("[H] Purchase NUNCA foi tocada", stillThere != null && stillThere.description === `${MARK} compra H`);
    await prisma.purchase.delete({ where: { id: purchase.id } });
  }

  // I. Callback repetido / idempotência — mesmo update_id da confirmação enviado 2x.
  {
    const chatId = `${MARK}_I`;
    const exp = await makeExpense(`${MARK} idem I`, 15);
    await runCallback(`cor:pick:expense:${exp.id}`, chatId);
    await runCallback(`cor:f:expense:${exp.id}:amount`, chatId);
    await runText("22", chatId);
    const fixedUpdateId = uid++;
    const r1 = await runCallback("confirm:yes", chatId, fixedUpdateId);
    const r2 = await runCallback("confirm:yes", chatId, fixedUpdateId);
    check("[I] retry do MESMO update_id nunca reprocessa (duplicate)", r1.duplicate === false && r2.duplicate === true);
    const audits = await prisma.telegramCorrectionAudit.findMany({ where: { recordId: exp.id, action: "correct" } });
    check("[I] EXATAMENTE 1 auditoria de correção, apesar do retry", audits.length === 1, JSON.stringify(audits.length));
  }

  const fpFinal = await fingerprint();
  console.log("\nfingerprint final (referência):", JSON.stringify(fpFinal));
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("💥 Erro:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
