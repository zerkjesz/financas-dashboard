// Fase 5.3C.1 — TELEGRAM TRUST + DURABLE IDEMPOTENCY. Duas partes:
//   1) testes PUROS de lib/telegramIdempotency.js (claim/complete/fail) —
//      só banco (rows não-financeiras, TelegramUpdateReceipt), sem HTTP.
//   2) testes de INTEGRAÇÃO HTTP contra o dev server real (BASE_URL) —
//      exercita sender auth + private-chat policy + idempotência de ponta a
//      ponta através de app/api/telegram/webhook/route.js.
//
// SEGURANÇA CONTRA ESCRITA FINANCEIRA REAL: todo update de teste que precisa
// "passar" pela autorização usa uma mensagem SEM `text` (só chat/from) — o
// handler (lib/telegramUpdateHandler.js:dispatchUpdate) retorna sem fazer
// nada quando não há texto, ANTES de qualquer chamada a
// processTelegramMessage/commitBotIntent. Isso prova que o update passou
// pelos gates (sender/chat/idempotência) sem arriscar nenhuma mutação
// financeira real — a resposta JSON `{ok:true, status:"processed"}` é a
// prova, não uma Expense/Income criada.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { claimTelegramUpdate, completeTelegramUpdate, failTelegramUpdate } from "../lib/telegramIdempotency.js";

const BASE_URL = process.env.SECURITY_TEST_BASE_URL || "http://localhost:3001";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment",
  "cardLimitUpdate", "purchase", "installment", "cardBill", "recurringRule",
  "bill", "goal", "reserve", "reserveMovement", "externalInstallmentPlan",
  "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "cardCreditMovement", "appSettings",
];
async function financialFingerprint() {
  const counts = {};
  for (const model of FINANCIAL_MODELS) counts[model] = await prisma[model].count();
  return counts;
}
function fingerprintsEqual(a, b) {
  return FINANCIAL_MODELS.every((m) => a[m] === b[m]);
}

// update_id fictícios — janela alta pra nunca colidir com updates reais do
// Telegram (que hoje estão numa faixa completamente diferente), e um offset
// aleatório por EXECUÇÃO do script (Date.now()) pra nunca colidir com a
// execução anterior mesmo que o cleanup abaixo falhe por algum motivo —
// cada rodada do teste usa update_ids nunca-antes-vistos de verdade.
const FAKE_UPDATE_BASE = 987_650_000_000 + Date.now();
let fakeUpdateCounter = 0;
const usedUpdateIds = [];
function nextFakeUpdateId() {
  const id = FAKE_UPDATE_BASE + fakeUpdateCounter++;
  usedUpdateIds.push(id);
  return id;
}

async function cleanupReceipt(updateId) {
  await prisma.telegramUpdateReceipt.deleteMany({ where: { updateId: BigInt(updateId) } });
}

