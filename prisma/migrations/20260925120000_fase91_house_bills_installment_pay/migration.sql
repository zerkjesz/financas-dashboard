-- Fase 9.1 — contas da casa, pagamento de parcelas e devolução de capital.
-- Estritamente aditiva/relaxante: 2 DROP NOT NULL (dayOfMonth, Bill.dueDate), colunas novas com
-- DEFAULT (part=1, amountKind='FIXED', cadence='MONTHLY', partsPerCycle=1, settlementMode='EXPENSE')
-- e nullable (referenceMin/Max, notes, settledTransferId, shortLabel), 1 índice único trocado
-- (Bill: (rule,cycle) -> (rule,cycle,part); toda linha existente tem part=1, então continua única).
-- Nenhuma linha é apagada ou reescrita; nenhum dado é criado.
-- DropIndex
DROP INDEX "Bill_recurringRuleId_cycleMonth_key";

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "part" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "dueDate" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ConfirmedCommitment" ADD COLUMN     "settledTransferId" TEXT,
ADD COLUMN     "settlementMode" TEXT NOT NULL DEFAULT 'EXPENSE',
ADD COLUMN     "shortLabel" TEXT;

-- AlterTable
ALTER TABLE "RecurringRule" ADD COLUMN     "amountKind" TEXT NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "cadence" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "partsPerCycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "referenceMax" DECIMAL(12,2),
ADD COLUMN     "referenceMin" DECIMAL(12,2),
ALTER COLUMN "dayOfMonth" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Bill_recurringRuleId_cycleMonth_part_key" ON "Bill"("recurringRuleId", "cycleMonth", "part");

-- CreateIndex
CREATE UNIQUE INDEX "ConfirmedCommitment_settledTransferId_key" ON "ConfirmedCommitment"("settledTransferId");

-- AddForeignKey
ALTER TABLE "ConfirmedCommitment" ADD CONSTRAINT "ConfirmedCommitment_settledTransferId_fkey" FOREIGN KEY ("settledTransferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

