// ============================================================================
// Fase 7.0.1, item 3 — serviço determinístico e AUDITADO pra correção/
// exclusão/desfazer de um registro JÁ APLICADO (Expense/Income/Transfer).
// Substitui o `client[model].update/delete` bruto que a Fase 7.0 usava
// direto no pipeline — aquilo não tinha pré-imagem, trilha de auditoria,
// guard de estado obsoleto nem undo real.
//
// Escopo DELIBERADAMENTE restrito a expense/income/transfer nesta subfase
// (item 3: "não ampliar pra outros models se não for seguro") — qualquer
// outro model continua fail-closed (ver pipeline.js:handleCorrectionOrUndo).
//
// Toda operação grava uma linha em TelegramCorrectionAudit (append-only,
// nunca sobrescrita — mesmo padrão de BalanceAdjustment/
// CardBillReconciliation) com o registro INTEIRO antes da mutação
// (`preimage`), permitindo desfazer de verdade (inclusive recriar um
// registro apagado, com o mesmo id).
// ============================================================================
import { prisma } from "../prisma.js";
import { formatMoney } from "../formatMoney.js";

export const SUPPORTED_CORRECTION_MODELS = Object.freeze(["expense", "income", "transfer"]);

const DATE_FIELDS = {
  expense: ["occurredAt", "createdAt", "updatedAt"],
  income: ["occurredAt", "createdAt", "updatedAt", "recurringOccurrenceDate"],
  transfer: ["occurredAt", "createdAt", "updatedAt"],
};

const EDITABLE_FIELDS = ["amount", "description", "category", "date"]; // "date" mapeia pra occurredAt.

export class StaleRecordError extends Error {
  constructor() {
    super("O registro mudou desde a última vez que eu verifiquei.");
    this.name = "StaleRecordError";
  }
}

export class RecordNotFoundError extends Error {
  constructor() {
    super("Registro não encontrado.");
    this.name = "RecordNotFoundError";
  }
}

// Decimal (Prisma) -> string; Date -> ISO string; o resto passa direto.
// Resultado é um objeto JSON-safe, seguro pra guardar em `preimage` (coluna
// Json) e pra reidratar depois via reviveDatesForCreate.
export function serializeRecord(record) {
  return JSON.parse(JSON.stringify(record, (_key, value) => (value && typeof value.toFixed === "function" ? value.toString() : value)));
}

function reviveDatesForCreate(model, preimage) {
  const fields = DATE_FIELDS[model] || [];
  const revived = { ...preimage };
  for (const field of fields) {
    if (field === "updatedAt") {
      delete revived[field]; // @updatedAt é sempre auto-gerenciado — nunca fornecido explicitamente.
      continue;
    }
    if (revived[field] != null) revived[field] = new Date(revived[field]);
  }
  return revived;
}

async function fetchRecord(model, id, { client = prisma } = {}) {
  if (!SUPPORTED_CORRECTION_MODELS.includes(model)) return null;
  return client[model].findUnique({ where: { id } });
}

export async function resolveAppliedRecordTarget(model, id, { client = prisma } = {}) {
  const record = await fetchRecord(model, id, { client });
  if (!record) return { ok: false, reason: `Não encontrei esse ${model} (pode já ter sido apagado ou alterado).` };
  return { ok: true, record, expectedUpdatedAt: record.updatedAt.toISOString() };
}

function buildUpdateData(model, fieldChanges) {
  const data = {};
  if (fieldChanges.amount != null) data.amount = fieldChanges.amount;
  if (fieldChanges.description != null) data.description = fieldChanges.description;
  if (fieldChanges.category != null) data.category = fieldChanges.category;
  if (fieldChanges.date != null) data.occurredAt = new Date(`${fieldChanges.date}T12:00:00.000Z`);
  return data;
}

// Descreve o diff campo-a-campo pra a mensagem de preview (item 3: mostrar
// "de X pra Y" antes de confirmar, nunca aplicar direto).
export function describeFieldChanges(record, fieldChanges) {
  const lines = [];
  if (fieldChanges.amount != null) lines.push(`valor: ${formatMoney(Number(record.amount))} -> ${formatMoney(Number(fieldChanges.amount))}`);
  if (fieldChanges.description != null) lines.push(`descrição: "${record.description}" -> "${fieldChanges.description}"`);
  if (fieldChanges.category != null) lines.push(`categoria: ${record.category} -> ${fieldChanges.category}`);
  if (fieldChanges.date != null) lines.push(`data: ${record.occurredAt.toISOString().slice(0, 10)} -> ${fieldChanges.date}`);
  return lines;
}

async function writeAudit(data, { client = prisma } = {}) {
  return client.telegramCorrectionAudit.create({ data });
}

