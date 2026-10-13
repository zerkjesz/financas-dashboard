-- CreateTable
CREATE TABLE "InternalReimbursement" (
    "id" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceExpenseId" TEXT,
    "sourceLabel" TEXT,
    "settledAt" TIMESTAMP(3),
    "transferId" TEXT,
    "confidence" "DataConfidence",
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalReimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalReimbursement_transferId_key" ON "InternalReimbursement"("transferId");

-- CreateIndex
CREATE INDEX "InternalReimbursement_status_idx" ON "InternalReimbursement"("status");

-- CreateIndex
CREATE INDEX "InternalReimbursement_fromAccountId_status_idx" ON "InternalReimbursement"("fromAccountId", "status");

-- AddForeignKey
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_sourceExpenseId_fkey" FOREIGN KEY ("sourceExpenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Integridade (mesmo padrão de ReserveMovement/CardCreditMovement): valor sempre positivo, status fechado, origem ≠ destino.
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_status_valid" CHECK ("status" IN ('PENDING', 'SETTLED', 'CANCELLED'));
ALTER TABLE "InternalReimbursement" ADD CONSTRAINT "InternalReimbursement_accounts_differ" CHECK ("fromAccountId" <> "toAccountId");
