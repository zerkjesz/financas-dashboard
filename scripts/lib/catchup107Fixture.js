// Fixture dos testes da Fase 10.7: estado da PROD DEPOIS da Fase 10.6 (13/10/2026) e ANTES da 10.7, montado dentro de uma transação de teste que
// SEMPRE reverte. Constrói o mundo pré-10.6, aplica o executor REAL da 10.6 e então ajusta os timestamps para os valores reais de PROD
// (âncoras de 13/10 19:25Z), que é o que a 10.7 encontra. Só roda com assertTestEnvironment() ativo no teste que importa.
import { buildCatchup106Plan } from "./catchup106Planner.js";
import { executeCatchup106Plan } from "./catchup106Executor.js";
import { wipe, seedBefore106, Rollback } from "./catchup106Fixture.js";
export { wipe, Rollback };

const d = (s) => new Date(s);
export const PROD_106_AT = d("2026-10-13T19:25:29.000Z");

export async function seedPost106(tx) {
  const w = await seedBefore106(tx);
  // regras recorrentes de renda existentes em PROD + ocorrências de setembro (padrão: banco 23, ocorrência 24 / 21)
  const salaryRule = await tx.recurringRule.create({ data: { name: "Salário", kind: "income", amount: "4937.18", dayOfMonth: 24, accountId: w.itau.id, category: "Renda", amountKind: "FIXED" } });
  const rechargeRule = await tx.recurringRule.create({ data: { name: "Vale Alimentação - Recarga", kind: "income", amount: "1300", dayOfMonth: 21, accountId: w.caju.id, category: "Trabalho", amountKind: "FIXED" } });
  await tx.income.create({ data: { amount: "4300.60", description: "Restante do salário — setembro/2026", category: "Trabalho", accountId: w.itau.id, recurringRuleId: salaryRule.id, recurringOccurrenceDate: d("2026-09-24T00:00:00Z"), isRecurring: true, occurredAt: d("2026-09-23T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
  await tx.income.create({ data: { amount: "1300", description: "Recarga mensal VA/Caju", category: "Trabalho", accountId: w.caju.id, recurringRuleId: rechargeRule.id, recurringOccurrenceDate: d("2026-09-21T00:00:00Z"), isRecurring: true, occurredAt: d("2026-09-23T00:00:00Z"), source: "manual", confidence: "CONFIRMED" } });
  await tx.confirmedCommitment.create({ data: { description: "Acordo Tiger — Leandro (saldo restante)", amount: "5000", dueDate: null, status: "CONFIRMED", shortLabel: "Tiger" } });
  // catch-up 10.6 pelo executor real
  const plan = await buildCatchup106Plan({ client: tx });
  if (plan.blockers.length) throw new Error("fixture: plano 10.6 com bloqueios " + plan.blockers.join("|"));
  await executeCatchup106Plan({ client: tx, plan });
  // o executor grava âncoras no instante da execução; em PROD foram gravadas em 13/10 19:25Z
  await tx.balanceAdjustment.updateMany({ where: { rawMessage: { startsWith: "FASE106-CATCHUP" } }, data: { occurredAt: PROD_106_AT } });
  await tx.cardLimitUpdate.updateMany({ where: { rawMessage: { startsWith: "FASE106-CATCHUP" } }, data: { occurredAt: PROD_106_AT } });
  await tx.cardBillReconciliation.updateMany({ where: { rawMessage: { startsWith: "FASE106-CATCHUP" } }, data: { createdAt: d("2026-10-13T19:25:31.000Z") } });
  return { ...w, salaryRule, rechargeRule };
}
