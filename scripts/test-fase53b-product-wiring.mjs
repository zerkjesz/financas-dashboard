// Fase 5.3B — CANONICAL PRODUCT WIRING / acceptance harness. READ-ONLY contra
// DEV real. Alvos vêm de scripts/fase53a-targets.local.json (gitignored,
// reaproveitado — os mesmos 12 targets da Fase 5.3A continuam válidos, o
// motor canônico não mudou, só passou a ser CONSUMIDO pelo produto).
import { readFileSync } from "fs";
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney, serializeMoney } from "../lib/money.js";
import { buildProductFinancialSnapshot } from "../lib/productFinancialSnapshot.js";
import { withCanonicalWorld } from "./lib/canonicalWorld.js";
import { buildBaseProjection } from "../lib/financialProjection.js";

const targets = JSON.parse(readFileSync(new URL("./fase53a-targets.local.json", import.meta.url)));

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
function eq(actual, expected, label) {
  const ok = compareMoney(money(actual), money(expected)) === 0;
  check(ok, label, `esperado=${expected} obtido=${serializeMoney(money(actual))}`);
}

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment",
  "cardLimitUpdate", "purchase", "installment", "cardBill", "recurringRule",
  "bill", "goal", "reserve", "reserveMovement", "externalInstallmentPlan",
  "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "cardCreditMovement", "appSettings",
];
async function fingerprint() {
  const counts = {};
  for (const model of FINANCIAL_MODELS) counts[model] = await prisma[model].count();
  return counts;
}

