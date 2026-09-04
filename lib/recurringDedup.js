import { prisma } from "./prisma.js";

// Fase 4.0, item 13 — regra central de deduplicação RecurringRule <-> Bill
// materializada. A arquitetura JÁ possui uma referência confiável: o par
// (Bill.recurringRuleId, Bill.cycleMonth), com @@unique garantindo no banco que
// nunca existe mais de uma Bill pra mesma ocorrência da mesma regra — por isso
// esta fase NÃO precisa de heurística por descrição/valor nem redesenho de
// RecurringRule (ver prisma/schema.prisma, model Bill).
//
// Verificado por leitura de código nesta fase (não presumido): hoje NENHUM lugar
// do app projeta RecurringRule (kind=expense) diretamente como evento —
// lib/cashFlowProjection.js e lib/upcomingObligations.js só iteram
// `kind: "income"`; RecurringRule de despesa só aparece via a Bill materializada
// (lib/bills.js:ensureUpcomingRecurringBills -> getOrCreateBillForRule). Ou seja,
// não existe hoje um bug ATIVO de dupla contagem — este arquivo formaliza a regra
// como função pura/testável, pra qualquer código futuro (ex: obligation
// classifier agregando por categoria) consultar em vez de reimplementar.
//
// Regra: uma RecurringRule só deveria gerar um evento PROJETADO (ainda não
// materializado) quando NÃO existir Bill pra aquele recurringRuleId+cycleMonth —
// se existir, a Bill materializada é a fonte de verdade e substitui a projeção.

export async function isRecurringRuleOccurrenceMaterialized(recurringRuleId, cycleMonth) {
  const bill = await prisma.bill.findUnique({
    where: { recurringRuleId_cycleMonth: { recurringRuleId, cycleMonth } },
  });
  return bill != null;
}

// Filtra uma lista de RecurringRule pras que AINDA NÃO têm Bill materializada
// naquele cycleMonth — só essas deveriam virar evento projetado. Em lote (1
// query pro conjunto inteiro de regras, não N queries).
export async function filterUnmaterializedRules(rules, cycleMonth) {
  const ruleIds = rules.map((r) => r.id);
  if (ruleIds.length === 0) return [];
  const materialized = await prisma.bill.findMany({
    where: { recurringRuleId: { in: ruleIds }, cycleMonth },
    select: { recurringRuleId: true },
  });
  const materializedIds = new Set(materialized.map((b) => b.recurringRuleId));
  return rules.filter((r) => !materializedIds.has(r.id));
}
