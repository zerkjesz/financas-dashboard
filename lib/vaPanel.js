import { prisma } from "./prisma.js";
import { getAccountBySlug, computeAccountBalance } from "./accounts.js";
import { nextOccurrence, daysBetween } from "./recurringCycles.js";

// Saldo atual do VA vem da MESMA fonte de verdade usada pelo resto do sistema
// (computeAccountBalance, lib/accounts.js) — este arquivo NÃO mantém mais um cálculo
// de saldo próprio e independente. Antes havia um "crédito virtual" de recarga
// esperada-mas-ainda-não-lançada somado aqui, divergente do que accounts.js calculava
// pro mesmo Account — o mesmo bug que a Fase 1.1 já tinha corrigido em
// computeAccountBalance, só que reimplementado de novo aqui (Norte v2, Fase 1.2).
// A recarga esperada continua disponível como `nextRecharge`/`diasRestantes`
// (informativo), nunca somada ao saldo.
export async function buildVaSnapshot() {
  const account = await getAccountBySlug("vale-alimentacao");
  if (!account) return null;

  const now = new Date();
  const [rule, anchor, balance] = await Promise.all([
    prisma.recurringRule.findFirst({ where: { accountId: account.id, kind: "income", isActive: true } }),
    prisma.balanceAdjustment.findFirst({ where: { accountId: account.id }, orderBy: { occurredAt: "desc" } }),
    computeAccountBalance(account.id),
  ]);
  const since = anchor?.occurredAt ?? new Date(0);

  // Métricas do ciclo (recebido/gasto desde a última âncora) — só pra explicar a
  // composição do saldo na tela, não pra reconstruí-lo. `balance` acima já é o valor
  // oficial.
  const [incomeSum, expenseSum] = await Promise.all([
    prisma.income.aggregate({ where: { accountId: account.id, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId: account.id, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);

  let nextRecharge = null;
  let diasRestantes = null;
  if (rule?.amount != null) {
    nextRecharge = nextOccurrence(rule.dayOfMonth, now);
    diasRestantes = daysBetween(now, nextRecharge);
  }

  const recebido = incomeSum._sum.amount || 0;
  const gasto = expenseSum._sum.amount || 0;
  const metaDiaria = diasRestantes && diasRestantes > 0 ? balance / diasRestantes : balance;

  return { account, balance, recebido, gasto, diasRestantes, nextRecharge, metaDiaria };
}
