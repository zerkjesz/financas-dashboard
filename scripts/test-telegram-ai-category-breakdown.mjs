// Fase 7.0.1, item 2 — "onde gastei mais esse mês?" precisa ser
// determinístico (lib/categoryBreakdown.js) e ZERO WRITE.
//
//   node scripts/test-telegram-ai-category-breakdown.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { computeCategoryBreakdown, resolvePeriod } from "../lib/categoryBreakdown.js";
import { createMockProvider } from "../lib/telegramAi/llmProvider.js";
import { handleConversationalMessage, PIPELINE_RESULT_KIND } from "../lib/telegramAi/pipeline.js";

const MARK = "TESTE_TG_AI_CATBREAK";
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

const createdIds = [];

async function cleanup() {
  for (const id of createdIds) await prisma.expense.delete({ where: { id } }).catch(() => {});
  await prisma.pendingBotMessage.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  const stray = await prisma.expense.findMany({ where: { OR: [{ rawMessage: { contains: MARK } }, { description: { contains: MARK } }] } });
  for (const e of stray) await prisma.expense.delete({ where: { id: e.id } }).catch(() => {});
}

async function main() {
  const acct = await prisma.account.findFirst({ where: { type: "checking" } });
  if (!acct) {
    check("[pré] existe conta checking real", false);
    return;
  }

  const now = new Date();
  // Data fixa DENTRO do mês atual (dia 2, sempre válido em qualquer mês, meio-dia UTC).
  const inCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 12));
  // Dia 2 do mês passado.
  const inLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 2, 12));

  const fixtures = [
    { amount: "100.00", category: `${MARK}_Alimentação`, occurredAt: inCurrentMonth, description: `${MARK} mercado` },
    { amount: "50.00", category: `${MARK}_Alimentação`, occurredAt: inCurrentMonth, description: `${MARK} padaria` },
    { amount: "80.00", category: `${MARK}_Transporte`, occurredAt: inCurrentMonth, description: `${MARK} gasolina` },
    { amount: "999.00", category: `${MARK}_ForaDoPeriodo`, occurredAt: inLastMonth, description: `${MARK} mes passado nao deve contar` },
  ];
  for (const f of fixtures) {
    const row = await prisma.expense.create({ data: { amount: f.amount, description: f.description, category: f.category, accountId: acct.id, occurredAt: f.occurredAt, source: "manual", rawMessage: `${MARK} fixture` } });
    createdIds.push(row.id);
  }

  // ==========================================================================
  // Unidade — computeCategoryBreakdown direto (determinístico, sem LLM).
  // ==========================================================================
  {
    const result = await computeCategoryBreakdown("current_month", { now, client: prisma });
    const alimentacao = result.categories.find((c) => c.category === `${MARK}_Alimentação`);
    const transporte = result.categories.find((c) => c.category === `${MARK}_Transporte`);
    const foraDoPeriodo = result.categories.find((c) => c.category === `${MARK}_ForaDoPeriodo`);
    check("[unidade] categoria do mês atual soma corretamente (100+50=150)", alimentacao && Number(alimentacao.total) === 150, JSON.stringify(alimentacao));
    check("[unidade] segunda categoria do mês atual bate (80)", transporte && Number(transporte.total) === 80, JSON.stringify(transporte));
    check("[unidade] categoria do MÊS PASSADO não aparece no resultado de current_month (filtro de período funciona)", !foraDoPeriodo);
    check("[unidade] ordenado por valor decrescente (maior gasto primeiro)", result.categories[0].category === `${MARK}_Alimentação`, JSON.stringify(result.categories.slice(0, 3)));
  }
  {
    const result = await computeCategoryBreakdown("last_month", { now, client: prisma });
    const foraDoPeriodo = result.categories.find((c) => c.category === `${MARK}_ForaDoPeriodo`);
    check("[unidade] mês passado encontra a categoria certa (999)", foraDoPeriodo && Number(foraDoPeriodo.total) === 999, JSON.stringify(foraDoPeriodo));
    const alimentacao = result.categories.find((c) => c.category === `${MARK}_Alimentação`);
    check("[unidade] mês passado NÃO inclui gastos do mês atual", !alimentacao);
  }
  {
    const r1 = resolvePeriod(undefined, { now });
    const r2 = resolvePeriod("current_month", { now });
    check("[unidade] período ausente cai no default seguro (mês atual), nunca lança erro", r1.label === "este mês" && r1.start.getTime() === r2.start.getTime());
    const rGarbage = resolvePeriod({ garbage: true }, { now });
    check("[unidade] período não reconhecível (shape inválido) cai no default seguro, nunca lança", rGarbage.label === "este mês");
  }

  // ==========================================================================
  // E2E — mensagem natural completa via pipeline, LLM só identifica o tópico.
  // ==========================================================================
  {
    const chatId = `${MARK}_e2e`;
    const plan = { kind: "financial_plan", actions: [{ type: "QUERY_FINANCIAL_STATE", localId: "q1", confidence: "HIGH", topic: "category_breakdown", period: "current_month" }] };
    const provider = createMockProvider([[(p) => p.includes("onde gastei mais esse mês"), () => JSON.stringify(plan)]]);
    const fingerprintBefore = await prisma.expense.count();

    const result = await prisma.$transaction((tx) => handleConversationalMessage(`${MARK} onde gastei mais esse mês?`, chatId, { client: tx, provider, rawMessage: `${MARK} onde gastei mais esse mês?` }), { timeout: 15000 });

    check("[E2E] pergunta natural retorna REPLY com os números reais", result.kind === PIPELINE_RESULT_KIND.REPLY && result.reply.includes(`${MARK}_Alimentação`) && result.reply.includes(`${MARK}_Transporte`), result.reply);
    check("[E2E] valores formatados aparecem na resposta (R$ 150,00 e R$ 80,00)", /150,00/.test(result.reply) && /80,00/.test(result.reply), result.reply);
    check("[E2E] categoria de mês passado NÃO aparece (período respeitado)", !result.reply.includes(`${MARK}_ForaDoPeriodo`), result.reply);

    const fingerprintAfter = await prisma.expense.count();
    check("[E2E] ZERO WRITE — nenhuma Expense nova criada pela leitura", fingerprintBefore === fingerprintAfter, `antes=${fingerprintBefore} depois=${fingerprintAfter}`);
  }

  // ==========================================================================
  // Mês sem nenhum gasto -> resposta honesta, não um erro nem número inventado.
  // ==========================================================================
  {
    const farFuture = { start: "2099-01-01", end: "2099-02-01" };
    const result = await computeCategoryBreakdown(farFuture, { now, client: prisma });
    check("[vazio] período sem nenhum gasto -> categorias vazias, total zero (nunca erro)", result.categories.length === 0 && result.grandTotal === 0);
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
