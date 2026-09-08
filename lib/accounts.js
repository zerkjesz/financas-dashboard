import { prisma } from "./prisma.js";
import { money, addMoney, subtractMoney } from "./money.js";

// Saldo de uma conta = última âncora declarada (BalanceAdjustment) + lançamentos reais
// desde então (Income, Expense, Transfer). NÃO inclui receita recorrente esperada que
// ainda não foi lançada como Income de verdade, mesmo que a data já tenha passado —
// saldo real só reflete movimento real e persistido. Isso ficou explícito na Fase 1.1
// (removido um "crédito virtual" que somava recorrência vencida-mas-não-lançada aqui).
// Receita esperada continua disponível pra projeção/timeline/alertas — ver
// lib/cashFlowProjection.js, que projeta a PRÓXIMA ocorrência futura de cada
// RecurringRule independentemente do saldo — nunca pra saldo atual.
//
// Decimal-first (Fase 3.1): todos os campos monetários envolvidos (newBalance,
// amount) já vêm do Prisma como Decimal (schema convertido). O cálculo inteiro
// roda em Decimal — devolve Decimal, não number. Quem consome (rota de API)
// converte via lib/money.js:serializeMoney() só na borda.
// Fase 5.1C-VA — `client` opcional (default: o singleton `prisma`), mesmo
// padrão de lib/cardBillCalculator.js/lib/cards.js (Fase 5.1B-CARD-v2):
// permite validar com `{ client: tx }` DENTRO de uma
// `prisma.$transaction(async tx => ...)`, contra o estado ainda não
// commitado. Aditivo — nenhum call-site existente muda de comportamento.
export async function computeAccountBalance(accountId, { client = prisma } = {}) {
  const anchor = await client.balanceAdjustment.findFirst({
    where: { accountId },
    orderBy: { occurredAt: "desc" },
  });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = money(anchor?.newBalance);

  const [incomeSum, expenseSum, transfersOut, transfersIn] = await Promise.all([
    client.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    client.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    client.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    client.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);

  let balance = base;
  balance = addMoney(balance, incomeSum._sum.amount);
  balance = subtractMoney(balance, expenseSum._sum.amount);
  balance = addMoney(balance, transfersIn._sum.amount);
  balance = subtractMoney(balance, transfersOut._sum.amount);
  return balance;
}

// Fase 5.3B prep — `client` opcional (default: `prisma`), mesmo padrão aditivo
// já usado em computeAccountBalance acima. Nenhum call-site existente muda de
// comportamento.
export async function listAccountsWithBalances({ client = prisma } = {}) {
  const accounts = await client.account.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      balance: await computeAccountBalance(account.id, { client }),
    }))
  );
}

export async function getAccountBySlug(slug, { client = prisma } = {}) {
  return client.account.findUnique({ where: { slug } });
}