async function serverReachable() {
  try {
    const res = await fetch(BASE_URL, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

function fakeUpdate({ updateId, senderId, chatType = "private", text }) {
  const update = { update_id: updateId, message: { chat: { id: senderId ?? 555, type: chatType }, text } };
  if (senderId != null) update.message.from = { id: senderId };
  if (text === undefined) delete update.message.text; // simula update SEM texto — nunca dispara mutação financeira.
  return update;
}

async function postWebhook(update) {
  const res = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...body };
}

async function main() {
  console.log(`--- Fase 5.3C.1: Telegram trust + durable idempotency ---\n`);

  // ==========================================================================
  // PARTE 1 — testes puros de lib/telegramIdempotency.js (sem HTTP)
  // ==========================================================================
  console.log("--- Parte 1: claim/complete/fail (puro, banco de rows não-financeiras) ---");

  const id1 = nextFakeUpdateId();
  const firstClaim = await claimTelegramUpdate(id1, { senderId: "111", chatId: "111" });
  check(firstClaim.claimed === true, "[G] primeiro claim de um update_id nunca-visto -> claimed=true");

  const retryClaim = await claimTelegramUpdate(id1, { senderId: "111", chatId: "111" });
  check(retryClaim.claimed === false && retryClaim.reason === "IN_PROGRESS", "[H] retry sequencial do MESMO update_id (ainda dentro do lease) -> IN_PROGRESS, nunca reclama de novo");

  await completeTelegramUpdate(firstClaim.receiptId);
  const afterComplete = await claimTelegramUpdate(id1, { senderId: "111", chatId: "111" });
  check(afterComplete.claimed === false && afterComplete.reason === "ALREADY_COMPLETED", "[L] update completado -> claim subsequente vê ALREADY_COMPLETED (receipt durável no banco)");
  const receiptRow = await prisma.telegramUpdateReceipt.findUnique({ where: { updateId: BigInt(id1) } });
  check(receiptRow?.status === "COMPLETED" && receiptRow?.completedAt != null, "[L] row no banco confirma status=COMPLETED + completedAt setado");
  await cleanupReceipt(id1);

  // [I] concorrência real: 2 claims em paralelo pro MESMO update_id nunca-visto.
  const id2 = nextFakeUpdateId();
  const [claimA, claimB] = await Promise.all([
    claimTelegramUpdate(id2, { senderId: "222", chatId: "222" }),
    claimTelegramUpdate(id2, { senderId: "222", chatId: "222" }),
  ]);
  const claimedCount = [claimA, claimB].filter((c) => c.claimed).length;
  check(claimedCount === 1, "[I] 2 claims CONCORRENTES do mesmo update_id -> exatamente 1 vence (constraint UNIQUE do banco, não uma corrida de memória)");
  await cleanupReceipt(id2);

  // [J] update_ids DIFERENTES nunca são tratados como duplicata um do outro.
  const id3 = nextFakeUpdateId();
  const id4 = nextFakeUpdateId();
  const claimId3 = await claimTelegramUpdate(id3, { senderId: "333", chatId: "333" });
  const claimId4 = await claimTelegramUpdate(id4, { senderId: "333", chatId: "333" });
  check(claimId3.claimed && claimId4.claimed, "[J] update_id diferentes (mesmo sender/chat) -> ambos reivindicados, tratados como eventos separados");
  await cleanupReceipt(id3);
  await cleanupReceipt(id4);

  // [K] falha ANTES do commit -> permite retry (nunca fica bloqueado pra sempre).
  const id5 = nextFakeUpdateId();
  const claimToFail = await claimTelegramUpdate(id5, { senderId: "444", chatId: "444" });
  check(claimToFail.claimed === true, "[K] claim inicial ok (setup)");
  await failTelegramUpdate(claimToFail.receiptId);
  const retryAfterFail = await claimTelegramUpdate(id5, { senderId: "444", chatId: "444" });
  check(retryAfterFail.claimed === true, "[K] após failTelegramUpdate, um novo claim do MESMO update_id é aceito (retry seguro, nunca travado permanentemente)");
  await cleanupReceipt(id5);

  // [M] "restart" — a claim state vive no BANCO, não em memória do processo
  // deste script. Prova estrutural: nenhuma variável em memória é
  // compartilhada entre os 2 claims abaixo além do módulo importado (que não
  // guarda estado nenhum — lib/telegramIdempotency.js não tem nenhuma
  // variável de módulo tipo Set/Map). O SEGUNDO claim só pode saber do
  // primeiro através da row persistida no Postgres.
  const id6 = nextFakeUpdateId();
  await claimTelegramUpdate(id6, { senderId: "555", chatId: "555" });
  const rowAfterFirstClaim = await prisma.telegramUpdateReceipt.findUnique({ where: { updateId: BigInt(id6) } });
  check(rowAfterFirstClaim != null, "[M] claim persiste como row real no Postgres (não numa variável de processo)");
  const secondClaimDurable = await claimTelegramUpdate(id6, { senderId: "555", chatId: "555" });
  check(secondClaimDurable.claimed === false, "[M] um 'processo' novo (nova chamada, sem estado de memória compartilhado) vê o claim durável via banco, não reprocessa");
  await cleanupReceipt(id6);

  // ==========================================================================
  // PARTE 2 — integração HTTP (sender auth + private-chat + idempotência)
  // ==========================================================================
  if (!WEBHOOK_SECRET || !ALLOWED_USER_ID) {
    console.log("\n⚠️  TELEGRAM_WEBHOOK_SECRET/TELEGRAM_ALLOWED_USER_ID não configurados neste .env — pulando Parte 2 (integração HTTP).");
  } else if (!(await serverReachable())) {
    console.log(`\n⚠️  Servidor não acessível em ${BASE_URL} — pulando Parte 2 (integração HTTP). Suba o dev server pra rodar esta parte.`);
  } else {
    console.log("\n--- Parte 2: integração HTTP contra o webhook real ---");
    const before = await financialFingerprint();
    const allowedUserIdNum = Number(ALLOWED_USER_ID);
    const wrongUserId = allowedUserIdNum + 1;

    // [A] secret correto + sender autorizado + chat privado -> processed.
    const idA = nextFakeUpdateId();
    const resA = await postWebhook(fakeUpdate({ updateId: idA, senderId: allowedUserIdNum, chatType: "private" }));
    check(resA.status === "processed", "[A] secret correto + sender autorizado (private) -> status=processed", `status=${resA.status}`);

    // [B] secret correto + sender ERRADO -> rejeitado, nunca chega no dispatch.
    const idB = nextFakeUpdateId();
    const resB = await postWebhook(fakeUpdate({ updateId: idB, senderId: wrongUserId, chatType: "private" }));
    check(resB.status === "rejected_unauthorized_sender", "[B] secret correto + sender ERRADO -> rejected_unauthorized_sender (nunca chega no classifier)", `status=${resB.status}`);

    // [C] sender autorizado, mas chat NÃO é privado -> rejeitado por policy.
    const idC = nextFakeUpdateId();
    const resC = await postWebhook(fakeUpdate({ updateId: idC, senderId: allowedUserIdNum, chatType: "group" }));
    check(resC.status === "rejected_non_private_chat", "[C] sender autorizado MAS chat.type=group -> rejected_non_private_chat", `status=${resC.status}`);

    // [D] sender ausente -> rejeitado (fail closed quando não dá pra identificar quem mandou).
    const idD = nextFakeUpdateId();
    const resD = await postWebhook(fakeUpdate({ updateId: idD, senderId: null, chatType: "private" }));
    check(resD.status === "rejected_missing_sender", "[D] update sem from.id -> rejected_missing_sender", `status=${resD.status}`);

    // [E] secret ERRADO + sender correto -> transport barra antes de qualquer outra checagem.
    const idE = nextFakeUpdateId();
    const resE = await fetch(`${BASE_URL}/api/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret-errado" },
      body: JSON.stringify(fakeUpdate({ updateId: idE, senderId: allowedUserIdNum, chatType: "private" })),
    });
    check(resE.status === 401, "[E] secret ERRADO + sender correto -> 401 (transporte é checado ANTES do sender)", `status=${resE.status}`);

    // [F] local bot (bot/telegram-bot.js) usa o MESMO lib/telegramUpdateHandler.js
    // que o webhook — verificado por leitura de código, não por subir um
    // processo de polling real contra a API do Telegram (fora do escopo de
    // um teste automatizado: exigiria rede real + token real). A prova de
    // paridade é arquitetural: os dois entrypoints chamam a mesma função.
    console.log("ℹ️  [F] local bot: mesma policy comprovada por code-sharing (lib/telegramUpdateHandler.js), não por processo de polling real — ver relatório.");

    // [G/H via HTTP] mesmo update_id repetido -> segunda chamada é duplicate.
    const idRepeat = nextFakeUpdateId();
    const first = await postWebhook(fakeUpdate({ updateId: idRepeat, senderId: allowedUserIdNum, chatType: "private" }));
    const second = await postWebhook(fakeUpdate({ updateId: idRepeat, senderId: allowedUserIdNum, chatType: "private" }));
    check(first.status === "processed", "[G] primeira entrega de um update_id -> processed");
    check(second.status === "duplicate_already_completed", "[H] segunda entrega do MESMO update_id (retry do Telegram) -> duplicate_already_completed, nunca reprocessado", `status=${second.status}`);

    // [I via HTTP] concorrência real: 2 requests HTTP simultâneos, mesmo update_id nunca-visto.
    const idConcurrent = nextFakeUpdateId();
    const [concA, concB] = await Promise.all([
      postWebhook(fakeUpdate({ updateId: idConcurrent, senderId: allowedUserIdNum, chatType: "private" })),
      postWebhook(fakeUpdate({ updateId: idConcurrent, senderId: allowedUserIdNum, chatType: "private" })),
    ]);
    const processedCount = [concA, concB].filter((r) => r.status === "processed").length;
    check(processedCount === 1, "[I] 2 requests HTTP concorrentes pro mesmo update_id -> exatamente 1 processed, o outro duplicate", `statuses=${concA.status},${concB.status}`);

    const after = await financialFingerprint();
    check(fingerprintsEqual(before, after), "[ZERO_FINANCIAL_WRITES] nenhum dos updates de teste (todos sem `text`) gerou qualquer mutação financeira — fingerprint idêntico");
  }

  // Cleanup: apaga todas as rows de TelegramUpdateReceipt criadas por este
  // script (não-financeiras, mas boa higiene — o teste deve ser
  // re-executável sem deixar resíduo).
  await prisma.telegramUpdateReceipt.deleteMany({ where: { updateId: { in: usedUpdateIds.map(BigInt) } } });
  const leftover = await prisma.telegramUpdateReceipt.count({ where: { updateId: { gte: BigInt(FAKE_UPDATE_BASE) } } });
  check(leftover === 0, "[cleanup] nenhuma TelegramUpdateReceipt de teste remanescente");

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
