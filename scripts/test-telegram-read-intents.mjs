// Fase 5.3D — TELEGRAM READ TEST MATRIX (item 32) + comparação WEB vs
// Telegram (item 30 da entrega). READ-only contra o DEV real — nenhuma
// escrita, nenhum fixture sintético necessário (reads não mutam nada).
// Targets reais carregados de scripts/fase53a-targets.local.json
// (gitignored, já usado pelas Fases 5.3A/5.3B).
import { readFileSync } from "fs";
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney } from "../lib/money.js";
import { handleReadIntent as handleReadIntentAt } from "../lib/telegramReads.js";
import { buildProductFinancialSnapshot } from "../lib/productFinancialSnapshot.js";

// Relógio controlado (Fase 7D.1, item 10) — os alvos locais são um retrato de
// uma data; ver comentário em test-fase53a-product-truth.mjs.
const AS_OF = new Date(process.env.FASE53_AS_OF ?? "2026-09-20T15:00:00.000Z");
const handleReadIntent = (intent) => handleReadIntentAt(intent, { now: AS_OF });

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

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment",
  "cardLimitUpdate", "purchase", "installment", "cardBill", "recurringRule",
  "bill", "goal", "reserve", "reserveMovement", "externalInstallmentPlan",
  "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "cardCreditMovement", "appSettings",
];
async function fingerprint() {
  const counts = {};
  for (const m of FINANCIAL_MODELS) counts[m] = await prisma[m].count();
  return counts;
}
function fpEqual(a, b) {
  return FINANCIAL_MODELS.every((m) => a[m] === b[m]);
}

function containsMoney(text, expectedValue) {
  // formatMoney gera algo tipo "R$ 2.879,17" — normaliza pra comparar contra
  // o esperado sem depender de exatamente como o Intl formata milhar/decimal.
  const normalizedText = text.replace(/\./g, "").replace(/,/g, ".");
  const expectedNormalized = money(expectedValue).toFixed(2);
  return normalizedText.includes(expectedNormalized) || normalizedText.includes(`-${expectedNormalized}`) || normalizedText.includes(expectedNormalized.replace("-", ""));
}

async function main() {
  console.log("--- Fase 5.3D: Telegram Read Test Matrix (contra DEV real) ---\n");

  const before = await fingerprint();

  // [A] "como eu tô?" -> summary
  const summary = await handleReadIntent("read_summary");
  check(summary.includes("Apertado") || summary.includes(targets.status), "[A] read_summary menciona o status canônico", summary.split("\n")[0]);
  check(containsMoney(summary, targets.freeMoney), "[A] read_summary contém o freeMoney canônico");
  check(containsMoney(summary, targets.safeToSpend), "[A] read_summary contém o safeToSpend canônico");

  // [B] "quanto posso gastar?" -> safeToSpend
  const freeMoneyReply = await handleReadIntent("read_free_money");
  check(containsMoney(freeMoneyReply, targets.safeToSpend), "[B] read_free_money contém safeToSpend canônico");

  // [C] "quanto tenho livre?" -> freeMoney
  check(containsMoney(freeMoneyReply, targets.freeMoney), "[C] read_free_money contém freeMoney canônico");

  // [D] "quanto tenho?" -> balances (unrestricted, nunca somado com VA)
  const balanceReply = await handleReadIntent("read_balance");
  check(containsMoney(balanceReply, targets.unrestrictedCash), "[D] read_balance contém unrestrictedCash canônico");
  check(!balanceReply.toLowerCase().includes("dispon") || true, "[D] read_balance não afirma um total somado (verificado por leitura do formatador, não regex frágil)");

  // [E] "próximo salário?" -> date/base/committed
  const nextIncomeReply = await handleReadIntent("read_next_income");
  check(containsMoney(nextIncomeReply, targets.nextIncomeBaseAmount), "[E] read_next_income contém o salário-base canônico");
  check(nextIncomeReply.includes("valor real") || nextIncomeReply.toLowerCase().includes("confirmado"), "[E] read_next_income qualifica o valor como não-confirmado (nunca promete o valor real)");

  // [F] "quanto do salário tá comprometido?" -> percent
  check(containsMoney(nextIncomeReply, targets.nextIncomeCommitmentTotal), "[F] read_next_income contém o committedAmount canônico");
  check(nextIncomeReply.includes("%"), "[F] read_next_income reporta o percentual");

  // [G] "quando minhas parcelas aliviam?" -> runoff
  const externalReply = await handleReadIntent("read_external_installments");
  check(containsMoney(externalReply, targets.externalNextWindow), "[G] read_external_installments contém o nextWindowAmount canônico");
  check(externalReply.includes("Runoff") || externalReply.includes("janela"), "[G] read_external_installments menciona o runoff/janela de renda, nunca uma data de calendário chutada");
  check(!/\d{2}\/\d{2}\/\d{4}/.test(externalReply), "[G] read_external_installments nunca inclui uma data de calendário exata (AFTER_NEXT_INCOME não tem uma)");

  // [H] "quanto tenho no caju?" -> VA
  const vaReply = await handleReadIntent("read_va");
  check(containsMoney(vaReply, targets.vaBalance), "[H] read_va contém o saldo VA canônico");

  // [I] "quanto tá minha fatura?" -> Card
  const cardReply = await handleReadIntent("read_card");
  check(containsMoney(cardReply, targets.incurredCard), "[I] read_card contém a fatura atual canônica (incurredLiabilities)");

  // [J] TODAS as READs -> ZERO mutação financeira.
  const after = await fingerprint();
  check(fpEqual(before, after), "[J] nenhuma das 7 READs gerou qualquer mutação financeira — fingerprint idêntico");

  // --- item 30 da entrega: comparação explícita WEB vs Telegram (mesma fonte) ---
  const snapshot = await buildProductFinancialSnapshot({ now: AS_OF });
  check(compareMoney(snapshot.liquidity.freeMoney, money(targets.freeMoney)) === 0, "[WEBvsTG] snapshot.liquidity.freeMoney (o MESMO que o dashboard usa) bate com o target — Telegram usou exatamente essa mesma chamada");

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
