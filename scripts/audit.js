// ============================================================================
// scripts/audit.js — READ-ONLY, do início ao fim. Regra oficial (Norte v2):
//
// Este script NUNCA pode chamar uma função com semântica de getOrCreate/create/
// update/delete/upsert, nem qualquer mutation de qualquer tipo — nem sequer uma
// escrita idempotente (mesmo valor regravado). Só SELECT/aggregate/count.
//
// Motivo: este script é seguro por design pra rodar até contra produção (não
// precisa de assertTestEnvironment() — ver docs/dev-environment.md). Essa
// garantia só existe se ele for, de fato, 100% leitura. Se algum dia precisar
// adicionar uma checagem nova, ela tem que usar só find/aggregate/count — se a
// lógica que você precisa checar estiver hoje acoplada a uma função que também
// escreve (como getOrCreateBill em lib/cardBillCalculator.js), extraia a parte
// pura de cálculo pra sua própria função exportada (ver
// computeExpectedCardBillTotal, extraída exatamente por esse motivo) e chame só
// essa parte aqui.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";
// Decimal-first (Fase 3.1, Etapa 13): todo campo monetário lido do Prisma agora é
// Decimal (Prisma.Decimal/decimal.js) — nunca `+`/`-`/`Math.abs()` nativos nele (viram
// NaN/concatenação de string silenciosa, não um erro). Este script continua 100%
// leitura — só troca a aritmética por lib/money.js.
import { money, addMoney, subtractMoney } from "../lib/money.js";

const prisma = new PrismaClient();
const problems = [];

function check(label, ok, detail) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) problems.push(label);
}

// Recomputo independente do lib/accounts.js, só pra cruzar os dois caminhos.
async function rawAccountBalance(accountId) {
  const anchor = await prisma.balanceAdjustment.findFirst({ where: { accountId }, orderBy: { occurredAt: "desc" } });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = money(anchor?.newBalance);
  const [inc, exp, tOut, tIn] = await Promise.all([
    prisma.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);
  let balance = base;
  balance = addMoney(balance, inc._sum.amount);
  balance = subtractMoney(balance, exp._sum.amount);
  balance = addMoney(balance, tIn._sum.amount);
  balance = subtractMoney(balance, tOut._sum.amount);
  return balance;
}

async function auditAccountBalances() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const balance = await rawAccountBalance(account.id);
    check(`Saldo de "${account.name}" é finito e >= -0.01`, balance.isFinite() && balance.gte(-0.01), `R$ ${balance.toFixed(2)}`);
  }
}

// Saldo real (lib/accounts.js) precisa bater exatamente com o recompute independente
// (rawAccountBalance, acima) — os dois usam a MESMA fórmula (âncora + movimento real).
// Se algum dia alguém reintroduzir receita recorrente virtual na fórmula de saldo real
// (removida na Fase 1.1), essa checagem diverge e pega o regresso.
async function auditNoVirtualCreditInBalance() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const [real, raw] = await Promise.all([computeAccountBalance(account.id), rawAccountBalance(account.id)]);
    check(
      `Saldo real de "${account.name}" não inclui receita recorrente virtual`,
      subtractMoney(real, raw).abs().lt(0.01),
      `computeAccountBalance=R$ ${real.toFixed(2)}, recompute independente=R$ ${raw.toFixed(2)}`
    );
  }
}

// O painel de VA (buildVaSnapshot) não pode ter uma segunda fonte de verdade pro saldo
// — tem que bater exatamente com computeAccountBalance da Account correspondente (era
// o bug corrigido na Fase 1.2: vaPanel.js tinha seu próprio cálculo, que ainda somava
// recarga futura ao saldo mostrado).
async function auditVaSnapshotMatchesAccountBalance() {
  const account = await prisma.account.findUnique({ where: { slug: "vale-alimentacao" } });
  if (!account) {
    check("Conta de Vale Alimentação existe pra checar o painel", false, "conta não encontrada");
    return;
  }
  const [snapshot, realBalance] = await Promise.all([buildVaSnapshot(), computeAccountBalance(account.id)]);
  check(
    "Saldo do painel de VA (buildVaSnapshot) bate com o saldo real da Account",
    snapshot != null && subtractMoney(snapshot.balance, realBalance).abs().lt(0.01),
    `painel=R$ ${snapshot?.balance?.toFixed(2)}, Account real=R$ ${realBalance.toFixed(2)}`
  );
}

// Recomputa o total esperado de cada fatura em aberto usando só
// computeExpectedCardBillTotal (lib/cardBillCalculator.js) — uma função pura de
// leitura (aggregate), extraída de getOrCreateBill() especificamente pra isto.
// NUNCA chama getOrCreateBill() aqui — essa função pode fazer create/update.
async function auditCardBills() {
  const openBills = await prisma.cardBill.findMany({ where: { status: { in: ["open", "partially_paid"] } } });
  const cardsById = new Map();
  for (const bill of openBills) {
    let card = cardsById.get(bill.cardId);
    if (!card) {
      card = await prisma.card.findUnique({ where: { id: bill.cardId } });
      cardsById.set(bill.cardId, card);
    }
    const expected = await computeExpectedCardBillTotal(card, bill.cycleMonth);
    check(
      `CardBill ${bill.cycleMonth} bate com o recomputo (read-only)`,
      subtractMoney(bill.totalAmount, expected).abs().lt(0.01),
      `armazenado R$ ${bill.totalAmount.toFixed(2)}, esperado R$ ${expected.toFixed(2)}`
    );
  }
}

