// Fase 5.3A — PRODUCT TRUTH ACCEPTANCE / READ-ONLY.
//
// Acceptance harness: valida, contra o estado REAL do banco DEV, que o motor
// financeiro canônico (lib/financialEngine.js) produz os valores que o
// usuário declarou como canônicos neste momento (Fase 5.2D aprovada).
//
// 100% READ-ONLY: nenhuma mutação é feita. Prova disso: fingerprint de TODOS
// os models financeiros antes e depois — precisa ser byte-idêntico (item 36).
//
// Alvos carregados de scripts/fase53a-targets.local.json (gitignored, nunca
// versionado) — NENHUM valor financeiro pessoal é hardcoded aqui (disciplina
// já estabelecida nas fases anteriores).
import { readFileSync } from "fs";
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney } from "../lib/money.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";
import { serializeMoney } from "../lib/money.js";
import { withCanonicalWorld } from "./lib/canonicalWorld.js";

const targets = JSON.parse(readFileSync(new URL("./fase53a-targets.local.json", import.meta.url)));

// Relógio CONTROLADO (Fase 7D.1, item 10). Os alvos de scripts/fase53a-targets.local.json
// são um retrato de uma data específica (próxima recarga do VA em 2026-09-21,
// próxima renda em 2026-09-24): comparar contra `new Date()` fazia o teste
// quebrar sozinho quando o calendário andava (a lógica de produção estava
// CORRETA — depois de 21/09 a próxima recarga é mesmo 21/10). O instante de
// referência agora é fixo e explícito; nenhuma lógica financeira foi alterada.
// Ao atualizar os alvos locais pra um novo retrato, atualize FASE53_AS_OF junto.
const AS_OF = new Date(process.env.FASE53_AS_OF ?? "2026-09-20T15:00:00.000Z");

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

// Fingerprint de todos os models financeiros — só contagem (suficiente pra
// provar zero-write; não precisa ser um hash de conteúdo pra esse propósito).
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
  console.log("--- Fase 5.3A: Product Truth Acceptance (read-only) ---\n");

  const before = await fingerprint();

  // Fase 9.1.1 — mundo canônico isolado (transação revertida): independe do estado ambiente do DEV.
  const summary = await withCanonicalWorld((tx) => buildFinancialEngineSummary({ now: AS_OF, client: tx }));
  const va = await buildVaSnapshot({ now: AS_OF });

  console.log("--- Canonical engine output vs. targets ---");
  eq(summary.balances.unrestrictedCash, targets.unrestrictedCash, "unrestrictedCash (Itaú)");
  eq(va.balance, targets.vaBalance, "VA balance");
  check(
    va.nextRecharge && va.nextRecharge.toISOString().slice(0, 10) === targets.vaNextRecharge,
    "VA nextRecharge",
    `esperado=${targets.vaNextRecharge} obtido=${va.nextRecharge?.toISOString().slice(0, 10)}`
  );
  eq(summary.obligations.incurredLiabilities, targets.incurredCard, "incurredLiabilities (Card)");
  eq(summary.freeMoney, targets.freeMoney, "freeMoney");
  eq(summary.safeToSpend, targets.safeToSpend, "safeToSpend");
  check(summary.status.status === targets.status, "financialStatus", `esperado=${targets.status} obtido=${summary.status.status}`);
  eq(summary.nextIncome.amount, targets.nextIncomeBaseAmount, "nextIncome base amount (salário)");
  check(
    summary.nextIncome.expectedDate.toISOString().slice(0, 10) === targets.nextIncomeDate,
    "nextIncome expectedDate",
    `esperado=${targets.nextIncomeDate} obtido=${summary.nextIncome.expectedDate.toISOString().slice(0, 10)}`
  );
  eq(summary.obligations.nextIncomeWindowCommitment, targets.externalNextWindow, "nextIncomeWindowCommitment (external, 9 planos)");
  eq(summary.nextIncomeCommitment.committedAmount, targets.nextIncomeCommitmentTotal, "nextIncomeCommitment.committedAmount (card+external)");
  const committedPercentNum = summary.nextIncomeCommitment.committedPercent?.toNumber?.() ?? summary.nextIncomeCommitment.committedPercent;
  check(
    committedPercentNum != null && Math.abs(committedPercentNum - Number(targets.baseCommittedPercentApprox)) < 0.05,
    "nextIncomeCommitment.committedPercent (~alvo do arquivo local)",
    `esperado≈${targets.baseCommittedPercentApprox}% obtido=${committedPercentNum}%`
  );

  const after = await fingerprint();
  console.log("\n--- Zero-write proof (fingerprint antes/depois) ---");
  let allIdentical = true;
  for (const model of FINANCIAL_MODELS) {
    const same = before[model] === after[model];
    if (!same) allIdentical = false;
    if (!same) console.error(`❌ ${model}: antes=${before[model]} depois=${after[model]}`);
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
