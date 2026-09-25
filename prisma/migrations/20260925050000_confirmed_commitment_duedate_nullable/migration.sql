-- Fase 8.0.1 — ConfirmedCommitment.dueDate passa a aceitar NULL ("sem prazo definido").
-- Estritamente aditiva/relaxante: DROP NOT NULL não reescreve nem apaga nenhuma linha
-- e não valida dados existentes; compromissos atuais mantêm exatamente a mesma dueDate.
-- Lock: ACCESS EXCLUSIVE instantâneo (só metadado do catálogo).
ALTER TABLE "ConfirmedCommitment" ALTER COLUMN "dueDate" DROP NOT NULL;
