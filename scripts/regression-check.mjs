// Fase 3.1, Etapa 12 — recaptura EXATAMENTE o mesmo formato do baseline da Etapa 1
// (capturado antes da migration Float->Decimal, em
// /private/tmp/.../scratchpad/phase31-baseline.json) e faz o diff. Esperado: R$0,00
// de diferença em tudo que não foi deliberadamente alterado nesta fase. Qualquer
// diferença real deve PARAR e ser explicada — nunca ajustada silenciosamente
// (instrução explícita do usuário).
//
// 100% leitura — mesmas funções públicas que a auditoria e as rotas de API usam,
// nenhuma escrita.
import { prisma } from "../lib/prisma.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import { listCardsWithLimits } from "../lib/cards.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";
import { buildFinancialSummary } from "../lib/intelligence.js";
import { buildIndicators } from "../lib/indicators.js";
import { buildCashFlowProjection } from "../lib/cashFlowProjection.js";
import { buildAlerts } from "../lib/alerts.js";
import { computeUnrestrictedCash } from "../lib/unrestrictedCash.js";
import { deepSerializeMoney } from "../lib/money.js";
import fs from "node:fs";

const BASELINE_PATH = process.argv[2] || "/private/tmp/claude-501/-Users-zk-claude-ode/81163e7b-f745-4b8b-905b-5a8f80c9f21d/scratchpad/phase31-baseline.json";

async function capture() {
  const [accounts, cards] = await Promise.all([listAccountsWithBalances(), listCardsWithLimits()]);

  const [incomeSum, expenseSum, cardBillSum, installmentSum, purchaseSum, counts] = await Promise.all([
    prisma.income.aggregate({ _sum: { amount: true } }),
    prisma.expense.aggregate({ _sum: { amount: true } }),
    prisma.cardBill.aggregate({ _sum: { totalAmount: true } }),
    prisma.installment.aggregate({ _sum: { amount: true } }),
    prisma.purchase.aggregate({ _sum: { totalAmount: true } }),
    Promise.all([
      prisma.account.count(),
      prisma.card.count(),
      prisma.income.count(),
      prisma.expense.count(),
      prisma.transfer.count(),
      prisma.balanceAdjustment.count(),
      prisma.cardLimitUpdate.count(),
      prisma.purchase.count(),
      prisma.installment.count(),
      prisma.cardBill.count(),
      prisma.recurringRule.count(),
      prisma.bill.count(),
      prisma.goal.count(),
    ]),
  ]);

  const [vaSnapshot, intelligence, indicators, projection30, projection60, projection90, alerts] = await Promise.all([
    buildVaSnapshot(),
    buildFinancialSummary({ accounts, cards }),
    buildIndicators(),
    buildCashFlowProjection({ horizonDays: 30, accounts, cards }),
    buildCashFlowProjection({ horizonDays: 60, accounts, cards }),
    buildCashFlowProjection({ horizonDays: 90, accounts, cards }),
    buildAlerts({ accounts, cards }),
  ]);

  const snapshot = {
    capturedAt: new Date().toISOString(),
    counts: {
      account: counts[0],
      card: counts[1],
      income: counts[2],
      expense: counts[3],
      transfer: counts[4],
      balanceAdjustment: counts[5],
      cardLimitUpdate: counts[6],
      purchase: counts[7],
      installment: counts[8],
      cardBill: counts[9],
      recurringRule: counts[10],
      bill: counts[11],
      goal: counts[12],
    },
    fieldSums: {
      incomeAmount: incomeSum._sum.amount,
      expenseAmount: expenseSum._sum.amount,
      cardBillTotalAmount: cardBillSum._sum.totalAmount,
      installmentAmount: installmentSum._sum.amount,
      purchaseTotalAmount: purchaseSum._sum.totalAmount,
    },
    accounts: accounts.map((a) => ({ slug: a.slug, balance: a.balance })),
    cards: cards.map((c) => ({ slug: c.slug, totalLimit: c.totalLimit, usedLimit: c.usedLimit, availableLimit: c.availableLimit, amountAnticipated: c.amountAnticipated })),
    vaSnapshot,
    unrestrictedCash: computeUnrestrictedCash(accounts),
    intelligence,
    indicators,
    projection30,
    projection60,
    projection90,
    alerts,
  };

  return deepSerializeMoney(snapshot);
}

