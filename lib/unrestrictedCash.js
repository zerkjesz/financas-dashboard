import { listAccountsWithBalances } from "./accounts.js";
import { sumMoney } from "./money.js";

// unrestrictedCash = checking + cash reais, excluindo Vale Alimentação (saldo restrito
// — não pode virar aluguel, cartão, etc). ISSO NÃO É "freeMoney" nem "safeToSpend" —
// esses dois nomes são reservados pra quando existirem reservas/dívidas/compromissos
// (Fase 3 da auditoria) e a fórmula final descontar tudo isso. Definições oficiais
// (Norte v2, Fase 1.1):
//   totalBalances     = todos os saldos acompanhados, inclusive VA.
//   unrestrictedCash  = checking + cash reais (esta função).
//   restrictedBalance = VA e outros saldos restritos.
//   freeMoney         = ainda não implementado — unrestrictedCash menos reservas/
//                        dívidas/compromissos.
//   safeToSpend       = ainda não implementado — derivado de freeMoney.
//
// Decimal-first (Fase 3.1): account.balance já vem como Decimal de
// listAccountsWithBalances(). Devolve Decimal — serializeMoney() só na borda da API.
export function computeUnrestrictedCash(accounts) {
  const values = accounts.filter((a) => a.type === "checking" || a.type === "cash").map((a) => a.balance);
  return sumMoney(values);
}

// Ids de conta que contam como unrestrictedCash — usado por quem precisa filtrar
// eventos futuros (ex: receita recorrente) por conta em vez de só pelo saldo atual.
export function unrestrictedCashAccountIds(accounts) {
  return new Set(accounts.filter((a) => a.type === "checking" || a.type === "cash").map((a) => a.id));
}

export async function getUnrestrictedCash(accountsIn) {
  const accounts = accountsIn || (await listAccountsWithBalances());
  return computeUnrestrictedCash(accounts);
}