// Status derivado tem que bater com paidAmount vs totalAmount — pega qualquer fatura
// que ficou "paid" com pagamento parcial (bug corrigido na Fase 1, checa se sobrou
// dado antigo pra reconciliar) ou "partially_paid"/"open"/"closed" com paidAmount que
// já devia ter fechado como "paid".
async function auditCardBillStatus() {
  const bills = await prisma.cardBill.findMany();
  for (const bill of bills) {
    const paid = money(bill.paidAmount);
    const total = money(bill.totalAmount);
    const isPaidInFull = paid.gte(subtractMoney(total, 0.01)) && paid.gt(0);
    const expectedStatus =
      isPaidInFull
        ? "paid"
        : paid.gt(0)
          ? "partially_paid"
          : bill.status === "open" || bill.status === "closed"
            ? bill.status
            : null; // paidAmount 0 mas status "paid"/"partially_paid" também é inconsistente
    check(
      `CardBill ${bill.cardId}/${bill.cycleMonth} status bate com paidAmount`,
      expectedStatus === null ? bill.status !== "paid" && bill.status !== "partially_paid" : bill.status === expectedStatus,
      `status=${bill.status}, paidAmount=${paid.toFixed(2)}, totalAmount=${total.toFixed(2)}`
    );
  }
}

// Antecipação sem fromAccountId é o bug P0-1 da auditoria (dinheiro contado duas
// vezes) — depois da Fase 1, toda antecipação NOVA sempre tem fromAccountId; esta
// checagem existe pra pegar histórico ainda não reconciliado (Fase 4).
async function auditAnticipations() {
  const orphanAnticipations = await prisma.transfer.count({
    where: { kind: "installment_anticipation", fromAccountId: null },
  });
  check(
    "Nenhuma antecipação de fatura sem conta de origem (fromAccountId)",
    orphanAnticipations === 0,
    `${orphanAnticipations} encontrada(s) — reconciliação histórica pendente (Fase 4 da auditoria)`
  );
}

async function auditMigrationSums() {
  const legacyRows = await prisma.legacyTransaction.findMany();
  // LegacyTransaction.amount é Float de propósito (tabela congelada, fora do escopo
  // dos 17 campos convertidos — ver docs/phase3-money-audit.md) — soma via money.js
  // do mesmo jeito, só pra comparar com o lado Decimal sem gambiarra de tipo.
  const legacyByType = legacyRows.reduce((acc, r) => {
    acc[r.type] = addMoney(acc[r.type] || 0, r.amount);
    return acc;
  }, {});
  const [incomeSum, expenseSum] = await Promise.all([
    prisma.income.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
  ]);
  check(
    "Soma de Income migrado bate com transaction_legacy",
    subtractMoney(legacyByType.income || 0, incomeSum._sum.amount || 0).abs().lt(0.01)
  );
  check(
    "Soma de Expense migrado bate com transaction_legacy",
    subtractMoney(legacyByType.expense || 0, expenseSum._sum.amount || 0).abs().lt(0.01)
  );
}

async function auditOrphans() {
  const orphanExpenses = await prisma.expense.count({ where: { accountId: null, cardId: null } });
  check("Nenhuma Expense órfã (sem conta nem cartão)", orphanExpenses === 0, `${orphanExpenses} encontrada(s)`);

  const orphanBillRules = await prisma.bill.count({
    where: { recurringRuleId: { not: null }, recurringRule: { is: null } },
  });
  check("Nenhuma Bill com recurringRuleId inválido", orphanBillRules === 0, `${orphanBillRules} encontrada(s)`);

  const inactiveRuleBills = await prisma.bill.findMany({
    where: { status: { in: ["pending", "overdue"] }, recurringRuleId: { not: null }, recurringRule: { isActive: false } },
  });
  check("Nenhuma Bill pendente presa a RecurringRule inativa", inactiveRuleBills.length === 0, `${inactiveRuleBills.length} encontrada(s)`);
}

async function main() {
  console.log("--- Auditoria de consistência (read-only) ---\n");
  await auditAccountBalances();
  await auditNoVirtualCreditInBalance();
  await auditVaSnapshotMatchesAccountBalance();
  await auditCardBills();
  await auditCardBillStatus();
  await auditAnticipations();
  await auditMigrationSums();
  await auditOrphans();

  console.log(`\n${problems.length === 0 ? "✅ Tudo consistente." : `❌ ${problems.length} divergência(s) encontrada(s).`}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
