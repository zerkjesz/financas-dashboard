import { listAccountsWithBalances } from "./accounts.js";

// Fonte única pra "dinheiro livre" (Norte v2, regra 14): saldo de contas de uso livre
// (checking/cash), excluindo Vale Alimentação — VA é saldo restrito, não entra em
// "quanto eu tenho pra gastar" (regra 2). Antes desta função existiam 3 implementações
// divergentes (intelligence.js, indicators.js, cashFlowProjection.js), uma delas
// somando o saldo de VA por engano — ver AUDITORIA, achado P0-4.
export function computeFreeMoney(accounts) {
  return accounts
    .filter((a) => a.type === "checking" || a.type === "cash")
    .reduce((sum, a) => sum + a.balance, 0);
}

// Ids de conta que contam como "dinheiro livre" — usado por quem precisa filtrar
// eventos futuros (ex: receita recorrente) por conta em vez de só pelo saldo atual.
export function freeMoneyAccountIds(accounts) {
  return new Set(accounts.filter((a) => a.type === "checking" || a.type === "cash").map((a) => a.id));
}

export async function getFreeMoney(accountsIn) {
  const accounts = accountsIn || (await listAccountsWithBalances());
  return computeFreeMoney(accounts);
}
