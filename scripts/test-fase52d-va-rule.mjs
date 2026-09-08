// Fase 5.2D — testes de integração (dado 100% fictício, MARK="TESTE_FASE52D",
// fixtures criadas/limpas em finally) provando que corrigir dayOfMonth numa
// RecurringRule de renda restrita (tipo VA) nunca mexe em saldo, nunca
// materializa Income, e nunca toca uma RecurringRule de renda IRRESTRITA
// coexistente (o cenário real: salário e VA acabaram no mesmo dia por
// coincidência).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { nextOccurrence } from "../lib/recurringCycles.js";

const MARK = "TESTE_FASE52D";
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.error(`❌ ${label}`);
  }
}

async function main() {
  console.log("--- Fase 5.2D: correção de RecurringRule restrita (dueDay) ---\n");

  const restricted = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-restrita-${Date.now()}`, name: `${MARK} restrita`, type: "food_voucher" } });
  const unrestricted = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-irrestrita-${Date.now()}`, name: `${MARK} irrestrita`, type: "checking" } });
  const restrictedRule = await prisma.recurringRule.create({ data: { name: `${MARK} recarga restrita`, kind: "income", amount: money(500), dayOfMonth: 24, accountId: restricted.id } });
  const unrestrictedRule = await prisma.recurringRule.create({ data: { name: `${MARK} renda irrestrita`, kind: "income", amount: money(3000), dayOfMonth: 24, accountId: unrestricted.id } });
  await prisma.balanceAdjustment.create({ data: { accountId: restricted.id, newBalance: money(200), source: "manual", note: MARK } });

  try {
    // --- [A] update só muda a recorrência, nada mais ---
    const before = await prisma.recurringRule.findUnique({ where: { id: restrictedRule.id } });
    await prisma.recurringRule.update({ where: { id: restrictedRule.id }, data: { dayOfMonth: 21 } });
    const after = await prisma.recurringRule.findUnique({ where: { id: restrictedRule.id } });
    check(before.dayOfMonth === 24 && after.dayOfMonth === 21, "[A] UPDATE muda dayOfMonth de 24 para 21");
    check(compareMoney(money(after.amount), money(before.amount)) === 0, "[A] amount permanece inalterado após o UPDATE");
    check(after.accountId === before.accountId, "[A] accountId permanece inalterado após o UPDATE");

    // --- [B] saldo da conta restrita inalterado ---
    const balanceAfter = await computeAccountBalance(restricted.id);
    check(compareMoney(balanceAfter, money(200)) === 0, "[B] saldo da conta restrita permanece 200 (UPDATE de forecast não move saldo)");

    // --- [C] nenhuma Income futura materializada ---
    const incomeCount = await prisma.income.count({ where: { recurringRuleId: restrictedRule.id } });
    check(incomeCount === 0, "[C] nenhuma Income foi criada pra essa RecurringRule (correção é só forecast, nunca lançamento)");

    // --- [D] rule de renda IRRESTRITA coexistente não é tocada ---
    const unrestrictedAfter = await prisma.recurringRule.findUnique({ where: { id: unrestrictedRule.id } });
    check(unrestrictedAfter.dayOfMonth === 24, "[D] RecurringRule de renda irrestrita com o MESMO dayOfMonth (24) permanece intocada");
    check(compareMoney(money(unrestrictedAfter.amount), money(3000)) === 0, "[D] amount da rule irrestrita permanece inalterado");

    // --- [E] próxima ocorrência reflete o novo dia (função pura real, não reimplementada) ---
    const now = new Date("2026-09-01T00:00:00.000Z");
    const nextBefore = nextOccurrence(before.dayOfMonth, now);
    const nextAfter = nextOccurrence(after.dayOfMonth, now);
    check(nextBefore.getUTCDate() === 24, "[E] nextOccurrence com o dia ANTIGO (24) cai no dia 24");
    check(nextAfter.getUTCDate() === 21, "[E] nextOccurrence com o dia CORRIGIDO (21) cai no dia 21 — reflete a mudança sem reimplementar a lógica de recorrência");
  } finally {
    await prisma.recurringRule.delete({ where: { id: restrictedRule.id } }).catch(() => {});
    await prisma.recurringRule.delete({ where: { id: unrestrictedRule.id } }).catch(() => {});
    await prisma.balanceAdjustment.deleteMany({ where: { accountId: restricted.id } });
    await prisma.account.delete({ where: { id: restricted.id } });
    await prisma.account.delete({ where: { id: unrestricted.id } });
  }

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  const leftover = await prisma.recurringRule.count({ where: { name: { contains: MARK } } });
  console.log(`Limpeza confirmada: ${leftover} rules de teste remanescentes (esperado 0).`);
  await prisma.$disconnect();
  if (failed > 0 || leftover > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
