-- Fase 3.1 — converte os 17 campos monetários (Float -> Decimal(12,2)) que a
-- Fase 3.0 auditou e confirmou (ver docs/phase3-money-audit.md). Nenhum campo
-- não-monetário é tocado (LegacyTransaction.amount fica Float de propósito —
-- tabela congelada, não faz parte da arquitetura ativa).
--
-- USING ROUND(coluna::numeric, 2) explícito em cada ALTER, em vez do cast
-- implícito que o Prisma gera por padrão — não depende de o cast automático do
-- Postgres já dar 2 casas exatas (ele daria, já que double precision -> numeric
-- sem ROUND preservaria qualquer ruído binário sem limpar). O relatório da
-- Fase 3.0 já confirmou que nenhum valor muda com ROUND(2) neste banco (100%
-- dos registros já eram exatamente 2 casas) — este ROUND é defesa em
-- profundidade, não uma correção de dado esperada.

-- BalanceAdjustment.newBalance
ALTER TABLE "BalanceAdjustment" ALTER COLUMN "newBalance" TYPE DECIMAL(12,2) USING ROUND("newBalance"::numeric, 2);

-- Bill.amount
ALTER TABLE "Bill" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);

-- Card.totalLimit
ALTER TABLE "Card" ALTER COLUMN "totalLimit" TYPE DECIMAL(12,2) USING ROUND("totalLimit"::numeric, 2);

-- CardBill.totalAmount, CardBill.paidAmount
ALTER TABLE "CardBill" ALTER COLUMN "totalAmount" TYPE DECIMAL(12,2) USING ROUND("totalAmount"::numeric, 2);
ALTER TABLE "CardBill" ALTER COLUMN "paidAmount" TYPE DECIMAL(12,2) USING ROUND("paidAmount"::numeric, 2);

-- CardLimitUpdate.newTotalLimit, CardLimitUpdate.newUsedLimit, CardLimitUpdate.reportedAvailable
ALTER TABLE "CardLimitUpdate" ALTER COLUMN "newTotalLimit" TYPE DECIMAL(12,2) USING ROUND("newTotalLimit"::numeric, 2);
ALTER TABLE "CardLimitUpdate" ALTER COLUMN "newUsedLimit" TYPE DECIMAL(12,2) USING ROUND("newUsedLimit"::numeric, 2);
ALTER TABLE "CardLimitUpdate" ALTER COLUMN "reportedAvailable" TYPE DECIMAL(12,2) USING ROUND("reportedAvailable"::numeric, 2);

-- Expense.amount
ALTER TABLE "Expense" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);

-- Goal.targetAmount, Goal.savedAmount
ALTER TABLE "Goal" ALTER COLUMN "targetAmount" TYPE DECIMAL(12,2) USING ROUND("targetAmount"::numeric, 2);
ALTER TABLE "Goal" ALTER COLUMN "savedAmount" TYPE DECIMAL(12,2) USING ROUND("savedAmount"::numeric, 2);

-- Income.amount
ALTER TABLE "Income" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);

-- Installment.amount
ALTER TABLE "Installment" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);

-- Purchase.totalAmount, Purchase.installmentValue
ALTER TABLE "Purchase" ALTER COLUMN "totalAmount" TYPE DECIMAL(12,2) USING ROUND("totalAmount"::numeric, 2);
ALTER TABLE "Purchase" ALTER COLUMN "installmentValue" TYPE DECIMAL(12,2) USING ROUND("installmentValue"::numeric, 2);

-- RecurringRule.amount
ALTER TABLE "RecurringRule" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);

-- Transfer.amount
ALTER TABLE "Transfer" ALTER COLUMN "amount" TYPE DECIMAL(12,2) USING ROUND("amount"::numeric, 2);
