// Fase 7D.1, itens 12, 13 e 15 — integridade de callbacks, padrão de outbox e
// idempotência/retry, contra transações REAIS (claim de update_id incluído):
//   - callback inválido / antigo (stale) / sem sessão => fail closed, ZERO
//     escrita, resposta segura (nunca silêncio, nunca exceção);
//   - clique duplicado (mesmo update_id, ou dois toques em updates
//     diferentes) => no máximo UMA escrita financeira;
//   - retry depois de uma transação que falhou/abortou => reprocessa uma vez,
//     nunca duplica;
//   - respostas de callbacks de MENU e o resultado final de qualquer commit
//     financeiro vão pelo OUTBOX (enviadas depois do commit) — nenhum
//     bypass direto pra API do Telegram;
//   - o código do menu/wizard não importa nenhum módulo de LLM.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();
process.env.TELEGRAM_AI_ENABLED = "false";

import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { sentMessages, sentTotal, lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_TG_INTEG";
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
let uid = 930000000;
class Crash extends Error {}

async function send(update, chatId, { updateId, crashAfter = false } = {}) {
  const id = updateId ?? uid++;
  const outbox = [];
  let dispatched;
  const sentBefore = sentTotal();
  const res = await prisma.$transaction(
    async (tx) => {
      const claim = await claimTelegramUpdateInTx(tx, id, { senderId: "test", chatId });
      if (!claim.claimed) return { duplicate: true };
      dispatched = await dispatchUpdate({ update_id: id, ...update }, chatId, { client: tx, outbox });
      await completeTelegramUpdateInTx(tx, claim.receiptId);
      if (crashAfter) throw new Crash("crash simulado depois do dispatch, antes do commit");
      return { duplicate: false };
    },
    { timeout: 20000 }
  );
  return { ...res, outbox, dispatched, direct: sentTotal() - sentBefore > 0 ? sentMessages.slice(-(sentTotal() - sentBefore)) : [] };
}
const text = (t, chatId, o) => send({ message: { text: t, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, o);
const click = (d, chatId, o) => send({ callback_query: { id: `cb${uid}`, data: d, from: { id: 1 }, message: { message_id: 1, chat: { id: chatId, type: "private" } } } }, chatId, o);
const lastOutboxText = (outbox) => {
  const last = [...outbox].reverse().find((o) => o.type === "sendMessage" || o.type === "editMessageText");
  return last ? (last.type === "sendMessage" ? last.args[1] : last.args[2]) : "";
};

const FIN = ["expense", "income", "transfer", "purchase", "installment", "balanceAdjustment", "cardBillReconciliation", "confirmedCommitment", "contingency", "receivable", "goal", "telegramCorrectionAudit"];
async function fp() {
  const c = await Promise.all(FIN.map((m) => prisma[m].count()));
  return Object.fromEntries(FIN.map((m, i) => [m, c[i]]));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function cleanup() {
  const strayP = await prisma.purchase.findMany({ where: { description: { contains: MARK } } });
  for (const p of strayP) {
    await prisma.installment.deleteMany({ where: { purchaseId: p.id } }).catch(() => {});
    await prisma.purchase.delete({ where: { id: p.id } }).catch(() => {});
  }
  await prisma.telegramCorrectionAudit.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  for (const m of ["expense", "transfer", "goal"]) {
    await prisma[m].deleteMany({ where: { OR: m === "goal" ? [{ name: { contains: MARK } }] : [{ description: { contains: MARK } }] } }).catch(() => {});
  }
  await prisma.confirmedCommitment.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { rawMessage: "assistente guiado", note: { contains: "Reconciliação" }, createdAt: { gte: START } } }).catch(() => {});
  await prisma.cardBillReconciliation.deleteMany({ where: { rawMessage: "assistente guiado", createdAt: { gte: START } } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
}
const START = new Date();

async function main() {
  // ===== 1. Callbacks inválidos: fail closed =====
  {
    const chatId = `${MARK}_invalid`;
    const before = await fp();
    const bad = ["zzz:1", "", "m:naoexiste", "w:naoexiste", "r:naoexiste", "h:naoexiste", "cor:pick:foo:bar", "cor:f:expense:x:hack", "cor:f:foo:x:amount", "cor:delyes:expense:naoexiste", "cor:undoyes:naoexiste", "cor:unsupported:zzz:1", "cat:Lazer", "confirm:yes", "editfield:valor", "editmenu:gasto", "acct:abc", "date:hoje", "pm:pix", "batch:review", "simreg", "cpay:x", "wiznav:cancel"];
    let threw = [];
    let silent = [];
    for (const data of bad) {
      try {
        const r = await click(data, chatId);
        if (!lastOutboxText(r.outbox) && r.direct.every((d) => !d.text)) silent.push(data);
      } catch (err) {
        threw.push(`${data}: ${err.message}`);
      }
    }
    check("[inválido] nenhum callback inválido lança exceção (nunca aborta o update)", threw.length === 0, threw.join("; "));
    check("[inválido] todo callback inválido recebe uma resposta segura (nunca silêncio)", silent.length === 0, silent.join(", "));
    check("[inválido] ZERO escrita financeira/auditoria em todos os inválidos", same(before, await fp()), JSON.stringify({ before, after: await fp() }));
    check("[inválido] nenhum wizard foi aberto por callback forjado", (await prisma.botWizardSession.findUnique({ where: { chatId } })) == null);
  }

  // ===== 2. Stale: botão antigo com o wizard num passo diferente =====
  {
    const chatId = `${MARK}_stale`;
    await click("w:gasto", chatId);
    await text("10", chatId);
    await text(`${MARK} stale`, chatId);
    await click("pm:pix", chatId);
    await click("cat:Lazer", chatId); // agora no passo "data"
    const s0 = await prisma.botWizardSession.findUnique({ where: { chatId } });
    const before = await fp();
    const r = await click("cat:Transporte", chatId); // botão antigo (passo já avançado)
    const s1 = await prisma.botWizardSession.findUnique({ where: { chatId } });
    check("[stale] botão de passo anterior => 'unhandled' (nenhuma ação)", r.dispatched?.callback === "unhandled", JSON.stringify(r.dispatched));
    check("[stale] estado do wizard INTACTO (categoria não mudou, passo igual)", s1.step === s0.step && s1.data.category === "Lazer", JSON.stringify(s1.data));
    check("[stale] resposta segura avisa que expirou", lastOutboxText(r.outbox).toLowerCase().includes("expirou"), lastOutboxText(r.outbox));
    check("[stale] zero escrita", same(before, await fp()));
    const r2 = await click("confirm:yes", chatId); // ainda no passo data: confirm:yes antigo/precoce
    check("[stale] confirm:yes antes de chegar ao preview NÃO grava", r2.dispatched?.callback === "unhandled" && same(before, await fp()));
    await prisma.botWizardSession.deleteMany({ where: { chatId } });
    const r3 = await click("confirm:yes", chatId); // sem sessão
    check("[stale] sem sessão: callback vira 'stale', zero escrita", r3.dispatched?.callback === "stale" && same(before, await fp()));
  }

  // ===== 3. Duplicado: mesmo update_id, e duplo toque (update_ids diferentes) =====
  {
    const chatId = `${MARK}_dup`;
    await click("w:gasto", chatId);
    await text("7", chatId);
    await text(`${MARK} dup`, chatId);
    await click("pm:pix", chatId);
    await click("cat:Lazer", chatId);
    await click("date:hoje", chatId);
    const before = await fp();
    const fixed = uid++;
    const a = await click("confirm:yes", chatId, { updateId: fixed });
    const b = await click("confirm:yes", chatId, { updateId: fixed });
    check("[duplicado] mesmo update_id: 1ª processa, 2ª é duplicate", a.duplicate === false && b.duplicate === true);
    const c = await click("confirm:yes", chatId); // duplo toque: OUTRO update_id
    const after = await fp();
    check("[duplicado] duplo toque (outro update_id) cai em 'stale' — nunca grava de novo", c.dispatched?.callback === "stale");
    check("[duplicado] EXATAMENTE 1 Expense no total", after.expense - before.expense === 1, JSON.stringify({ before, after }));
  }

  // ===== 4. Retry depois de transação abortada =====
  {
    const chatId = `${MARK}_retry`;
    await click("w:gasto", chatId);
    await text("8", chatId);
    await text(`${MARK} retry`, chatId);
    await click("pm:pix", chatId);
    await click("cat:Lazer", chatId);
    await click("date:hoje", chatId);
    const before = await fp();
    const fixed = uid++;
    let crashed = false;
    try {
      await click("confirm:yes", chatId, { updateId: fixed, crashAfter: true });
    } catch (err) {
      crashed = err instanceof Crash || /crash simulado/.test(String(err.message));
    }
    check("[retry] transação abortada de verdade (crash simulado propagou)", crashed);
    check("[retry] rollback: ZERO escrita e o wizard continua no preview", same(before, await fp()) && (await prisma.botWizardSession.findUnique({ where: { chatId } }))?.step === "confirmar");
    const receipt = await prisma.telegramUpdateReceipt.findUnique({ where: { updateId: BigInt(fixed) } });
    check("[retry] o claim do update_id também foi revertido (Telegram pode reentregar)", receipt == null);
    const again = await click("confirm:yes", chatId, { updateId: fixed }); // retry do MESMO update_id
    check("[retry] reentrega do mesmo update_id processa normalmente", again.duplicate === false);
    const third = await click("confirm:yes", chatId, { updateId: fixed });
    const after = await fp();
    check("[retry] nova reentrega vira duplicate", third.duplicate === true);
    check("[retry] EXATAMENTE 1 Expense depois de crash + retry + reentrega", after.expense - before.expense === 1, JSON.stringify({ before, after }));
  }

  // ===== 5. Outbox: nenhum bypass direto pra API do Telegram =====
  {
    const chatId = `${MARK}_outbox`;
    const account = await prisma.account.findFirst({ where: { type: "checking" } });
    const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

    // callbacks de MENU/leitura: só outbox.
    for (const d of ["m:root", "m:consultar", "r:summary", "r:balance", "h:despesa", "cor:list", "cor:recentes", "cor:undolast"]) {
      const r = await click(d, chatId);
      check(`[outbox] ${d}: resposta via outbox, zero chamada direta à API`, r.direct.length === 0 && lastOutboxText(r.outbox).length > 0, `direct=${r.direct.length}`);
    }

    // commit financeiro final de cada wizard: resposta só via outbox (deferredReply).
    const flows = {
      despesa: async () => { await click("w:gasto", chatId); await text("5", chatId); await text(`${MARK} o1`, chatId); await click("pm:pix", chatId); await click("cat:Lazer", chatId); await click("date:hoje", chatId); },
      parcelado: async () => { await click("w:parcela", chatId); await text("90", chatId); await text(`${MARK} o2`, chatId); await click("skip:merchant", chatId); await click("qtd:3", chatId); await click("cat:Outros", chatId); await click("date:hoje", chatId); },
      transferencia: async () => { await click("w:transferencia", chatId); await text("6", chatId); await click(`acct:${accounts[0].id}`, chatId); await click(`acct:${accounts[1].id}`, chatId); await text(`${MARK} o3`, chatId); await click("date:hoje", chatId); },
      saldo: async () => { await click("w:saldo_itau", chatId); await text("1234,56", chatId); },
      fatura: async () => { await click("w:fatura_atual", chatId); await text("321,00", chatId); },
      lote: async () => { await click("w:multipla", chatId); await click("batch:add:despesa", chatId); await text("3", chatId); await text(`${MARK} o4`, chatId); await click("bpm:pix", chatId); await click("batch:review", chatId); },
      meta: async () => { await click("w:meta_nova", chatId); await text(`${MARK} meta`, chatId); await text("500", chatId); },
    };
    for (const [name, prepare] of Object.entries(flows)) {
      await prepare();
      const r = await click("confirm:yes", chatId);
      check(`[outbox] commit final de "${name}": resposta SÓ via outbox (deferredReply), nenhuma chamada direta`, r.direct.length === 0 && lastOutboxText(r.outbox).includes("✅"), `direct=${r.direct.length} reply=${lastOutboxText(r.outbox)}`);
    }

    // correção + exclusão + desfazer (stateless e wizard).
    const exp = await prisma.expense.findFirst({ where: { description: `${MARK} o1` } });
    await click(`cor:f:expense:${exp.id}:amount`, chatId);
    await text("9,90", chatId);
    const rc = await click("confirm:yes", chatId);
    check("[outbox] commit da correção: só outbox", rc.direct.length === 0 && lastOutboxText(rc.outbox).includes("Corrigido"), lastOutboxText(rc.outbox));
    const rd = await click(`cor:delyes:expense:${exp.id}`, chatId);
    check("[outbox] exclusão: só outbox", rd.direct.length === 0 && lastOutboxText(rd.outbox).includes("Excluído"));
    const audit = await prisma.telegramCorrectionAudit.findFirst({ where: { recordId: exp.id, action: "delete" } });
    const ru = await click(`cor:undoyes:${audit.id}`, chatId);
    check("[outbox] desfazer exclusão: só outbox", ru.direct.length === 0 && lastOutboxText(ru.outbox).includes("desfeita"));
  }

  // ===== 6. Independência de LLM no código do menu/wizard =====
  {
    const FORBIDDEN = /telegramAi\/(llmProvider|pipeline|semanticInterpreter|promptBuilder|groqStrictSchema|planExecutor|planValidator|financialIntentPlanSchema|conversationContext)|groq|anthropic|openai/i;
    for (const file of ["lib/telegramMenu.js", "lib/botWizard.js", "lib/commitBotIntent.js", "lib/telegramApi.js"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const imports = src.split("\n").filter((l) => /^\s*(import\s|.*await import\()/.test(l));
      const bad = imports.filter((l) => FORBIDDEN.test(l));
      check(`[LLM] ${file}: nenhum import de provider/pipeline/schema de IA`, bad.length === 0, bad.join(" | "));
    }
    const menuSrc = readFileSync(new URL("../lib/telegramMenu.js", import.meta.url), "utf8");
    const directCalls = (menuSrc.match(/\b(sendMessage|editMessageText)\(/g) || []).length;
    check("[outbox] telegramMenu.js só chama a API direto no fallback documentado (sem outbox)", directCalls <= 2, `chamadas diretas encontradas: ${directCalls}`);
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
