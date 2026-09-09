// Fase 5.3E, itens 27-30 — Telegram SIMULATION READ intents, integração
// contra o branch dev real. Fixtures sintéticas onde necessário (contingência
// de teste); nenhum dado pessoal real é hardcoded aqui — tudo que aparece nas
// respostas é lido do banco em tempo real.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { classifyIntent } from "../lib/intentClassifier.js";
import { handleSimulationIntent, SIMULATION_INTENTS } from "../lib/telegramSimulation.js";

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

const created = { contingencies: [] };
async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
  const leftover = await prisma.contingency.count({ where: { description: { contains: MARK } } });
  check(leftover === 0, "cleanup: zero contingência de teste restante", `contagem: ${leftover}`);
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
  console.log("--- Fase 5.3E: Telegram Simulation Intents (branch dev) ---\n");

  const fpBefore = await fingerprint();

  // ==========================================================================
  // 1) "posso gastar 500?" -> simulate_cash_expense, reply cita freeMoney real.
  // ==========================================================================
  {
    const classified = classifyIntent("posso gastar 500?");
    check(classified.intent === "simulate_cash_expense", "classifyIntent: 'posso gastar 500?' -> simulate_cash_expense", classified.intent);
    check(SIMULATION_INTENTS.has(classified.intent), "SIMULATION_INTENTS contém o intent");

    const reply = await handleSimulationIntent(classified);
    check(typeof reply === "string" && reply.length > 0, "reply é uma string não vazia");
    check(reply.includes("simulação"), "reply cita o lembrete de que é só simulação", reply);
    check(reply.includes("Dinheiro livre"), "reply cita 'Dinheiro livre'", reply);
  }

  // ==========================================================================
  // 2) "e se eu comprar 1200 no cartão?" -> simulate_card_purchase_single,
  //    reply cita CARD_FEASIBILITY do cartão real (default = mais antigo).
  // ==========================================================================
  {
    const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
    const classified = classifyIntent("e se eu comprar 1200 no cartão?");
    check(classified.intent === "simulate_card_purchase_single", "classifyIntent: 'e se eu comprar 1200 no cartão?' -> simulate_card_purchase_single", classified.intent);

    const reply = await handleSimulationIntent(classified);
    check(card ? reply.includes(card.name) : true, "reply cita o nome REAL do cartão default (nunca hardcoded)", `card=${card?.name}`);
    check(/autorizaria/.test(reply), "reply cita autorização do cartão (autorizaria/NÃO autorizaria)", reply);
  }

  // ==========================================================================
  // 3) "e se eu parcelar 1200 em 6x?" -> simulate_card_purchase_installments,
  //    reply cita "6x".
  // ==========================================================================
  {
    const classified = classifyIntent("e se eu parcelar 1200 em 6x?");
    check(
      classified.intent === "simulate_card_purchase_installments" && classified.installmentCount === 6,
      "classifyIntent: 'e se eu parcelar 1200 em 6x?' -> simulate_card_purchase_installments + installmentCount=6",
      JSON.stringify(classified)
    );

    const reply = await handleSimulationIntent(classified);
    check(reply.includes("6x"), "reply cita '6x' (número de parcelas real usado)", reply);
  }

  // ==========================================================================
  // 4) "se a <contingência de teste> ficar 2000 como eu fico?" ->
  //    simulate_contingency, reply cita a descrição REAL (nunca hardcoded).
  // ==========================================================================
  {
    const contingency = await prisma.contingency.create({
      data: { description: `${MARK} Viagem Imprevista`, expectedAmount: 500, maxAmount: 3000, status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const classified = classifyIntent(`se a ${MARK.toLowerCase()} viagem imprevista ficar 2000 como eu fico?`);
    check(classified.intent === "simulate_contingency", "classifyIntent: reconhece 'se a ... ficar' -> simulate_contingency", classified.intent);

    const reply = await handleSimulationIntent(classified);
    check(reply.includes(contingency.description), "reply cita a descrição REAL da contingência (fuzzy match funcionou)", reply);
    check(reply.includes("simulação"), "reply cita o lembrete de simulação");
  }

  // ==========================================================================
  // 5) Contingência inexistente -> resposta honesta, nunca erro cru nem crash.
  // ==========================================================================
  {
    const classified = classifyIntent("se a coisa-inexistente-xyz-123 ficar 500 como eu fico?");
    const reply = await handleSimulationIntent(classified);
    check(reply.toLowerCase().includes("não encontrei"), "contingência não encontrada: resposta honesta (não crasha, não inventa)", reply);
  }

  // ==========================================================================
  // 6) Zero-write proof — nenhum model financeiro muda de contagem (fora do
  //    fixture sintético desta seção, já limpo antes desta checagem).
  // ==========================================================================
  {
    // Fixture já limpo antes de medir — mede depois da limpeza pra provar
    // FINAL_SYNTHETIC_FIXTURE_STATE = CLEAN também.
    for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
    created.contingencies = [];
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
