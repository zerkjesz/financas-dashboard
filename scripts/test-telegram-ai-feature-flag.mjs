// Fase 7.0.1, item 1 — prova o roteamento real de TELEGRAM_AI_ENABLED em
// lib/telegramUpdateHandler.js:dispatchUpdate (não só no pipeline isolado).
//
//   node scripts/test-telegram-ai-feature-flag.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { PROVIDER_UNAVAILABLE_MESSAGE } from "../lib/telegramAi/responseFormatter.js";

const MARK = "TESTE_TG_AI_FLAG";
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

async function cleanup() {
  for (const id of createdExpenseIds) await prisma.expense.delete({ where: { id } }).catch(() => {});
  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  const stray = await prisma.expense.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const e of stray) await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
}

async function runDispatch(text, chatId) {
  const outbox = [];
  const update = { message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } };
  await prisma.$transaction((tx) => dispatchUpdate(update, chatId, { client: tx, outbox }), { timeout: 20000 });
  return outbox;
}

async function main() {
  const originalFlag = process.env.TELEGRAM_AI_ENABLED;

  // ==========================================================================
  // TELEGRAM_AI_ENABLED=false (default seguro) — pipeline AI NUNCA chamado,
  // mensagem financeira simples é tratada 100% pelo parser legado.
  // ==========================================================================
  {
    process.env.TELEGRAM_AI_ENABLED = "false";
    const chatId = `${MARK}_off`;
    const outbox = await runDispatch(`${MARK} gastei 50 de gasolina no pix`, chatId);
    check("[flag=false] gerou alguma resposta (parser legado processou a mensagem)", outbox.length > 0, JSON.stringify(outbox));
    const reply = outbox[0]?.args?.[1] || "";
    check("[flag=false] resposta NÃO é a mensagem de segurança do pipeline AI (prova que ele nunca rodou)", reply !== PROVIDER_UNAVAILABLE_MESSAGE, reply);
    const expense = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} gastei 50 de gasolina` } } });
    check("[flag=false] Expense real foi criada PELO PARSER LEGADO (só ele grava sem provider — prova definitiva de que rodou)", !!expense, JSON.stringify(expense));
    if (expense) createdExpenseIds.push(expense.id);
    const aiPending = await prisma.pendingBotMessage.findUnique({ where: { chatId } });
    check("[flag=false] nenhum PendingBotMessage do pipeline AI foi criado", !aiPending || aiPending.intent !== "financial_ai_plan");
  }

  // ==========================================================================
  // TELEGRAM_AI_ENABLED=true + sem ANTHROPIC_API_KEY (ambiente real deste
  // DEV) — pipeline É chamado, mas devolve zero write + mensagem de
  // segurança, NUNCA cai pro parser legado (que criaria a Expense).
  // ==========================================================================
  {
    process.env.TELEGRAM_AI_ENABLED = "true";
    const chatId = `${MARK}_on_noprovider`;
    const outbox = await runDispatch(`${MARK} gastei 60 de gasolina no pix`, chatId);
    check("[flag=true, sem provider] resposta é EXATAMENTE a mensagem de segurança", outbox[0]?.args?.[1] === PROVIDER_UNAVAILABLE_MESSAGE, JSON.stringify(outbox));
    const expense = await prisma.expense.findFirst({ where: { rawMessage: { contains: `${MARK} gastei 60 de gasolina` } } });
    check("[flag=true, sem provider] ZERO Expense criada — NUNCA cai pro parser legado (LEGACY_FALLBACK_WHEN_AI_ENABLED=NO)", !expense, JSON.stringify(expense));
  }

  // ==========================================================================
  // TELEGRAM_AI_ENABLED=true + mensagem não-financeira -> SILENT (sem
  // resposta nenhuma), nunca cai pro parser legado tentando interpretar.
  // ==========================================================================
  {
    process.env.TELEGRAM_AI_ENABLED = "true";
    const chatId = `${MARK}_on_silent`;
    // Sem provider, isso vira NO_PROVIDER -> mensagem de segurança (não SILENT
    // de verdade, já que não dá pra saber "é financeiro?" sem interpretar) —
    // o ponto aqui é só confirmar que, mesmo assim, nunca cai pro legado.
    const outbox = await runDispatch(`${MARK} a versão 2 ficou melhor que a 1`, chatId);
    check("[flag=true, sem provider, msg não-financeira] ainda assim nunca cai pro parser legado (resposta de segurança, não uma tentativa de parse legado)", outbox[0]?.args?.[1] === PROVIDER_UNAVAILABLE_MESSAGE, JSON.stringify(outbox));
  }

  // ==========================================================================
  // TELEGRAM_AI_ENABLED=true, mas a conversa JÁ pertence ao parser legado
  // (wizard ativo) — preserva 100% dos fluxos existentes mesmo com a flag
  // ligada (item 20 da Fase 7.0, continua valendo).
  // ==========================================================================
  {
    process.env.TELEGRAM_AI_ENABLED = "true";
    const chatId = `${MARK}_on_wizard`;
    // Cria a sessão de wizard DIRETO no banco (nunca via startWizard(), que
    // dispara um sendMessage real pra API do Telegram como efeito colateral
    // documentado — não é isso que este teste quer exercitar).
    await prisma.botWizardSession.create({ data: { chatId, flow: "gasto", step: "start", data: {}, expiresAt: new Date(Date.now() + 15 * 60 * 1000) } });
    const outbox = await runDispatch(`${MARK} qualquer coisa`, chatId);
    check("[flag=true, wizard ativo] NÃO usa a mensagem de segurança do pipeline AI (a conversa é do wizard, não do pipeline novo)", outbox[0]?.args?.[1] !== PROVIDER_UNAVAILABLE_MESSAGE, JSON.stringify(outbox));
    await prisma.botWizardSession.deleteMany({ where: { chatId } }).catch(() => {});
  }

  if (originalFlag === undefined) delete process.env.TELEGRAM_AI_ENABLED;
  else process.env.TELEGRAM_AI_ENABLED = originalFlag;

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
