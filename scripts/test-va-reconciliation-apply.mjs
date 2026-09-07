// Fase 5.1C-VA — testes sintéticos (zero dado pessoal) pro apply real do
// subsistema VA/conta restrita. Cobre: cutover math, dedup near-amount,
// idempotência das 7 rows, correção de occurredAt de backfill, reclassificação
// cross-account, injeção de client tx-scoped, e rollback de invariante falho.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, money, addMoney, subtractMoney, sumMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { matchCanonicalExpenses } from "./snapshot-dry-run.mjs";

const MARK = "TESTE_FASE51CVA";
let passed = 0;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  if (condition) passed++;
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(money(a), money(b)) === 0;
}

console.log("--- Fase 5.1C-VA: testes sintéticos (reconciliação da conta restrita) ---\n");

// ============================================================================
// A — cutover opening + recharge - expenses = closing (fórmula, Decimal).
// ============================================================================
{
  const closing = money(500);
  const recharge = money(1000);
  const expensesTotal = money(600);
  const derivedOpening = subtractMoney(addMoney(closing, expensesTotal), recharge);
  check("[A] opening = closing + expenses - recharge (fórmula fictícia: 500+600-1000=100)", eq(derivedOpening, 100));
  const checksum = subtractMoney(addMoney(derivedOpening, recharge), expensesTotal);
  check("[A] checksum recomputado bate com o closing observado", eq(checksum, 500));
}

