-- Fase 4.0.2 — vincula explicitamente um Income à ocorrência PREVISTA (pela data
-- exata, não mês calendário/ciclo financeiro) de uma RecurringRule. Aditiva,
-- coluna nullable, SEM backfill: todo Income existente antes desta fase fica com
-- recurringOccurrenceDate NULL, mesmo os que já tenham recurringRuleId setado
-- (nenhum tem, hoje — confirmado por leitura de código antes desta migration).
--
-- Unique composta (recurringRuleId, recurringOccurrenceDate): identifica "a
-- RecurringRule X + a ocorrência prevista na data Y" sem ambiguidade — mesma
-- ideia de Bill(recurringRuleId, cycleMonth), mas por DATA exata em vez de mês,
-- porque mês calendário/ciclo financeiro/ocorrência recorrente são três
-- conceitos diferentes que não devem se misturar num só campo.
--
-- NULLs não conflitam entre si numa unique composta do Postgres (comportamento
-- padrão, NULLS DISTINCT) — histórico com (ruleId, NULL) ou (NULL, NULL) nunca
-- colide com nenhum outro registro, então nenhum backfill é necessário nem
-- possível de quebrar por essa constraint.

-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "recurringOccurrenceDate" DATE;

-- CreateIndex
CREATE UNIQUE INDEX "Income_recurringRuleId_recurringOccurrenceDate_key" ON "Income"("recurringRuleId", "recurringOccurrenceDate");
