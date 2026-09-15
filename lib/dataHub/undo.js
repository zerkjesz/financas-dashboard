// ============================================================================
// Fase 6.0 (Design Freeze) — UNDO de uma importação aplicada, dentro da
// janela de 24h (a promessa real que a UI faz — "Dá para desfazer nas
// próximas 24 horas pela Atividade de dados", ver docs/data-hub.md). Só
// existe porque ImportBatch.preimages grava o estado ANTERIOR de cada linha
// tocada NO MOMENTO do apply (lib/dataHub/apply.js) — nunca um "desfazer"
// fake.
//
// undo de CREATE (`before: null`) = deletar o registro criado.
// undo de UPDATE (`before: {...}`) = restaurar os campos anteriores.
//
// Tudo dentro de UMA transação — undo parcial nunca fica "meio desfeito".
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

export async function undoImportBatch(prisma, batch) {
  if (!batch.undoDeadline || new Date() > new Date(batch.undoDeadline)) {
    throw new UndoWindowExpiredError();
  }

  return prisma.$transaction(async (tx) => {
    let restored = 0;
    let deleted = 0;
    // Ordem inversa — desfaz o mais recente primeiro (relevante quando um
    // preimage posterior dependeria de um anterior ainda existir).
    const preimages = [...(batch.preimages || [])].reverse();
    for (const p of preimages) {
      if (!tx[p.model]) continue;
      if (p.wasDeleted && p.before) {
        // Undo de um DELETE (modo Substituir) — recria com o MESMO id, pra
        // qualquer referência solta (rastreabilidade) continuar batendo.
        await tx[p.model].create({ data: reviveRow(p.before) }).catch((err) => {
          throw new Error(`Não foi possível recriar ${p.model}/${p.id}: ${err.message}`);
        });
        restored++;
      } else if (p.before === null) {
        await tx[p.model].delete({ where: { id: p.id } }).catch((err) => {
          // Item 46 — segurança referencial: se o registro já foi removido
          // por outro caminho, ou tem dependente real, o delete falha — não
          // interrompe o undo dos OUTROS registros do mesmo batch, mas o
          // erro é reportado (a transação inteira ainda pode ser abortada
          // se isso deixar o undo inconsistente — decisão: deixamos
          // propagar, undo é tudo-ou-nada como o próprio apply).
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
    return { restored, deleted };
  });
}
