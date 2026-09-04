// Fase 4.1.1, item 4 — testes de integração (branch dev) das duas correções de
// boundary, contra dados reais persistidos (não só a lógica pura). Fixture
// sintética própria — nenhum dado real do usuário.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, addMoney, money } from "../lib/money.js";
import { getNextIncomeCommitment, getCurrentHorizonObligations } from "../lib/freeMoney.js";
import { computeCurrentObligationHorizonEnd } from "../lib/financialEngine.js";

const MARK = "TESTE_FASE411";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}
function d(s) {
  return new Date(`${s}T00:00:00.000Z`);
}

const created = { accounts: [], bills: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const b of created.bills) await prisma.bill.delete({ where: { id: b } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});
  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase411" } } }),
    prisma.bill.count({ where: { description: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de integração: boundaries de horizonte (branch dev) — Fase 4.1.1 ---\n");

  const account = await prisma.account.create({ data: { slug: "teste-fase411-conta", name: `[${MARK}] Conta`, type: "checking" } });
  created.accounts.push(account.id);

  // ==========================================================================
  // Item 1 — janela [24/09, 24/10) contra dado real persistido, uma data por vez.
  // ==========================================================================
  const nextIncome = { expectedDate: d("2026-09-24"), status: "UPCOMING", amount: null, recurringRuleId: null, isFallback: false };
  const boundaryDates = [
    { date: "2026-09-23", shouldInclude: false, label: "23/09 (antes do início)" },
    { date: "2026-09-24", shouldInclude: true, label: "24/09 (início inclusive)" },
    { date: "2026-09-25", shouldInclude: true, label: "25/09" },
    { date: "2026-10-23", shouldInclude: true, label: "23/10 (véspera do fim)" },
    { date: "2026-10-24", shouldInclude: false, label: "24/10 (fim exclusive — ciclo seguinte)" },
    { date: "2026-10-25", shouldInclude: false, label: "25/10" },
  ];

  for (const { date, shouldInclude, label } of boundaryDates) {
    const before = await getNextIncomeCommitment({ nextIncome });
    const bill = await prisma.bill.create({
      data: { description: `[${MARK}] Boundary ${date}`, amount: 111, category: "Outros", accountId: account.id, dueDate: d(date), status: "pending", source: "manual" },
    });
    const after = await getNextIncomeCommitment({ nextIncome });
    const delta = addMoney(after.committedAmount, before.committedAmount.negated());
    const included = eq(delta, 111);
    check(`nextIncomeCommitment: obrigação em ${label} ${shouldInclude ? "ENTRA" : "NÃO entra"} na janela`, included === shouldInclude, `delta=${delta.toFixed(2)}`);
    await prisma.bill.delete({ where: { id: bill.id } });
  }

  // ==========================================================================
  // Item 2/4 — currentHorizonObligations usando o horizonte EFETIVO (OVERDUE)
  // contra dado real persistido.
  // ==========================================================================
  const overdueIncome = { status: "OVERDUE", expectedDate: d("2026-09-24") };

  const bill26 = await prisma.bill.create({
    data: { description: `[${MARK}] Obrigação 26/09`, amount: 222, category: "Outros", accountId: account.id, dueDate: d("2026-09-26"), status: "pending", source: "manual" },
  });
  created.bills.push(bill26.id);

  // Hoje = 25/09, ainda OVERDUE -> horizonte efetivo = 25/09 -> bill de 26/09 é FUTURE.
  const horizon25 = computeCurrentObligationHorizonEnd(overdueIncome, d("2026-09-25"));
  const beforeCH = await getCurrentHorizonObligations({ nextIncomeDate: horizon25 });
  check("hoje=25/09, OVERDUE: obrigação de 26/09 NÃO conta em currentHorizon (ainda future)", !beforeCH.items.some((i) => i.id === bill26.id));

  // Hoje = 26/09, ainda sem Income (ainda OVERDUE) -> horizonte efetivo = 26/09 -> bill de 26/09 já é CURRENT.
  const horizon26 = computeCurrentObligationHorizonEnd(overdueIncome, d("2026-09-26"));
  const afterCH = await getCurrentHorizonObligations({ nextIncomeDate: horizon26 });
  check("hoje=26/09, ainda OVERDUE: obrigação de 26/09 AGORA conta em currentHorizon (horizonte acompanhou o tempo)", afterCH.items.some((i) => i.id === bill26.id));

  await prisma.bill.delete({ where: { id: bill26.id } });
  created.bills = created.bills.filter((id) => id !== bill26.id);
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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checagem(ns) passaram.`);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  exitCode = 1;
}
process.exit(exitCode);
