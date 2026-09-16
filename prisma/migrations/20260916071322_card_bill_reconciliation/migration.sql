-- CreateTable
CREATE TABLE "CardBillReconciliation" (
    "id" TEXT NOT NULL,
    "cardBillId" TEXT,
    "cardId" TEXT NOT NULL,
    "cycleMonth" TEXT NOT NULL,
    "observedTotal" DECIMAL(12,2) NOT NULL,
    "calculatedTotal" DECIMAL(12,2) NOT NULL,
    "delta" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "confidence" "DataConfidence" NOT NULL DEFAULT 'RECONCILIATION_ADJUSTMENT',
    "rawMessage" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardBillReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardBillReconciliation_cardId_cycleMonth_idx" ON "CardBillReconciliation"("cardId", "cycleMonth");

-- AddForeignKey
ALTER TABLE "CardBillReconciliation" ADD CONSTRAINT "CardBillReconciliation_cardBillId_fkey" FOREIGN KEY ("cardBillId") REFERENCES "CardBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardBillReconciliation" ADD CONSTRAINT "CardBillReconciliation_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