function round2(n) {
  return typeof n === "number" ? Math.round(n * 100) / 100 : n;
}

// Diff numérico com tolerância de R$0,00 EXATA (após arredondar pra 2 casas dos dois
// lados — o baseline pré-migration tem ruído de float tipo 4364.810000000001; o pós-
// migration é Decimal(12,2) exato. Comparar arredondado a 2 casas é a comparação
// certa: "mesmo valor monetário", não "mesmos bits de float").
function diff(baseline, current, path = "", out = []) {
  if (baseline === null || baseline === undefined || current === null || current === undefined) {
    if (baseline !== current) out.push({ path, baseline, current });
    return out;
  }
  if (Array.isArray(baseline)) {
    const len = Math.max(baseline.length, current.length);
    for (let i = 0; i < len; i++) diff(baseline[i], current?.[i], `${path}[${i}]`, out);
    return out;
  }
  if (typeof baseline === "object" && typeof current === "object") {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    for (const k of keys) {
      // Campos deliberadamente sensíveis ao tempo/ID de captura — não fazem parte da
      // regressão monetária, iam sempre "diferir" e não significam nada quebrado.
      if (["capturedAt", "id", "cardId", "createdAt", "updatedAt", "accountId"].includes(k)) continue;
      // Fase 5.0.2, item 18 — "dias restantes até X" é relativo a `new Date()`
      // no momento da captura (lib/vaPanel.js, lib/cashFlowProjection.js,
      // lib/intelligence.js chamam new Date() internamente, sem now injetável).
      // Um dia de calendário real passar entre o baseline e a checagem atual
      // SEMPRE muda esses números em exatamente a mesma proporção do tempo
      // decorrido — isso não é uma regressão monetária, é o relógio andando.
      // Ignorado aqui (script de comparação), nunca na regra financeira em si.
      // metaDiaria = balance / diasRestantes (lib/vaPanel.js) — puramente
      // derivada do dia-contagem acima, mesma razão de exclusão.
      if (["daysFromNow", "diasRestantes", "daysToVa", "summaryText", "summaryLines", "metaDiaria"].includes(k)) continue;
      diff(baseline[k], current[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (typeof baseline === "number" && typeof current === "number") {
    if (round2(baseline) !== round2(current)) out.push({ path, baseline, current });
    return out;
  }
  if (baseline !== current) out.push({ path, baseline, current });
  return out;
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
// Normaliza Date -> string ISO (JSON.stringify/parse), igual ao que o baseline já
// passou ao ser salvo em arquivo — sem isso, `Date !== "mesma-data-em-string"` por
// tipo, mesmo quando o valor é idêntico (falso-positivo de diff, não regressão real).
const current = JSON.parse(JSON.stringify(await capture()));
await prisma.$disconnect();

const differences = diff(baseline, current);

console.log("--- Regressão Etapa 12: baseline (pré-migration) vs. estado atual ---\n");
if (differences.length === 0) {
  console.log("✅ ZERO diferenças (além de campos time-sensitive ignorados: capturedAt/id/createdAt/updatedAt/cardId/accountId/daysFromNow/diasRestantes/daysToVa/summaryText/summaryLines/metaDiaria).");
  console.log("   Todo campo monetário comparado bate EXATAMENTE (arredondado a 2 casas) com o baseline da Etapa 1.");
} else {
  console.log(`❌ ${differences.length} diferença(s) encontrada(s):\n`);
  for (const d of differences) {
    console.log(`  ${d.path}: baseline=${JSON.stringify(d.baseline)} atual=${JSON.stringify(d.current)}`);
  }
}
process.exit(differences.length === 0 ? 0 : 1);
