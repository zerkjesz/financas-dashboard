-- CreateEnum
CREATE TYPE "DataOperationType" AS ENUM ('EXPORT', 'IMPORT_PREVIEW', 'IMPORT_APPLY', 'IMPORT_FAILED', 'IMPORT_UNDO');

-- CreateEnum
CREATE TYPE "DataOperationStatus" AS ENUM ('SUCCESS', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING_APPLY', 'APPLIED', 'UNDONE', 'EXPIRED', 'ABORTED');

-- CreateTable
CREATE TABLE "DataOperation" (
    "id" TEXT NOT NULL,
    "type" "DataOperationType" NOT NULL,
    "status" "DataOperationStatus" NOT NULL,
    "mode" TEXT,
    "datasets" TEXT[],
    "fileName" TEXT,
    "fileHash" TEXT,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "datasets" TEXT[],
    "rows" JSONB NOT NULL,
    "plan" JSONB NOT NULL,
    "planFingerprint" JSONB NOT NULL,
    "resolutions" JSONB,
    "preimages" JSONB,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING_APPLY',
    "appliedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "undoDeadline" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataOperation_importBatchId_key" ON "DataOperation"("importBatchId");

-- CreateIndex
CREATE INDEX "DataOperation_createdAt_idx" ON "DataOperation"("createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_status_createdAt_idx" ON "ImportBatch"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "DataOperation" ADD CONSTRAINT "DataOperation_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
