-- DropIndex
DROP INDEX "DataOperation_importBatchId_key";

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "resultCounts" JSONB;

-- CreateIndex
CREATE INDEX "DataOperation_importBatchId_idx" ON "DataOperation"("importBatchId");
