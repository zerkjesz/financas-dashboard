-- CreateTable
CREATE TABLE "TelegramUpdateReceipt" (
    "id" TEXT NOT NULL,
    "updateId" BIGINT NOT NULL,
    "senderId" TEXT,
    "chatId" TEXT,
    "status" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramUpdateReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUpdateReceipt_updateId_key" ON "TelegramUpdateReceipt"("updateId");

-- CreateIndex
CREATE INDEX "TelegramUpdateReceipt_status_claimedAt_idx" ON "TelegramUpdateReceipt"("status", "claimedAt");
