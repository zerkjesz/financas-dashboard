import { IMPORT_TRANSACTION_OPTIONS } from "./apply.js";

// ============================================================================
// Fase 6.0 (Design Freeze) / 6.0.1 (Integrity Closure) — UNDO de uma
// importação aplicada, dentro da janela de 24h (a promessa real que a UI faz
// — "Dá para desfazer nas próximas 24 horas pela Atividade de dados", ver
// docs/data-hub.md). Só existe porque ImportBatch.preimages grava o estado
// ANTERIOR de cada linha tocada NO MOMENTO do apply (lib/dataHub/apply.js) —
// nunca um "desfazer" fake.
//
// undo de CREATE (`before: null`) = deletar o registro criado.
// undo de UPDATE (`before: {...}`) = restaurar os campos anteriores.
// undo de DELETE (`wasDeleted: true`, modo Substituir) = recriar com o
// MESMO id.
//
// GUARD DE CONCORRÊNCIA (item 12 da closure 6.0.1) — se o registro foi
// modificado DEPOIS do apply (por qualquer caminho: dashboard, bot, outra
// importação), `afterUpdatedAt` (capturado em apply.js/replace.js logo após
// escrever) não bate mais com o `updatedAt` atual do registro. Nesse caso o
// undo NUNCA sobrescreve silenciosamente — a linha inteira do batch é
// abortada (undo continua tudo-ou-nada, igual ao apply).
//
// Tudo dentro de UMA transação — undo parcial nunca fica "meio desfeito", e
// o ImportBatch.status=UNDONE + o DataOperation IMPORT_UNDO fazem parte da
// MESMA transação que as restaurações (mesma exigência de atomicidade do
// apply — ver lib/dataHub/apply.js).
// ============================================================================

const IMMUTABLE_FIELDS = new Set(["id", "createdAt", "updatedAt"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// preimages são JSON puro (Decimal->number, Date->ISOString na captura,
// ver apply.js/replace.js serializePreimage*) — revive strings ISO de volta
// pra Date antes de escrever, senão o Prisma Client recusa o valor pro
// campo DateTime.
function reviveRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && ISO_DATE_RE.test(v) ? new Date(v) : v;
  }
  return out;
}

export class UndoWindowExpiredError extends Error {
  constructor() {
    super("A janela de 24 horas pra desfazer esta importação já passou.");
    this.name = "UndoWindowExpiredError";
  }
}

export class UndoStaleStateError extends Error {
  constructor(details) {
    super("Um ou mais registros mudaram desde a importação — não é possível desfazer automaticamente. Revise manualmente.");
    this.name = "UndoStaleStateError";
    this.code = "UNDO_STALE_STATE";
    this.details = details;
  }
}

export async function undoImportBatch(prisma, batch) {
  if (!batch.undoDeadline || new Date() > new Date(batch.undoDeadline)) {
    throw new UndoWindowExpiredError();
  }

  return prisma.$transaction(async (tx) => {
    // Passo 1 — valida TODOS os registros afetados ANTES de desfazer
    // qualquer um (tudo-ou-nada): se qualquer linha mudou desde o apply
    // (afterUpdatedAt != updatedAt atual), aborta o undo inteiro.
    const stale = [];
    for (const p of batch.preimages || []) {
      if (!tx[p.model]) continue;
      if (p.wasDeleted) continue; // recriação de delete — nada a comparar (ver undoImportBatch doc).
      if (!p.afterUpdatedAt) continue; // preimage antigo (pré-6.0.1), sem guard — não bloqueia.
      const current = await tx[p.model].findUnique({ where: { id: p.id }, select: { updatedAt: true } });
      if (!current) {
        stale.push({ model: p.model, id: p.id, reason: "registro não existe mais" });
        continue;
      }
      if (current.updatedAt.toISOString() !== p.afterUpdatedAt) {
        stale.push({ model: p.model, id: p.id, reason: "registro foi modificado depois da importação" });
      }
    }
    if (stale.length > 0) throw new UndoStaleStateError(stale);

    // Passo 2 — desfaz de verdade. Ordem inversa (mais recente primeiro),
    // relevante quando um preimage posterior dependeria de um anterior
    // ainda existir.
    let restored = 0;
    let deleted = 0;
    const preimages = [...(batch.preimages || [])].reverse();
    for (const p of preimages) {
      if (!tx[p.model]) continue;
      if (p.wasDeleted && p.before) {
        await tx[p.model].create({ data: reviveRow(p.before) }).catch((err) => {
          throw new Error(`Não foi possível recriar ${p.model}/${p.id}: ${err.message}`);
        });
        restored++;
      } else if (p.before === null) {
        await tx[p.model].delete({ where: { id: p.id } }).catch((err) => {
          // Item 46 — segurança referencial: se o registro já foi removido
          // por outro caminho, ou tem dependente real, o delete falha —
          // propaga (undo é tudo-ou-nada, igual ao próprio apply).
          throw new Error(`Não foi possível desfazer ${p.model}/${p.id}: ${err.message}`);
        });
        deleted++;
      } else {
        const revived = reviveRow(p.before);
        const data = {};
        for (const [k, v] of Object.entries(revived)) {
          if (IMMUTABLE_FIELDS.has(k)) continue;
          data[k] = v;
        }
        await tx[p.model].update({ where: { id: p.id }, data });
        restored++;
      }
    }

    // Passo 3 — status + auditoria NA MESMA transação (item 2/26 da
    // closure 6.0.1: undo segue a mesma exigência de atomicidade do apply).
    await tx.importBatch.update({ where: { id: batch.id }, data: { status: "UNDONE", undoneAt: new Date() } });
    await tx.dataOperation.create({
      data: {
        type: "IMPORT_UNDO",
        status: "SUCCESS",
        mode: batch.mode,
        datasets: batch.datasets,
        fileName: batch.fileName,
        fileHash: batch.fileHash,
        createdCount: restored,
        deletedCount: deleted,
        importBatchId: batch.id,
      },
    });

    return { restored, deleted };
  }, IMPORT_TRANSACTION_OPTIONS);
}