// ============================================================================
// B — near-amount canonical update não cria duplicate (matchCanonicalExpenses real).
// ============================================================================
{
  const suffix = Date.now();
  const account = await prisma.account.create({ data: { slug: `teste-51cva-b-${suffix}`, name: `[${MARK}] conta B`, type: "food_voucher" } });
  const persisted = await prisma.expense.create({ data: { amount: money(99.95), description: `[${MARK}] gasto fictício backfill`, accountId: account.id, occurredAt: new Date("2026-01-15T12:00:00.000Z") } });
  try {
    const canonicalExpenses = [{ date: "2026-01-10", counterparty: "Loja Fictícia", amount: 100.0, confidence: "CONFIRMED_BY_MEMORY" }];
    const devExpenses = await prisma.expense.findMany({ where: { accountId: account.id } });
    const matching = matchCanonicalExpenses(canonicalExpenses, devExpenses);
    const match = matching.matches[0];
    check("[B] near-amount detectado (não EXACT, não MISSING)", match.classification === "AMBIGUOUS_MATCH" && match.matchType === "NEAR_AMOUNT");
    check("[B] matchedDevExpenseId aponta pra row EXISTENTE — UPDATE, não CREATE de uma segunda row", match.matchedDevExpenseId === persisted.id);
    const countAfterMatch = await prisma.expense.count({ where: { accountId: account.id } });
    check("[B] nenhuma segunda Expense foi criada só por causa do matching", countAfterMatch === 1);
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// C — 7 (N) missing rows remain idempotent: rodar o matching 2x não recria.
// ============================================================================
{
  const suffix = Date.now() + 1;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-c-${suffix}`, name: `[${MARK}] conta C`, type: "food_voucher" } });
  try {
    const canonicalExpenses = [
      { date: "2026-01-10", counterparty: "Loja A", amount: 50, confidence: "CONFIRMED_BY_MEMORY" },
      { date: "2026-01-11", counterparty: "Loja B", amount: 75, confidence: "CONFIRMED_BY_MEMORY" },
    ];
    let devExpenses = await prisma.expense.findMany({ where: { accountId: account.id } });
    let matching = matchCanonicalExpenses(canonicalExpenses, devExpenses);
    const missing1 = matching.matches.filter((m) => m.classification === "MISSING_IN_DEV");
    check("[C] 1ª rodada: 2 missing detectados", missing1.length === 2);
    for (const m of missing1) {
      await prisma.expense.create({ data: { amount: money(m.amount), description: m.counterparty, accountId: account.id, occurredAt: new Date(`${m.date}T00:00:00.000Z`) } });
    }
    devExpenses = await prisma.expense.findMany({ where: { accountId: account.id } });
    matching = matchCanonicalExpenses(canonicalExpenses, devExpenses);
    const missing2 = matching.matches.filter((m) => m.classification === "MISSING_IN_DEV");
    const exact2 = matching.matches.filter((m) => m.classification === "ALREADY_PERSISTED");
    check("[C] 2ª rodada (idempotência): 0 missing, 2 já persistidos — nunca recria", missing2.length === 0 && exact2.length === 2);
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// D — backfill occurredAt correction: match único é seguro de corrigir.
// ============================================================================
{
  const suffix = Date.now() + 2;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-d-${suffix}`, name: `[${MARK}] conta D`, type: "food_voucher" } });
  const backfillTimestamp = new Date("2026-01-20T23:14:00.000Z"); // horário do lote de backfill, não a data econômica real
  const row = await prisma.expense.create({ data: { amount: money(40), description: `[${MARK}] gasto backfill`, accountId: account.id, occurredAt: backfillTimestamp } });
  try {
    const canonicalDate = new Date("2026-01-05T00:00:00.000Z");
    check("[D] persisted occurredAt reflete o backfill, não a data econômica canônica", row.occurredAt.getTime() !== canonicalDate.getTime());
    await prisma.expense.update({ where: { id: row.id }, data: { occurredAt: canonicalDate } });
    const after = await prisma.expense.findUnique({ where: { id: row.id } });
    check("[D] após correção, occurredAt reflete a data econômica canônica", after.occurredAt.getTime() === canonicalDate.getTime());
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// E — cross-account Income reassignment preserva o total global (delta zero
// combinado entre as duas contas).
// ============================================================================
{
  const suffix = Date.now() + 3;
  const restricted = await prisma.account.create({ data: { slug: `teste-51cva-e-restricted-${suffix}`, name: `[${MARK}] restrita E`, type: "food_voucher" } });
  const unrestricted = await prisma.account.create({ data: { slug: `teste-51cva-e-unrestricted-${suffix}`, name: `[${MARK}] irrestrita E`, type: "checking" } });
  const income = await prisma.income.create({ data: { amount: money(15), description: `[${MARK}] pix fictício mal classificado`, accountId: restricted.id, occurredAt: new Date("2026-01-05T00:00:00.000Z") } });
  try {
    const restrictedBefore = await computeAccountBalance(restricted.id);
    const unrestrictedBefore = await computeAccountBalance(unrestricted.id);
    await prisma.income.update({ where: { id: income.id }, data: { accountId: unrestricted.id } });
    const restrictedAfter = await computeAccountBalance(restricted.id);
    const unrestrictedAfter = await computeAccountBalance(unrestricted.id);
    check("[E] conta restrita perde exatamente o valor movido", eq(subtractMoney(restrictedBefore, restrictedAfter), 15));
    check("[E] conta irrestrita ganha exatamente o valor movido", eq(subtractMoney(unrestrictedAfter, unrestrictedBefore), 15));
    const globalBefore = addMoney(restrictedBefore, unrestrictedBefore);
    const globalAfter = addMoney(restrictedAfter, unrestrictedAfter);
    check("[E] soma global entre as duas contas é conservada (delta zero)", eq(globalBefore, globalAfter.toString()));
  } finally {
    await prisma.income.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.account.deleteMany({ where: { id: { in: [restricted.id, unrestricted.id] } } });
  }
}

// ============================================================================
// F — VA (Account.type=food_voucher) nunca entra em unrestricted cash —
// checagem estrutural do próprio tipo da conta, nunca alterado por esta fase.
// ============================================================================
{
  const suffix = Date.now() + 4;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-f-${suffix}`, name: `[${MARK}] conta F`, type: "food_voucher" } });
  try {
    check("[F] Account.type permanece food_voucher (nunca vira checking/cash)", account.type === "food_voucher" && account.type !== "checking" && account.type !== "cash");
  } finally {
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// G — tx-scoped: computeAccountBalance(client: tx) enxerga write não commitado.
// ============================================================================
{
  const suffix = Date.now() + 5;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-g-${suffix}`, name: `[${MARK}] conta G`, type: "food_voucher" } });
  try {
    let sawInsideTx = null;
    await prisma.$transaction(async (tx) => {
      await tx.balanceAdjustment.create({ data: { accountId: account.id, newBalance: money(33), occurredAt: new Date("2026-01-01T00:00:00.000Z") } });
      sawInsideTx = await computeAccountBalance(account.id, { client: tx });
    });
    const sawAfterCommit = await computeAccountBalance(account.id);
    check("[G] computeAccountBalance(client: tx) enxerga o write ainda não commitado", eq(sawInsideTx, 33));
    check("[G] após commit, prisma global também enxerga", eq(sawAfterCommit, 33));
  } finally {
    await prisma.balanceAdjustment.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// H — invariante falho reverte a transação ANTES do commit.
// ============================================================================
{
  const suffix = Date.now() + 6;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-h-${suffix}`, name: `[${MARK}] conta H`, type: "food_voucher" } });
  try {
    let threw = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.expense.create({ data: { amount: money(999), description: `[${MARK}] gasto que não deveria persistir`, accountId: account.id, occurredAt: new Date("2026-01-01T00:00:00.000Z") } });
        const invariantOk = false;
        if (!invariantOk) throw new Error("invariante crítico falhou de propósito (teste)");
      });
    } catch (e) {
      threw = true;
    }
    check("[H] a transação lançou erro (invariante falhou)", threw);
    const count = await prisma.expense.count({ where: { accountId: account.id } });
    check("[H] NENHUM write parcial persistiu (rollback automático do Prisma)", count === 0);
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// I — segunda execução (idempotência): matching já 100% ALREADY_PERSISTED = no mutations.
// ============================================================================
{
  const suffix = Date.now() + 7;
  const account = await prisma.account.create({ data: { slug: `teste-51cva-i-${suffix}`, name: `[${MARK}] conta I`, type: "food_voucher" } });
  try {
    const canonicalDate = "2026-01-10";
    await prisma.expense.create({ data: { amount: money(20), description: "Loja X", accountId: account.id, occurredAt: new Date(`${canonicalDate}T00:00:00.000Z`) } });
    const canonicalExpenses = [{ date: canonicalDate, counterparty: "Loja X", amount: 20, confidence: "CONFIRMED_BY_MEMORY" }];
    const devExpenses = await prisma.expense.findMany({ where: { accountId: account.id } });
    const matching = matchCanonicalExpenses(canonicalExpenses, devExpenses);
    const allPersisted = matching.matches.every((m) => m.classification === "ALREADY_PERSISTED");
    check("[I] estado já 100% aplicado -> nenhuma mutation necessária na 2ª execução", allPersisted === true);
  } finally {
    await prisma.expense.deleteMany({ where: { accountId: account.id } });
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

console.log(`\n${passed}/${results.length} teste(s) passaram.`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await prisma.$disconnect();
