// Fase 5.3E, itens 27-30 / Fase 5.3E.1, itens 1-13 — Telegram SIMULATION +
// CLARIFICATION, integração contra o branch dev real. Fixtures sintéticas
// onde necessário (contingência, 2º cartão temporário pra forçar ambiguidade
// real de item 10); nenhum dado pessoal real é hardcoded aqui.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { classifyIntent } from "../lib/intentClassifier.js";
import {
  SIMULATION_BYPASS_INTENTS,
  SIMULATION_TRANSACTIONAL_INTENTS,
  handleBypassSimulationIntent,
  handleTransactionalSimulationIntent,
  resolveSimulationPending,
} from "../lib/telegramSimulation.js";
import { processTelegramMessage } from "../lib/processTelegramMessage.js";

const MARK = "TESTE_FASE53E_TG";
let passed = 0;
let failed = 0;
// check(condition, label, extra?) — condição PRIMEIRO, sempre.
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

const created = { contingencies: [], cards: [] };
async function cleanup() {
  console.log("\n--- cleanup ---");
  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  const leftover = await Promise.all([
    prisma.contingency.count({ where: { description: { contains: MARK } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase53e-tg" } } }),
    prisma.pendingBotMessage.count({ where: { chatId: { startsWith: MARK } } }),
  ]);
  check(leftover.every((n) => n === 0), "cleanup: zero fixture de teste restante", `contagens: ${JSON.stringify(leftover)}`);
}

// Pseudo-chatId de teste — nunca colide com um chatId real do Telegram
// (numérico), então nunca interfere com o uso real do bot durante o teste.
function testChatId(suffix) {
  return `${MARK}_${suffix}`;
}

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment", "cardLimitUpdate", "purchase",
  "installment", "cardBill", "recurringRule", "bill", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "telegramUpdateReceipt",
];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

async function run() {
  console.log("--- Fase 5.3E.1: Telegram Simulation + Clarification (branch dev) ---\n");

  const fpBefore = await fingerprint();

  // ==========================================================================
  // 1) "posso gastar 500?" continua no BYPASS (nunca ambíguo) — comportamento
  //    intacto da Fase 5.3E.
  // ==========================================================================
  {
    const classified = classifyIntent("posso gastar 500?");
    check(SIMULATION_BYPASS_INTENTS.has(classified.intent), "'posso gastar 500?' continua em SIMULATION_BYPASS_INTENTS", classified.intent);
    const reply = await handleBypassSimulationIntent(classified);
    check(reply.includes("Dinheiro livre"), "bypass: reply cita 'Dinheiro livre'", reply);
  }

  // ==========================================================================
  // 2) Fase 5.3E.1, item 1/2 — "posso comprar 1200?" é GENUINAMENTE ambíguo:
  //    handleTransactionalSimulationIntent devolve pending, NUNCA simula
  //    direto.
  // ==========================================================================
  {
    const classified = classifyIntent("posso comprar 1200?");
    check(classified.intent === "clarify_payment_method", "'posso comprar 1200?' -> clarify_payment_method", classified.intent);
    check(SIMULATION_TRANSACTIONAL_INTENTS.has(classified.intent), "clarify_payment_method está em SIMULATION_TRANSACTIONAL_INTENTS");

    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    check(result.pending != null, "handleTransactionalSimulationIntent devolve `pending` (não simula direto)");
    check(result.reply.toLowerCase().includes("pagar"), "reply pergunta como vai pagar", result.reply);
    check(result.pending.data.stage === "payment_method" && result.pending.data.amount === 1200, "pending guarda stage=payment_method e amount=1200", JSON.stringify(result.pending.data));
  }

  // ==========================================================================
  // 3) Fase 5.3E.1, item 13 — FOLLOW-UP completo via processTelegramMessage:
  //    "posso comprar 1200?" -> pergunta -> "cartão" -> simula (nunca cria
  //    Purchase).
  // ==========================================================================
  {
    const chatId = testChatId("followup_payment");
    const fpBeforeFollowup = await fingerprint();

    const first = await processTelegramMessage("posso comprar 1200?", chatId, { client: prisma });
    check(first.reply.toLowerCase().includes("pagar"), "[followup] 1ª mensagem pergunta método", first.reply);
    const pendingRow = await prisma.pendingBotMessage.findUnique({ where: { chatId } });
    check(pendingRow != null && pendingRow.intent === "simulation_clarification", "[followup] PendingBotMessage criado com intent=simulation_clarification");

    const second = await processTelegramMessage("cartão", chatId, { client: prisma });
    check(second.reply.includes("Dinheiro livre") || second.reply.includes("cartão"), "[followup] 2ª mensagem ('cartão') já simula", second.reply);
    const pendingAfter = await prisma.pendingBotMessage.findUnique({ where: { chatId } });
    check(pendingAfter == null, "[followup] pending consumido (deletado) após responder");

    const fpAfterFollowup = await fingerprint();
    check(
      JSON.stringify(fpBeforeFollowup) === JSON.stringify(fpAfterFollowup),
      "[followup] ZERO mutação financeira em todo o fluxo (nenhuma Purchase/Expense criada)",
      JSON.stringify({ before: fpBeforeFollowup, after: fpAfterFollowup })
    );
  }

  // ==========================================================================
  // 4) Fase 5.3E.1, item 5 — parcelamento explícito NUNCA pede método (já é
  //    cartão por definição) — resolve direto (ou pede só o cartão, se
  //    ambíguo por ter mais de um — ver seção 6 abaixo).
  // ==========================================================================
  {
    const classified = classifyIntent("e se eu parcelar 1200 em 6x?");
    check(classified.intent === "simulate_card_purchase_installments" && classified.installmentCount === 6, "'e se eu parcelar 1200 em 6x?' -> simulate_card_purchase_installments, 6x");
    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    // Com exatamente 1 cartão real hoje, resolve direto (sem pending).
    const cardCount = await prisma.card.count();
    if (cardCount === 1) {
      check(result.pending == null, "[1 cartão real] resolve direto, sem pedir qual cartão");
      check(result.reply.includes("6x"), "reply cita '6x'", result.reply);
    } else {
      check(result.pending != null, "[>1 cartão] pede qual cartão em vez de assumir");
    }
  }

  // ==========================================================================
  // 5) Fase 5.3E.1, item 8 — contingência com timing EXPLÍCITO nunca pergunta.
  // ==========================================================================
  {
    const contingency = await prisma.contingency.create({
      data: { description: `${MARK} Viagem Imprevista`, expectedAmount: 500, maxAmount: 3000, status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const classified = classifyIntent(`se eu pagar 2000 da ${MARK.toLowerCase()} viagem imprevista agora, como fico?`);
    check(classified.intent === "simulate_contingency" && classified.timingExplicit === "NOW", "timing explícito ('agora') reconhecido pelo classifier", JSON.stringify(classified));

    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    check(result.pending == null, "timing explícito -> resolve direto, sem pending");
    check(result.reply.includes(contingency.description), "reply cita a descrição REAL da contingência", result.reply);
  }

  // ==========================================================================
  // 6) Fase 5.3E.1, item 6/7 — contingência SEM timing pergunta explicitamente
  //    (nunca assume NOW em silêncio), com as DUAS opções (agora / próxima
  //    renda) quando NEXT_INCOME_WINDOW é honesto (há uma próxima renda real).
  // ==========================================================================
  {
    const contingency = await prisma.contingency.create({
      data: { description: `${MARK} Conserto Inesperado`, expectedAmount: 400, maxAmount: 900, status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const classified = classifyIntent(`se a ${MARK.toLowerCase()} conserto inesperado ficar 800 como eu fico?`);
    check(classified.intent === "simulate_contingency" && classified.timingExplicit === null, "sem 'agora'/'hoje' -> timingExplicit=null (ambíguo)", JSON.stringify(classified));

    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    check(result.pending != null, "timing ambíguo -> pending criado, NUNCA simula direto");
    check(result.pending.data.stage === "contingency_timing", "pending.stage=contingency_timing");
    check(/agora/i.test(result.reply), "reply pergunta 'agora'", result.reply);

    // Resolve com "agora".
    const resolvedNow = await resolveSimulationPending({ parsedPayload: result.pending.data }, "agora", { client: prisma });
    check(resolvedNow.reply.includes(contingency.description), "[timing=agora] simula e cita a contingência real", resolvedNow.reply);

    // Cenário SEPARADO pra testar "depois da próxima renda" sem interferir no acima.
    const classified2 = classifyIntent(`se a ${MARK.toLowerCase()} conserto inesperado ficar 800 como eu fico?`);
    const result2 = await handleTransactionalSimulationIntent(classified2, { client: prisma });
    if (result2.pending.data.hasNextIncomeOption) {
      const resolvedLater = await resolveSimulationPending({ parsedPayload: result2.pending.data }, "depois da proxima renda", { client: prisma });
      check(resolvedLater.reply.includes(contingency.description), "[timing=depois da renda] simula e cita a contingência real", resolvedLater.reply);
    } else {
      check(true, "[timing=depois da renda] pulado — não há next income real configurado neste ambiente");
    }
  }

  // ==========================================================================
  // 7) Fase 5.3E.1, item 10 — multi-card: com >1 cartão elegível, NUNCA
  //    seleciona silenciosamente "o mais antigo" — pergunta qual.
  // ==========================================================================
  {
    const secondCard = await prisma.card.create({ data: { slug: "teste-fase53e-tg-2o-cartao", name: `[${MARK}] Segundo Cartão`, totalLimit: 3000, dueDay: 10 } });
    created.cards.push(secondCard.id);

    const cardCount = await prisma.card.count();
    check(cardCount >= 2, "fixture: agora existem >= 2 cartões", `cardCount=${cardCount}`);

    const classified = classifyIntent("posso comprar 500 no cartão?");
    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    check(result.pending != null, "[>1 cartão] pede qual cartão em vez de assumir o mais antigo");
    check(result.pending.data.stage === "card_choice", "pending.stage=card_choice");
    check(result.pending.data.cardOptions.length === cardCount, "pending lista TODOS os cartões elegíveis", JSON.stringify(result.pending.data.cardOptions));

    // Resolve escolhendo o 2º cartão sintético pelo nome.
    const resolved = await resolveSimulationPending({ parsedPayload: result.pending.data }, secondCard.name, { client: prisma });
    check(resolved.reply.includes(secondCard.name), "[card_choice] resposta cita o cartão REALMENTE escolhido (não o mais antigo)", resolved.reply);

    // Cleanup imediato do 2º cartão (não deixar contaminar as seções seguintes).
    await prisma.card.delete({ where: { id: secondCard.id } }).catch(() => {});
    created.cards = created.cards.filter((id) => id !== secondCard.id);
  }

  // ==========================================================================
  // 8) Validação: contingência inexistente -> resposta honesta.
  // ==========================================================================
  {
    const classified = classifyIntent("se a coisa-inexistente-xyz-123 ficar 500 como eu fico?");
    const result = await handleTransactionalSimulationIntent(classified, { client: prisma });
    check(result.pending == null, "contingência inexistente: nunca cria pending");
    check(result.reply.toLowerCase().includes("não encontrei"), "contingência não encontrada: resposta honesta (não crasha, não inventa)", result.reply);
  }

  // ==========================================================================
  // 9) Zero-write proof — nenhum model FINANCEIRO muda de contagem (fixtures
  //    sintéticas já limpas antes desta checagem; PendingBotMessage não é um
  //    model financeiro, item 18, não entra nesta lista).
  // ==========================================================================
  {
    for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
    for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
    created.contingencies = [];
    created.cards = [];
    await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
    const fpAfter = await fingerprint();
    check(JSON.stringify(fpBefore) === JSON.stringify(fpAfter), "zero-write: todos os models financeiros com contagem idêntica antes/depois", JSON.stringify({ fpBefore, fpAfter }));
  }
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) exitCode = 1;
process.exit(exitCode);
