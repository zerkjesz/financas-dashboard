// Fase 4.0.2, item 8 — testes de integração contra o branch dev do vínculo real
// RecurringRule <-> Income via recurringOccurrenceDate. Fixture sintética própria
// (RecurringRule/Account criadas aqui) — nenhum dado real do usuário.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import {
  resolveNextExpectedIncome,
  recordRecurringIncomeOccurrence,
  getRealizedOccurrences,
  INCOME_HORIZON_STATUS,
} from "../lib/incomeHorizon.js";
import { getAppSettings } from "../lib/settings.js";
import { compareMoney } from "../lib/money.js";

const MARK = "TESTE_FASE402";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
async function expectThrow(name, fn) {
  try {
    await fn();
    check(name, false, "não lançou erro (esperado que lançasse)");
  } catch {
    check(name, true);
  }
}
function iso(d) {
  return new Date(d).toISOString().slice(0, 10);
}

const created = { accounts: [], recurringRules: [], incomes: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const i of created.incomes) await prisma.income.delete({ where: { id: i } }).catch(() => {});
  for (const r of created.recurringRules) await prisma.recurringRule.delete({ where: { id: r } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase402" } } }),
    prisma.recurringRule.count({ where: { name: { contains: MARK } } }),
    prisma.income.count({ where: { description: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de integração: incomeHorizon + recurringOccurrenceDate (branch dev) — Fase 4.0.2, item 8 ---\n");

  const settings = await getAppSettings();

  const checkingAccount = await prisma.account.create({ data: { slug: "teste-fase402-conta", name: `[${MARK}] Conta`, type: "checking" } });
  created.accounts.push(checkingAccount.id);
  const vaAccount = await prisma.account.create({ data: { slug: "teste-fase402-va", name: `[${MARK}] VA`, type: "food_voucher" } });
  created.accounts.push(vaAccount.id);

  const salaryRule = await prisma.recurringRule.create({
    data: { name: `[${MARK}] Salário`, kind: "income", amount: 5000, dayOfMonth: 24, accountId: checkingAccount.id },
  });
  created.recurringRules.push(salaryRule.id);
  const vaRule = await prisma.recurringRule.create({
    data: { name: `[${MARK}] VA Recarga`, kind: "income", amount: 1300, dayOfMonth: 21, accountId: vaAccount.id },
  });
  created.recurringRules.push(vaRule.id);

  const accounts = await prisma.account.findMany({ where: { id: { in: [checkingAccount.id, vaAccount.id] } } });

  // ---- H) VA recorrente ignorado pelo income horizon do freeMoney ----
  const onlyVaResult = resolveNextExpectedIncome({ now: new Date("2026-09-04T00:00:00.000Z"), recurringRules: [vaRule], accounts, settings });
  check("H) VA (food_voucher) ignorada — cai no FALLBACK mesmo existindo a regra", onlyVaResult.status === INCOME_HORIZON_STATUS.FALLBACK && onlyVaResult.isFallback === true);

  // ---- A) recurring income prevista 24/09 sem Income -> DUE_TODAY em 24/09 ----
  const now24 = new Date("2026-09-24T00:00:00.000Z");
  const realizedBefore = await getRealizedOccurrences([salaryRule.id]);
  check("A) nenhuma ocorrência realizada ainda pra essa regra", realizedBefore.length === 0);
  const resultDueToday = resolveNextExpectedIncome({ now: now24, recurringRules: [salaryRule], realizedIncomes: realizedBefore, accounts, settings });
  check(
    "A) 24/09 sem Income real → DUE_TODAY em 24/09",
    resultDueToday.status === INCOME_HORIZON_STATUS.DUE_TODAY && iso(resultDueToday.expectedDate) === "2026-09-24",
    JSON.stringify({ ...resultDueToday, expectedDate: iso(resultDueToday.expectedDate) })
  );

  // ---- B) registrar explicitamente a ocorrência 24/09 ----
  const income = await recordRecurringIncomeOccurrence({
    recurringRuleId: salaryRule.id,
    recurringOccurrenceDate: "2026-09-24",
    accountId: checkingAccount.id,
    amount: 4937.18,
    description: `[${MARK}] Salário setembro`,
  });
  created.incomes.push(income.id);
  check(
    "B) Income criado com recurringRuleId + recurringOccurrenceDate corretos",
    income.recurringRuleId === salaryRule.id && iso(income.recurringOccurrenceDate) === "2026-09-24" && compareMoney(income.amount, 4937.18) === 0,
    JSON.stringify({ recurringRuleId: income.recurringRuleId, recurringOccurrenceDate: iso(income.recurringOccurrenceDate) })
  );

  // ---- C) resolver horizonte novamente -> próxima ocorrência = 24/10 ----
  const realizedAfter = await getRealizedOccurrences([salaryRule.id]);
  const resultAfterRealized = resolveNextExpectedIncome({ now: now24, recurringRules: [salaryRule], realizedIncomes: realizedAfter, accounts, settings });
  check(
    "C) após registrar 24/09, horizonte aponta pra próxima ocorrência 24/10",
    resultAfterRealized.status === INCOME_HORIZON_STATUS.UPCOMING && iso(resultAfterRealized.expectedDate) === "2026-10-24",
    JSON.stringify({ ...resultAfterRealized, expectedDate: iso(resultAfterRealized.expectedDate) })
  );

  // ---- D) tentar registrar a mesma recurringRule + occurrenceDate duas vezes -> rejeitado ----
  await expectThrow("D) registrar a mesma ocorrência (mesma regra + mesma data) duas vezes é rejeitado", () =>
    recordRecurringIncomeOccurrence({
      recurringRuleId: salaryRule.id,
      recurringOccurrenceDate: "2026-09-24",
      accountId: checkingAccount.id,
      amount: 999,
      description: `[${MARK}] duplicata`,
    })
  );
  const incomeCountForOccurrence = await prisma.income.count({ where: { recurringRuleId: salaryRule.id, recurringOccurrenceDate: new Date("2026-09-24T00:00:00.000Z") } });
  check("D) confirma só 1 Income existe pra essa ocorrência (não 2)", incomeCountForOccurrence === 1, String(incomeCountForOccurrence));

  // ---- E) 25/09 sem realização de 24/09 -> OVERDUE 24/09, não pula outubro ----
  // Usa uma SEGUNDA regra (independente, sem nenhum Income registrado) pra não
  // reaproveitar a ocorrência já realizada no caso B/C.
  const secondRule = await prisma.recurringRule.create({
    data: { name: `[${MARK}] Freela`, kind: "income", amount: 800, dayOfMonth: 24, accountId: checkingAccount.id },
  });
  created.recurringRules.push(secondRule.id);
  const now25 = new Date("2026-09-25T00:00:00.000Z");
  const realizedForSecond = await getRealizedOccurrences([secondRule.id]);
  const resultOverdue = resolveNextExpectedIncome({ now: now25, recurringRules: [secondRule], realizedIncomes: realizedForSecond, accounts, settings });
  check(
    "E) 25/09 sem Income de 24/09 → OVERDUE, continua em 24/09 (não pula pra outubro)",
    resultOverdue.status === INCOME_HORIZON_STATUS.OVERDUE && iso(resultOverdue.expectedDate) === "2026-09-24",
    JSON.stringify({ ...resultOverdue, expectedDate: iso(resultOverdue.expectedDate) })
  );

  // ---- F) Income comum sem recurringRule continua válido ----
  const plainIncome = await prisma.income.create({
    data: { amount: 100, description: `[${MARK}] Income avulso`, category: "Outros", accountId: checkingAccount.id, source: "manual" },
  });
  created.incomes.push(plainIncome.id);
  check("F) Income sem recurringRule/recurringOccurrenceDate continua válido", plainIncome.recurringRuleId === null && plainIncome.recurringOccurrenceDate === null);

  // ---- G) Income antigo com occurrenceDate NULL continua válido (nenhum backfill) ----
  const allIncomesNullCount = await prisma.income.count({ where: { recurringOccurrenceDate: null } });
  check("G) existem Incomes com recurringOccurrenceDate NULL (histórico não sofreu backfill)", allIncomesNullCount > 0, String(allIncomesNullCount));

  // ---- Validações de recordRecurringIncomeOccurrence (item 3) ----
  await expectThrow("recordRecurringIncomeOccurrence rejeita RecurringRule inexistente", () =>
    recordRecurringIncomeOccurrence({ recurringRuleId: "não-existe", recurringOccurrenceDate: "2026-09-24", accountId: checkingAccount.id, amount: 100 })
  );
  const expenseRule = await prisma.recurringRule.create({ data: { name: `[${MARK}] Aluguel`, kind: "expense", amount: 1000, dayOfMonth: 5 } });
  created.recurringRules.push(expenseRule.id);
  await expectThrow("recordRecurringIncomeOccurrence rejeita RecurringRule que não é kind=income", () =>
    recordRecurringIncomeOccurrence({ recurringRuleId: expenseRule.id, recurringOccurrenceDate: "2026-09-05", accountId: checkingAccount.id, amount: 100 })
  );
  await expectThrow("recordRecurringIncomeOccurrence rejeita conta diferente da configurada na regra", () =>
    recordRecurringIncomeOccurrence({ recurringRuleId: salaryRule.id, recurringOccurrenceDate: "2026-10-24", accountId: vaAccount.id, amount: 100 })
  );
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