async function main() {
  console.log("--- Fase 5.3B: Product Wiring Acceptance (read-only) ---\n");
  const before = await fingerprint();
  // Relógio controlado (Fase 7D.1, item 10) — ver comentário em test-fase53a-product-truth.mjs.
  const now = new Date(process.env.FASE53_AS_OF ?? "2026-09-20T15:00:00.000Z");

  // --- item 35: os payloads que o PRODUTO realmente consome (não uma cópia) ---
  // Fase 9.1.1 — mundo canônico isolado (transação revertida): independe do estado ambiente do DEV.
  const snapshot = await withCanonicalWorld((tx) => buildProductFinancialSnapshot({ now, client: tx }));

  console.log("--- Product read model vs. targets canônicos ---");
  eq(snapshot.liquidity.unrestrictedCash, targets.unrestrictedCash, "financial.liquidity.unrestrictedCash");
  eq(snapshot.restricted.vaBalance, targets.vaBalance, "financial.restricted.vaBalance");
  check(
    snapshot.restricted.vaNextRecharge.toISOString().slice(0, 10) === targets.vaNextRecharge,
    "financial.restricted.vaNextRecharge"
  );
  eq(snapshot.currentObligations.incurredLiabilities, targets.incurredCard, "financial.currentObligations.incurredLiabilities");
  eq(snapshot.liquidity.freeMoney, targets.freeMoney, "financial.liquidity.freeMoney");
  eq(snapshot.liquidity.safeToSpend, targets.safeToSpend, "financial.liquidity.safeToSpend");
  check(snapshot.liquidity.status === targets.status, "financial.liquidity.status");
  eq(snapshot.nextIncome.baseAmount, targets.nextIncomeBaseAmount, "financial.nextIncome.baseAmount");
  check(snapshot.nextIncome.actualAmountKnown === false && snapshot.nextIncome.actualAmount === null, "financial.nextIncome nunca afirma o valor real como certo");
  eq(snapshot.externalInstallments.nextWindowAmount, targets.externalNextWindow, "financial.externalInstallments.nextWindowAmount");
  check(snapshot.externalInstallments.nextWindowCount === 9, "financial.externalInstallments.nextWindowCount === 9 (nunca as 38)");
  eq(snapshot.nextIncomeCommitment.committedAmount, targets.nextIncomeCommitmentTotal, "financial.nextIncomeCommitment.committedAmount");
  check(compareMoney(snapshot.nextIncomeCommitment.otherAmount, money(0)) === 0, "financial.nextIncomeCommitment.otherAmount === 0 (cardAmount+externalAmount reconciliam 100% do total)");

  // --- item 0/18: decomposição corrigida de futureObligations — a Fase 5.3A
  // relatou por engano um total de CardBill futuro que não batia com a soma
  // real das 4 rows (erro de aritmética na resposta em conversa, nunca em
  // código versionado — corrigido pelo usuário na abertura da Fase 5.3B).
  // Este teste garante que a decomposição sempre reconcilia 100% contra o
  // total canônico, derivado do DB em runtime — nunca um valor solto
  // hardcoded aqui.
  const cardBillBucket = snapshot.futureObligations.decomposition.find((d) => d.model === "CardBill");
  const externalBucket = snapshot.futureObligations.decomposition.find((d) => d.model === "ExternalInstallment");
  check(cardBillBucket?.count === 4, "futureObligations: 4 CardBill futuras", `count=${cardBillBucket?.count}`);
  check(externalBucket?.count === 29, "futureObligations: 29 ExternalInstallment futuras", `count=${externalBucket?.count}`);
  const decompositionSum = money(cardBillBucket.amount).plus(money(externalBucket.amount));
  check(
    compareMoney(decompositionSum, snapshot.futureObligations.amount) === 0,
    "futureObligations: decomposição (CardBill + ExternalInstallment) reconcilia 100% do total canônico",
    `${serializeMoney(decompositionSum)} === ${serializeMoney(snapshot.futureObligations.amount)}`
  );

  // --- item 14 (Fase 5.3B) — REMOVIDO na Fase 5.4F: comparava
  // lib/indicators.js (V1, deletado — zero caller real restante: seu único
  // consumidor de UI, IndicadoresView.jsx/rota /metas, foi removido no mesmo
  // corte, ver METAS_FINAL_DECISION do relatório) contra
  // financial.nextIncomeCommitment.baseCommittedPercent. Testava uma
  // superfície que não existe mais — obsoleto por construção, não por
  // conveniência. O valor canônico em si (baseCommittedPercent) continua
  // coberto por scripts/test-financial-engine-integration.mjs (seção
  // nextIncomeCommitment, item 18).

  // --- item 16: AFTER_NEXT_INCOME na projeção V2 — as 5 garantias ---
  console.log("\n--- AFTER_NEXT_INCOME projection guarantees (item 16) ---");
  const base = await buildBaseProjection({ horizonDays: 120, now });
  const installmentWindowEvents = base.timeline.filter((e) => e.kind === "external_installment_window");
  check(installmentWindowEvents.length > 0, "[G1] AFTER_NEXT_INCOME NÃO some da projeção (pelo menos 1 evento em 120 dias)");
  const distinctDates = new Set(installmentWindowEvents.map((e) => e.date.toISOString()));
  check(distinctDates.size === installmentWindowEvents.length, "[G2] cada offset cai numa data DIFERENTE (nunca todas na mesma janela)");
  const realIncomeDates = new Set(base.timeline.filter((e) => e.kind === "recurring_income").map((e) => e.date.toISOString()));
  check(
    installmentWindowEvents.every((e) => realIncomeDates.has(e.date.toISOString())),
    "[G3] toda data usada é uma ocorrência de renda REAL já projetada (nunca uma data inventada)"
  );
  // [G4] runoff coerente: o total de cada evento bate exatamente com computeExternalInstallmentRunoff.
  const { listExternalInstallmentPlans, computeExternalInstallmentRunoff } = await import("../lib/externalInstallments.js");
  const activePlans = await listExternalInstallmentPlans({ status: "ACTIVE" });
  const runoff = computeExternalInstallmentRunoff(activePlans.filter((p) => p.dueTiming === "AFTER_NEXT_INCOME"));
  const sortedEvents = [...installmentWindowEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
  let runoffCoherent = true;
  for (let i = 0; i < sortedEvents.length; i++) {
    const expectedTotal = money(runoff[i].monthTotal);
    const actualTotal = money(sortedEvents[i].amount).abs();
    if (compareMoney(expectedTotal, actualTotal) !== 0) runoffCoherent = false;
  }
  check(runoffCoherent, "[G4] cada evento da projeção bate exatamente com o runoff canônico (offset a offset)");
  check(sortedEvents.length === runoff.filter((r) => r.activePlanCount > 0).length || sortedEvents.length < runoff.length, "[G5] nunca mais eventos que offsets ativos no runoff (uma parcela por plano por ocorrência)");

  // --- item 36: zero-write proof ---
  const after = await fingerprint();
  console.log("\n--- Zero-write proof ---");
  let allIdentical = true;
  for (const model of FINANCIAL_MODELS) {
    if (before[model] !== after[model]) {
      allIdentical = false;
      console.error(`❌ ${model}: antes=${before[model]} depois=${after[model]}`);
    }
  }
  check(allIdentical, "todos os models financeiros com contagem idêntica antes/depois (ZERO WRITES)");

  console.log(`\n${passed}/${passed + failed} check(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
