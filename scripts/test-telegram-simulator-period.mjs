// Fase 7D.1, itens 8 e 9 — Simulador → "🧾 Registrar essa compra" (E2E, à
// vista/cartão/parcelado, zero write até confirmar) e "Onde foi meu
// dinheiro?" com período personalizado (datas, limites inclusivos, fuso,
// zero write) + parser determinístico de datas do wizard.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";
import { quickDateISO, parseWizardDateText, computeCustomCategoryPeriod } from "../lib/botWizard.js";

const MARK = "TESTE_TG_SIM";
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
let uid = 920000000;
async function runText(text, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}
async function runCallback(data, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ callback_query: { id: `c${uid}`, data, from: { id: 1 }, message: { message_id: 1, chat: { id: chatId, type: "private" } } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 20000 });
}

const FIN = ["expense", "income", "transfer", "purchase", "installment", "balanceAdjustment", "cardBillReconciliation"];
async function fingerprint() {
  const c = await Promise.all(FIN.map((m) => prisma[m].count()));
  return Object.fromEntries(FIN.map((m, i) => [m, c[i]]));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const created = { purchases: [] };
async function cleanup() {
  for (const id of created.purchases) {
    await prisma.installment.deleteMany({ where: { purchaseId: id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id } }).catch(() => {});
  }
  const stray = await prisma.purchase.findMany({ where: { description: { contains: "Compra simulada" }, source: "telegram", rawMessage: "assistente guiado" } });
  for (const p of stray) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  await prisma.expense.deleteMany({ where: { rawMessage: "assistente guiado", description: { in: ["Compra simulada", `${MARK} periodo`] } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}

async function main() {
  // ===== 8. SIMULADOR -> REGISTRAR: à vista =====
  {
    const chatId = `${MARK}_avista`;
    const fp0 = await fingerprint();
    await runCallback("w:simulador", chatId);
    await runText("300", chatId);
    await runCallback("simmode:avista", chatId);
    await runCallback("simpm:cash", chatId);
    check("[sim à vista] resultado mostra simulação e não grava", (lastSentTextFor(chatId) || "").length > 0 && same(fp0, await fingerprint()));
    await runCallback("simreg", chatId);
    check("[sim à vista] registrar abre o wizard de despesa perguntando como pagou (zero write)", (lastSentTextFor(chatId) || "").toLowerCase().includes("como pagou") && same(fp0, await fingerprint()));
    await runCallback("pm:pix", chatId);
    await runCallback("cat:Lazer", chatId);
    await runCallback("date:hoje", chatId);
    const preview = lastSentTextFor(chatId) || "";
    check("[sim à vista] preview pré-preenchido com R$ 300,00", preview.includes("300,00"), preview);
    check("[sim à vista] antes de confirmar: ZERO write", same(fp0, await fingerprint()));
    await runCallback("confirm:yes", chatId);
    const fp1 = await fingerprint();
    check("[sim à vista] após confirmar: exatamente 1 Expense de 300", fp1.expense - fp0.expense === 1 && Number((await prisma.expense.findFirst({ where: { description: "Compra simulada" }, orderBy: { createdAt: "desc" } }))?.amount) === 300);
  }

  // ===== cartão à vista (CARD_PURCHASE_SINGLE) =====
  {
    const chatId = `${MARK}_cartao`;
    const fp0 = await fingerprint();
    await runCallback("w:simulador", chatId);
    await runText("150", chatId);
    await runCallback("simmode:avista", chatId);
    await runCallback("simpm:cartao", chatId);
    check("[sim cartão] simulação não grava", same(fp0, await fingerprint()));
    await runCallback("simreg", chatId);
    const preview = lastSentTextFor(chatId) || "";
    check("[sim cartão] registrar vai direto pro preview de compra no cartão (R$ 150,00, Cartão)", preview.includes("150,00") && preview.toLowerCase().includes("cart"), preview);
    check("[sim cartão] antes de confirmar: ZERO write", same(fp0, await fingerprint()));
    await runCallback("confirm:yes", chatId);
    const fp1 = await fingerprint();
    const exp = await prisma.expense.findFirst({ where: { description: "Compra simulada" }, orderBy: { createdAt: "desc" } });
    check("[sim cartão] após confirmar: 1 Expense com cardId (nunca conta)", fp1.expense - fp0.expense === 1 && exp.cardId != null && exp.accountId == null);
  }

  // ===== parcelado =====
  {
    const chatId = `${MARK}_parcelado`;
    const fp0 = await fingerprint();
    await runCallback("w:simulador", chatId);
    await runText("900", chatId);
    await runCallback("simmode:parcelado", chatId);
    await runCallback("simqtd:3", chatId);
    check("[sim parcelado] simulação não grava", same(fp0, await fingerprint()));
    await runCallback("simreg", chatId);
    const preview = lastSentTextFor(chatId) || "";
    check("[sim parcelado] registrar vai direto pro preview: 3x de R$ 300,00", preview.includes("3x de") && preview.includes("300,00") && preview.includes("900,00"), preview);
    check("[sim parcelado] antes de confirmar: ZERO write", same(fp0, await fingerprint()));
    await runCallback("confirm:yes", chatId);
    const fp1 = await fingerprint();
    check("[sim parcelado] após confirmar: 1 Purchase + 3 Installments (nunca Expense)", fp1.purchase - fp0.purchase === 1 && fp1.installment - fp0.installment === 3 && fp1.expense === fp0.expense);
    const purchase = await prisma.purchase.findFirst({ where: { description: "Compra simulada" }, orderBy: { createdAt: "desc" } });
    if (purchase) created.purchases.push(purchase.id);
  }

  // ===== 9. Parser de datas determinístico =====
  {
    const ref = new Date("2026-09-24T01:30:00.000Z"); // 22:30 de 23/09 no fuso do app (UTC-3)
    check("[datas] 'Hoje' às 22:30 locais é 23/09 (não o dia UTC seguinte)", quickDateISO("hoje", ref).startsWith("2026-09-23"), quickDateISO("hoje", ref));
    check("[datas] 'Ontem' às 22:30 locais é 22/09", quickDateISO("ontem", ref).startsWith("2026-09-22"), quickDateISO("ontem", ref));
    check("[datas] DD/MM/AAAA válido", parseWizardDateText("08/09/2026", ref).date?.toISOString().startsWith("2026-09-08"));
    check("[datas] DD/MM usa o ano corrente local", parseWizardDateText("05/03", ref).date?.toISOString().startsWith("2026-03-05"));
    check("[datas] AA de 2 dígitos", parseWizardDateText("1/2/26", ref).date?.toISOString().startsWith("2026-02-01"));
    check("[datas] 31/02 rejeitada", parseWizardDateText("31/02/2026", ref).ok === false);
    check("[datas] mês 13 rejeitado", parseWizardDateText("10/13/2026", ref).ok === false);
    check("[datas] texto solto rejeitado (nunca vira 'hoje')", parseWizardDateText("abacate", ref).ok === false);
    check("[datas] 'essa semana' rejeitada", parseWizardDateText("essa semana", ref).ok === false);
  }

  // ===== 9. Período personalizado E2E =====
  {
    const account = await prisma.account.findFirst({ where: { type: "checking" } });
    const mk = (desc, category, amount, iso) => prisma.expense.create({ data: { amount, description: `${MARK} ${desc}`, category, accountId: account.id, source: "telegram", confidence: "CONFIRMED", rawMessage: "fixture", occurredAt: new Date(iso) } });
    await mk("antes", "Alimentação", 1000, "2019-03-09T12:00:00.000Z"); // dia antes do início: fora
    await mk("inicio", "Alimentação", 100, "2019-03-10T00:00:00.000Z"); // exatamente no início: dentro
    await mk("meio", "Transporte", 50, "2019-03-15T12:00:00.000Z");
    await mk("fim-meio-dia", "Alimentação", 25, "2019-03-20T12:00:00.000Z"); // dia final ao meio-dia: dentro
    await mk("fim-noite", "Lazer", 10, "2019-03-20T23:30:00.000Z"); // dia final à noite: dentro
    await mk("depois", "Alimentação", 2000, "2019-03-21T00:00:00.000Z"); // dia seguinte: fora

    const chatId = `${MARK}_periodo`;
    const fp0 = await fingerprint();
    await runCallback("w:categoria_periodo", chatId);
    await runText("31/02/2019", chatId);
    check("[período] data inicial inválida rejeitada (continua em 'inicio')", (await prisma.botWizardSession.findUnique({ where: { chatId } }))?.step === "inicio");
    await runText("10/03/2019", chatId);
    await runText("09/03/2019", chatId);
    check("[período] data final antes da inicial rejeitada (continua em 'fim')", (await prisma.botWizardSession.findUnique({ where: { chatId } }))?.step === "fim");
    await runText("20/03/2019", chatId);
    const reply = lastSentTextFor(chatId) || "";
    check("[período] rótulo mostra o intervalo digitado", reply.includes("10/03/2019 a 20/03/2019"), reply);
    check("[período] total = 100+50+25+10 = 185 (limites inclusivos; antes/depois fora)", reply.includes("185,00") && !reply.includes("1.000") && !reply.includes("2.000"), reply);
    const flat = reply.replace(/\u00a0/g, " ");
    check("[período] categorias somadas: Alimentação 125, Transporte 50, Lazer 10", flat.includes("Alimentação: R$ 125,00") && flat.includes("Transporte: R$ 50,00") && flat.includes("Lazer: R$ 10,00"), reply);
    check("[período] wizard finalizado (sessão removida)", (await prisma.botWizardSession.findUnique({ where: { chatId } })) == null);
    const fp1 = await fingerprint();
    check("[período] ZERO write", same(fp0, fp1));

    const single = await computeCustomCategoryPeriod("2019-03-20", "2019-03-20");
    check("[período] intervalo de 1 dia (inicio=fim) inclui o dia inteiro", Math.round(single.grandTotal) === 35, String(single.grandTotal));
  }
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
