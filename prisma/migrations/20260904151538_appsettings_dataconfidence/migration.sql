-- Fase 3.2 — enum DataConfidence + coluna `confidence` (nullable, SEM default de
-- banco) nos 7 models aprovados + tabela singleton AppSettings (vazia — o seed
-- inicial é feito à parte, explicitamente, via scripts/seed-app-settings.mjs, nunca
-- por esta migration nem por um get-or-create escondido em código de leitura).
--
-- Por que `confidence` é nullable e sem DEFAULT aqui: um `DEFAULT 'CONFIRMED'`
-- faria todo registro histórico já existente virar CONFIRMED silenciosamente no
-- instante desta migration, afirmando uma certeza que a migration não tem como
-- verificar. NULL = "não classificado" (dado legado, de antes desta fase) é a
-- leitura honesta. Todo registro NOVO passa por
-- lib/dataConfidence.js:resolveConfidence(), que aplica CONFIRMED como default só
-- na camada de aplicação, nunca retroativamente aqui.

-- CreateEnum
CREATE TYPE "DataConfidence" AS ENUM ('CONFIRMED', 'CONFIRMED_BY_MEMORY', 'ESTIMATED', 'UNCERTAIN', 'RECONCILIATION_ADJUSTMENT');

-- AlterTable
ALTER TABLE "BalanceAdjustment" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "CardLimitUpdate" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "confidence" "DataConfidence";

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "confidence" "DataConfidence";

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "cycleStartDay" INTEGER NOT NULL,
    "safetyMarginPercent" INTEGER NOT NULL,
    "operationalHistoryStart" TIMESTAMP(3) NOT NULL,
    "vaHistoryStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);
