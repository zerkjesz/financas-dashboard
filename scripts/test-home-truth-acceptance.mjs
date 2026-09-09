// Fase 5.4C, itens 51/52 — PRODUCT TRUTH ACCEPTANCE da Home. Confirma que o
// canonical read model (lib/productFinancialSnapshot.js) continua entregando
// os mesmos valores reais de sempre + o novo campo `projectionSummary`, e que
// a camada de apresentação da Home (lib/homePresentation.js) deriva
// corretamente em cima disso — SEM reimplementar nenhuma fórmula. Valores
// reais vêm de scripts/fase53a-targets.local.json (gitignored) — NUNCA
// hardcoded aqui. 100% leitura.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { compareMoney, serializeMoney } from "../lib/money.js";
import { buildProductFinancialSnapshot } from "../lib/productFinancialSnapshot.js";
import { selectDominantReason, freeMoneyLegend, shouldSuggestSimulation } from "../lib/homePresentation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targets = JSON.parse(fs.readFileSync(path.join(__dirname, "fase53a-targets.local.json"), "utf8"));

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
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

async function run() {
  console.log("--- Fase 5.4C: Home Truth Acceptance (branch dev, valores reais via fixture local) ---\n");

  const fpBefore = await fingerprint();
  const financial = await buildProductFinancialSnapshot({});

  // ---- Tabela de aceite estática (item 52) --------------------------------
  check(eq(financial.liquidity.unrestrictedCash, targets.unrestrictedCash), "unrestrictedCash bate com o alvo real", serializeMoney(financial.liquidity.unrestrictedCash).toString());
  check(eq(financial.liquidity.freeMoney, targets.freeMoney), "freeMoney bate com o alvo real", serializeMoney(financial.liquidity.freeMoney).toString());
  check(eq(financial.liquidity.safeToSpend, targets.safeToSpend), "safeToSpend bate com o alvo real", serializeMoney(financial.liquidity.safeToSpend).toString());
  check(financial.liquidity.status === targets.status, "status bate com o alvo real", financial.liquidity.status);
  check(financial.nextIncome.expectedDate.toISOString().slice(0, 10) === targets.nextIncomeDate, "nextIncome.expectedDate bate com o alvo real");
  check(eq(financial.nextIncome.baseAmount, targets.nextIncomeBaseAmount), "nextIncome.baseAmount bate com o alvo real");
  check(eq(financial.nextIncomeCommitment.committedAmount, targets.nextIncomeCommitmentTotal), "nextIncomeCommitment.committedAmount bate com o alvo real");
  check(Math.abs(financial.nextIncomeCommitment.baseCommittedPercent - Number(targets.baseCommittedPercentApprox)) < 0.05, "nextIncomeCommitment.baseCommittedPercent bate com o alvo real (~44.34%)", `${financial.nextIncomeCommitment.baseCommittedPercent}`);
  check(eq(financial.restricted.vaBalance, targets.vaBalance), "VA balance bate com o alvo real");
  check(eq(financial.currentObligations.incurredLiabilities, targets.incurredCard), "incurredLiabilities (fatura de cartão) bate com o alvo real");

  // ---- Fase 5.4C — projectionSummary (campo NOVO, aditivo) ----------------
  check(financial.projectionSummary != null, "projectionSummary presente (campo novo, exposição aditiva de engine.projections)");
  check(financial.projectionSummary.base.day30 != null && financial.projectionSummary.base.day60 != null && financial.projectionSummary.base.day90 != null, "projectionSummary.base tem os 3 checkpoints (30/60/90)");
  check(financial.projectionSummary.stress.day30 != null, "projectionSummary.stress presente (nunca esconde o cenário de risco)");

  // ---- Presentation layer sobre os dados REAIS ----------------------------
  const dominant = selectDominantReason(financial.currentObligations.breakdown);
  check(dominant != null, "selectDominantReason encontra um motivo real (breakdown não está vazio no DEV atual)");
  check(
    financial.currentObligations.breakdown.every((i) => Math.abs(i.amount) <= Math.abs(dominant.amount)),
    "motivo dominante É de fato o maior valor absoluto entre os itens reais",
    `dominante=${dominant.type}:${serializeMoney(dominant.amount)}`
  );
  check(freeMoneyLegend(serializeMoney(financial.liquidity.freeMoney)) === "além do que está livre hoje", "freeMoney real (negativo) produz a legenda esperada");
  check(shouldSuggestSimulation(financial.liquidity.status) === (targets.status === "APERTADO" || targets.status === "CRITICO"), "CTA de simulação aparece exatamente quando o status real justifica");

  // ---- Contingência real (item 18 — sem hardcode de nome/valor) -----------
  check(financial.contingency.items.length > 0, "existe pelo menos 1 contingência real ativa no DEV atual (fixture do produto, não deste teste)");
  const contingencyItem = financial.contingency.items[0];
  check(contingencyItem.expectedAmount != null || contingencyItem.expectedDate == null, "contingência real expõe expectedAmount OU declara timing desconhecido honestamente (nunca finge um dos dois)");

  const fpAfter = await fingerprint();
  check(JSON.stringify(fpBefore) === JSON.stringify(fpAfter), "zero-write: fingerprint idêntico antes/depois (só leitura)", JSON.stringify({ fpBefore, fpAfter }));
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

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await prisma.$disconnect();
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) exitCode = 1;
process.exit(exitCode);