// Aplica a correção JÁ CONFIRMADA pelo usuário. `expectedUpdatedAt` é o
// `updatedAt` capturado no momento do PREVIEW — se o registro mudou desde
// então (concorrência: outra correção, edição no dashboard, etc.), rejeita
// sem escrever nada (optimistic concurrency guard).
export async function applyGuardedCorrection({ model, id, fieldChanges, expectedUpdatedAt, chatId, telegramUpdateId, rawMessage }, { client = prisma } = {}) {
  if (!SUPPORTED_CORRECTION_MODELS.includes(model)) throw new Error(`Model não suportado pra correção guardada: ${model}`);
  const current = await client[model].findUnique({ where: { id } });
  if (!current) throw new RecordNotFoundError();
  if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) throw new StaleRecordError();

  const preimage = serializeRecord(current);
  const data = buildUpdateData(model, fieldChanges);
  const updated = await client[model].update({ where: { id }, data });

  const audit = await writeAudit(
    { model, recordId: id, action: "correct", preimage, fieldChanges, chatId: chatId ?? null, telegramUpdateId: telegramUpdateId ?? null, rawMessage: rawMessage ?? null },
    { client }
  );
  return { record: updated, auditId: audit.id };
}

export async function applyGuardedDelete({ model, id, expectedUpdatedAt, chatId, telegramUpdateId, rawMessage }, { client = prisma } = {}) {
  if (!SUPPORTED_CORRECTION_MODELS.includes(model)) throw new Error(`Model não suportado pra exclusão guardada: ${model}`);
  const current = await client[model].findUnique({ where: { id } });
  if (!current) throw new RecordNotFoundError();
  if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) throw new StaleRecordError();

  const preimage = serializeRecord(current);
  await client[model].delete({ where: { id } });

  const audit = await writeAudit({ model, recordId: id, action: "delete", preimage, fieldChanges: null, chatId: chatId ?? null, telegramUpdateId: telegramUpdateId ?? null, rawMessage: rawMessage ?? null }, { client });
  return { auditId: audit.id, preimage };
}

// Localiza a operação auditável mais recente (correct OU delete) sobre este
// registro que AINDA NÃO foi desfeita — usado tanto pra montar o preview de
// "desfazer" quanto, na confirmação, pra buscar de novo (nunca confia em ids
// vindos de fora sem validar contra o banco).
export async function findUndoableAudit({ model, recordId, chatId }, { client = prisma } = {}) {
  const rows = await client.telegramCorrectionAudit.findMany({
    where: { model, recordId, ...(chatId ? { chatId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  const undoneIds = new Set(rows.filter((r) => r.undoesAuditId).map((r) => r.undoesAuditId));
  return rows.find((r) => !r.action.startsWith("undo_") && !undoneIds.has(r.id)) || null;
}

// Desfaz uma operação auditada específica (por auditId, sempre revalidado
// contra o banco — nunca confia cegamente no id vindo de um pending antigo).
export async function undoAudit(auditId, { chatId, telegramUpdateId, rawMessage }, { client = prisma } = {}) {
  const audit = await client.telegramCorrectionAudit.findUnique({ where: { id: auditId } });
  if (!audit) throw new RecordNotFoundError();

  if (audit.action === "correct") {
    const current = await client[audit.model].findUnique({ where: { id: audit.recordId } });
    if (!current) throw new RecordNotFoundError();
    const preimage = audit.preimage;
    const revertData = {};
    const fc = audit.fieldChanges || {};
    if (fc.amount != null) revertData.amount = preimage.amount;
    if (fc.description != null) revertData.description = preimage.description;
    if (fc.category != null) revertData.category = preimage.category;
    if (fc.date != null) revertData.occurredAt = new Date(preimage.occurredAt);

    const preUndoImage = serializeRecord(current);
    const reverted = await client[audit.model].update({ where: { id: audit.recordId }, data: revertData });
    const newAudit = await writeAudit(
      { model: audit.model, recordId: audit.recordId, action: "undo_correct", preimage: preUndoImage, fieldChanges: revertData, chatId: chatId ?? null, telegramUpdateId: telegramUpdateId ?? null, rawMessage: rawMessage ?? null, undoesAuditId: audit.id },
      { client }
    );
    return { record: reverted, auditId: newAudit.id, kind: "undo_correct" };
  }

  if (audit.action === "delete") {
    const revivedData = reviveDatesForCreate(audit.model, audit.preimage);
    const recreated = await client[audit.model].create({ data: revivedData });
    const newAudit = await writeAudit(
      { model: audit.model, recordId: audit.recordId, action: "undo_delete", preimage: {}, fieldChanges: null, chatId: chatId ?? null, telegramUpdateId: telegramUpdateId ?? null, rawMessage: rawMessage ?? null, undoesAuditId: audit.id },
      { client }
    );
    return { record: recreated, auditId: newAudit.id, kind: "undo_delete" };
  }

  throw new Error(`Audit "${audit.id}" não é desfazível (action=${audit.action}).`);
}
