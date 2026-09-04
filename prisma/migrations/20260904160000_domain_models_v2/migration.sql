-- Fase 3.3 — Domain Models V2: só estrutura, 100% aditiva.
-- Nenhuma tabela existente é removida. Nenhuma coluna existente é alterada.
-- Nenhum dado real é inserido — todas as tabelas novas nascem vazias.
--
-- 7 enums novos, 9 tabelas novas:
--   Reserve, ReserveMovement, ExternalInstallmentPlan, ExternalInstallment,
--   ConfirmedCommitment, Contingency, Receivable, CategoryBudget,
--   CardCreditMovement.
--
-- Seção 1 = exatamente o output de `prisma migrate diff` (CREATE TYPE/TABLE/INDEX/
-- FK — igual ao fluxo já usado nas Fases 3.1 e 3.2).
-- Seção 2 = CHECK constraints manuais que o Prisma schema DSL não expressa
-- nativamente (mesmo padrão do `USING ROUND(...)` da Fase 3.1) — closes o loop de
-- "defesa em duas camadas" pedido: validação na service (lib/*.js) + constraint no
-- banco, pra nenhum valor inválido sobreviver mesmo se um caminho de escrita novo
-- esquecer de validar.

-- ============================================================================
-- Seção 1 — schema (prisma migrate diff)
-- ============================================================================

-- CreateEnum
CREATE TYPE "ReserveMovementKind" AS ENUM ('ALLOCATE', 'REPLENISH', 'RELEASE', 'ADJUST_INCREASE', 'ADJUST_DECREASE');

-- CreateEnum
CREATE TYPE "ExternalInstallmentPlanStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExternalInstallmentStatus" AS ENUM ('PENDING', 'PAID');

-- CreateEnum
CREATE TYPE "ConfirmedCommitmentStatus" AS ENUM ('CONFIRMED', 'FUNDED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContingencyStatus" AS ENUM ('AWAITING_INFORMATION', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReceivableStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CardCreditMovementKind" AS ENUM ('CREDIT_GRANTED', 'CREDIT_APPLIED', 'ADJUST_INCREASE', 'ADJUST_DECREASE');

-- CreateTable
CREATE TABLE "Reserve" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmount" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reserve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveMovement" (
    "id" TEXT NOT NULL,
    "reserveId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" "ReserveMovementKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "confidence" "DataConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalInstallmentPlan" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "creditor" TEXT NOT NULL,
    "installmentValue" DECIMAL(12,2) NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "firstDueDate" TIMESTAMP(3) NOT NULL,
    "status" "ExternalInstallmentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "confidence" "DataConfidence",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalInstallmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalInstallment" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "ExternalInstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "expenseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfirmedCommitment" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "ConfirmedCommitmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "fundingAccountId" TEXT,
    "fundingReserveId" TEXT,
    "fundedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "expenseId" TEXT,
    "notes" TEXT,
    "confidence" "DataConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfirmedCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contingency" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "expectedAmount" DECIMAL(12,2),
    "maxAmount" DECIMAL(12,2) NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "status" "ContingencyStatus" NOT NULL DEFAULT 'AWAITING_INFORMATION',
    "notes" TEXT,
    "confidence" "DataConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contingency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "status" "ReceivableStatus" NOT NULL DEFAULT 'PENDING',
    "incomeId" TEXT,
    "confidence" "DataConfidence",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryBudget" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cycleStart" DATE NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardCreditMovement" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "kind" "CardCreditMovementKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "confidence" "DataConfidence",
    "cardBillId" TEXT,
    "transferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardCreditMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reserve_accountId_idx" ON "Reserve"("accountId");

-- CreateIndex
CREATE INDEX "ReserveMovement_reserveId_occurredAt_idx" ON "ReserveMovement"("reserveId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalInstallment_expenseId_key" ON "ExternalInstallment"("expenseId");

-- CreateIndex
CREATE INDEX "ExternalInstallment_dueDate_idx" ON "ExternalInstallment"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalInstallment_planId_number_key" ON "ExternalInstallment"("planId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ConfirmedCommitment_expenseId_key" ON "ConfirmedCommitment"("expenseId");

-- CreateIndex
CREATE INDEX "ConfirmedCommitment_status_idx" ON "ConfirmedCommitment"("status");

-- CreateIndex
CREATE INDEX "ConfirmedCommitment_dueDate_idx" ON "ConfirmedCommitment"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Receivable_incomeId_key" ON "Receivable"("incomeId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryBudget_category_cycleStart_key" ON "CategoryBudget"("category", "cycleStart");

-- CreateIndex
CREATE INDEX "CardCreditMovement_cardId_occurredAt_idx" ON "CardCreditMovement"("cardId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Reserve" ADD CONSTRAINT "Reserve_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveMovement" ADD CONSTRAINT "ReserveMovement_reserveId_fkey" FOREIGN KEY ("reserveId") REFERENCES "Reserve"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalInstallment" ADD CONSTRAINT "ExternalInstallment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ExternalInstallmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalInstallment" ADD CONSTRAINT "ExternalInstallment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmedCommitment" ADD CONSTRAINT "ConfirmedCommitment_fundingAccountId_fkey" FOREIGN KEY ("fundingAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmedCommitment" ADD CONSTRAINT "ConfirmedCommitment_fundingReserveId_fkey" FOREIGN KEY ("fundingReserveId") REFERENCES "Reserve"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmedCommitment" ADD CONSTRAINT "ConfirmedCommitment_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "Income"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCreditMovement" ADD CONSTRAINT "CardCreditMovement_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Seção 2 — CHECK constraints manuais (defesa em duas camadas: service + banco)
-- ============================================================================

-- ReserveMovement.amount é SEMPRE positivo — o sinal vem do `kind`, nunca do amount.
ALTER TABLE "ReserveMovement" ADD CONSTRAINT "ReserveMovement_amount_positive" CHECK ("amount" > 0);

-- ExternalInstallmentPlan: parcela e quantidade de parcelas sempre positivas.
ALTER TABLE "ExternalInstallmentPlan" ADD CONSTRAINT "ExternalInstallmentPlan_installmentValue_positive" CHECK ("installmentValue" > 0);
ALTER TABLE "ExternalInstallmentPlan" ADD CONSTRAINT "ExternalInstallmentPlan_installmentCount_positive" CHECK ("installmentCount" > 0);

-- ExternalInstallment: número de parcela e valor sempre positivos.
ALTER TABLE "ExternalInstallment" ADD CONSTRAINT "ExternalInstallment_number_positive" CHECK ("number" > 0);
ALTER TABLE "ExternalInstallment" ADD CONSTRAINT "ExternalInstallment_amount_positive" CHECK ("amount" > 0);

-- ConfirmedCommitment.amount sempre positivo.
ALTER TABLE "ConfirmedCommitment" ADD CONSTRAINT "ConfirmedCommitment_amount_positive" CHECK ("amount" > 0);

-- Contingency: maxAmount > 0; se expectedAmount existir, 0 <= expectedAmount <= maxAmount.
ALTER TABLE "Contingency" ADD CONSTRAINT "Contingency_maxAmount_positive" CHECK ("maxAmount" > 0);
ALTER TABLE "Contingency" ADD CONSTRAINT "Contingency_expectedAmount_within_max" CHECK ("expectedAmount" IS NULL OR ("expectedAmount" >= 0 AND "expectedAmount" <= "maxAmount"));

-- Receivable.amount sempre positivo.
ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_amount_positive" CHECK ("amount" > 0);

-- CardCreditMovement.amount é SEMPRE positivo — o sinal vem do `kind`, nunca do amount.
ALTER TABLE "CardCreditMovement" ADD CONSTRAINT "CardCreditMovement_amount_positive" CHECK ("amount" > 0);
