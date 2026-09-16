-- Fase 7.0.2, item 1 — reescrita pra ser production-safe INDEPENDENTE do
-- estado da tabela Transfer. A versão anterior desta migração
-- (`ALTER TABLE "Transfer" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL`, sem
-- default) só funcionava numa tabela vazia — contra uma tabela com rows
-- reais (produção), o Postgres rejeita a coluna NOT NULL sem valor pra
-- preencher as linhas já existentes, e a migração inteira falharia.
--
-- Esta versão nunca depende de a tabela estar vazia:
--   1. adiciona a coluna NULLABLE (sempre segura, qualquer que seja o
--      estado da tabela — zero erro, zero linha tocada ainda);
--   2. preenche TODA linha existente com um valor real e coerente
--      (occurredAt, se existir; senão createdAt; senão agora — nunca NULL,
--      nunca um valor arbitrário desconectado do registro);
--   3. só DEPOIS de toda linha ter um valor, torna a coluna NOT NULL.
--
-- Zero DELETE, zero TRUNCATE, zero coluna/linha removida — só ADD + UPDATE +
-- SET NOT NULL. Idempotente pra rodar contra tabela vazia (UPDATE não afeta
-- nada) ou populada (UPDATE preenche cada linha real).

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Backfill: nunca perde o dado de quando o registro realmente aconteceu.
UPDATE "Transfer" SET "updatedAt" = COALESCE("occurredAt", "createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;

-- Só agora, com toda linha já preenchida, a coluna pode virar NOT NULL.
ALTER TABLE "Transfer" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "TelegramCorrectionAudit" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "preimage" JSONB NOT NULL,
    "fieldChanges" JSONB,
    "chatId" TEXT,
    "telegramUpdateId" TEXT,
    "rawMessage" TEXT,
    "undoesAuditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramCorrectionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramCorrectionAudit_model_recordId_createdAt_idx" ON "TelegramCorrectionAudit"("model", "recordId", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramCorrectionAudit_chatId_createdAt_idx" ON "TelegramCorrectionAudit"("chatId", "createdAt");
