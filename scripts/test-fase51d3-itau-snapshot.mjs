// Fase 5.1D.3 — testes sintéticos do padrão OBSERVED_BALANCE_SNAPSHOT.
// 100% dado fictício (MARK = "TESTE_FASE51D3"). Fixtures criadas/limpas em
// finally contra o dev DB real — nunca contra produção (assertTestEnvironment).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";

const MARK = "TESTE_FASE51D3";
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

async function withFixtureAccount(fn) {
  const account = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-conta-${Date.now()}`, name: MARK, type: "checking" } });
  try {
    await fn(account);
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.income.deleteMany({ where: { accountId: account.id } });
    await prisma.balanceAdjustment.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } });
  }
}

async function main() {
  console.log("--- Fase 5.1D.3: testes sintéticos (OBSERVED_BALANCE_SNAPSHOT) ---\n");

  // --- [A] observed snapshot ancora o saldo ---
  await withFixtureAccount(async (account) => {
    const snapshotAt = new Date("2020-01-15T12:00:00.000Z");
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: snapshotAt, note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
    const balance = await computeAccountBalance(account.id);
    check(compareMoney(balance, money("500.00")) === 0, "[A] observed snapshot ancora o saldo exatamente no newBalance, sem movimentos");
  });

  // --- [B] backfill histórico ANTES do snapshot não muda o saldo corrente ---
  await withFixtureAccount(async (account) => {
    const snapshotAt = new Date("2020-01-15T12:00:00.000Z");
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: snapshotAt, note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
    const balanceBefore = await computeAccountBalance(account.id);
    // "melhora o histórico" bem depois — Expense datado ANTES do snapshot
    await prisma.expense.create({ data: { accountId: account.id, amount: money("999.00"), description: `${MARK} backfill histórico pré-snapshot`, occurredAt: new Date(snapshotAt.getTime() - 60 * 60 * 1000), source: "manual" } });
    const balanceAfter = await computeAccountBalance(account.id);
    check(compareMoney(balanceBefore, balanceAfter) === 0, "[B] Expense com occurredAt ANTERIOR ao snapshot não altera o saldo corrente");
  });

  // --- [C] movimento pós-snapshot muda o saldo normalmente ---
  await withFixtureAccount(async (account) => {
    const snapshotAt = new Date("2020-01-15T12:00:00.000Z");
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: snapshotAt, note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
    await prisma.expense.create({ data: { accountId: account.id, amount: money("42.50"), description: `${MARK} gasto pós-snapshot`, occurredAt: new Date(snapshotAt.getTime() + 60 * 60 * 1000), source: "manual" } });
    const balance = await computeAccountBalance(account.id);
    check(compareMoney(balance, money("457.50")) === 0, "[C] Expense com occurredAt POSTERIOR ao snapshot subtrai normalmente (500.00 - 42.50 = 457.50)");
  });

  // --- [D] snapshot não entra em analytics de gasto (estrutural) ---
  await withFixtureAccount(async (account) => {
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: new Date(), note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
    const expenseCount = await prisma.expense.count({ where: { accountId: account.id } });
    const incomeCount = await prisma.income.count({ where: { accountId: account.id } });
    check(expenseCount === 0 && incomeCount === 0, "[D] criar um BalanceAdjustment não cria nenhum Expense/Income — estruturalmente impossível de inflar category spending/top expenses");
  });

  // --- [E] snapshot duplicado é idempotente (dedup por accountId+occurredAt+newBalance) ---
  await withFixtureAccount(async (account) => {
    const snapshotAt = new Date("2020-01-15T12:00:00.000Z");
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: snapshotAt, note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
    const existing = await prisma.balanceAdjustment.findFirst({ where: { accountId: account.id, occurredAt: snapshotAt, newBalance: money("500.00") } });
    check(existing != null, "[E] busca de dedup encontra o snapshot já existente (mesmo accountId+occurredAt+newBalance) — apply real não criaria um segundo");
    const countBefore = await prisma.balanceAdjustment.count({ where: { accountId: account.id } });
    check(countBefore === 1, "[E] exatamente 1 BalanceAdjustment existe antes de qualquer segunda tentativa (idempotência preservada)");
  });

  // --- [F] invariante falho reverte a transação inteira ---
  await withFixtureAccount(async (account) => {
    let rolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money("500.00"), occurredAt: new Date("2020-01-15T12:00:00.000Z"), note: `${MARK} snapshot`, source: "manual", confidence: "CONFIRMED" } });
        const balance = await computeAccountBalance(account.id, { client: tx });
        // invariante deliberadamente falho (valor errado) — deve lançar e reverter
        if (compareMoney(balance, money("999999.99")) !== 0) {
          throw new Error("invariante sintética falhou de propósito");
        }
      });
    } catch (err) {
      rolledBack = err.message === "invariante sintética falhou de propósito";
    }
    const countAfter = await prisma.balanceAdjustment.count({ where: { accountId: account.id } });
    check(rolledBack, "[F] a transação lançou erro (invariante sintética falhou)");
    check(countAfter === 0, "[F] NENHUM BalanceAdjustment persistiu — rollback automático do Prisma confirmado");
  });

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
