import { prisma } from "./prisma.js";

// Fase 5.3C.1 — idempotência DURÁVEL por Telegram update_id (nunca em
// memória — Set/Map de processo não sobrevive a cold start/restart de
// function serverless). A garantia de concorrência real vem da constraint
// UNIQUE(updateId) no banco (ver migration 20260908175034), nunca de um
// "SELECT depois INSERT" isolado (que teria race condition — dois workers
// podem passar pelo SELECT antes de qualquer um fazer o INSERT).
//
// Escopo HONESTO desta solução (documentado, não escondido — ver relatório
// da fase): isto é "at-least-once com janela de corrida estreita", NÃO
// "exactly-once atômico". O claim (linha PROCESSING) e a mutação financeira
// (dentro de processTelegramMessage/commitBotIntent) NÃO estão na MESMA
// transação Prisma — fechar isso 100% exigiria threading `client`/`tx` por
// ~15 handlers em lib/commitBotIntent.js + helpers em lib/cardBillCalculator.js/
// lib/bills.js/lib/goals.js/lib/installments.js, redesign fora do escopo
// desta fase (ver ATOMIC_IDEMPOTENCY_BLOCKED no relatório). O que ESTÁ
// garantido:
//   - dois requests concorrentes pro MESMO update_id nunca-antes-visto:
//     só um vence o INSERT (constraint UNIQUE), o outro recebe RACE_LOST e
//     nunca chama a mutação financeira. Isso é uma garantia REAL de banco,
//     não uma heurística.
//   - um update já COMPLETED nunca é reprocessado.
//   - um update PROCESSING recente (dentro do lease) é tratado como
//     "em andamento em outro lugar" — nunca reprocessado.
// O que NÃO está garantido (janela residual, documentada): se o processo
// que reivindicou o update morrer DEPOIS de commitar a mutação financeira
// mas ANTES de chamar completeTelegramUpdate, o receipt fica PROCESSING
// "para sempre" até o lease expirar — daí em diante um retry LEGÍTIMO
// reivindica de novo e reprocessa, o que duplicaria a mutação financeira
// nesse cenário específico e raro (crash exatamente nessa janela de
// milissegundos). LEASE_MS abaixo é deliberadamente generoso (bem maior que
// qualquer processamento normal) pra minimizar reclaims prematuros.
const LEASE_MS = 60_000;

const STATUS = Object.freeze({ PROCESSING: "PROCESSING", COMPLETED: "COMPLETED", FAILED: "FAILED" });

// claimTelegramUpdate(updateId, { senderId, chatId }) ->
//   { claimed: true, receiptId } | { claimed: false, reason: "ALREADY_COMPLETED" | "IN_PROGRESS" | "RACE_LOST" }
export async function claimTelegramUpdate(updateId, { senderId = null, chatId = null, now = new Date(), leaseMs = LEASE_MS } = {}) {
  const updateIdBig = BigInt(updateId);

  const existing = await prisma.telegramUpdateReceipt.findUnique({ where: { updateId: updateIdBig } });

  if (!existing) {
    // Nunca visto antes — tenta criar. A constraint UNIQUE decide quem
    // ganha em caso de corrida real (dois requests concorrentes chegando
    // aqui ao mesmo tempo pro mesmo update_id).
    try {
      const created = await prisma.telegramUpdateReceipt.create({
        data: { updateId: updateIdBig, senderId, chatId, status: STATUS.PROCESSING, claimedAt: now },
      });
      return { claimed: true, receiptId: created.id };
    } catch (err) {
      if (err.code === "P2002") return { claimed: false, reason: "RACE_LOST" };
      throw err;
    }
  }

  if (existing.status === STATUS.COMPLETED) {
    return { claimed: false, reason: "ALREADY_COMPLETED" };
  }

  if (existing.status === STATUS.PROCESSING) {
    const ageMs = now.getTime() - existing.claimedAt.getTime();
    if (ageMs < leaseMs) {
      return { claimed: false, reason: "IN_PROGRESS" };
    }
    // Lease expirado — reclaim via compare-and-swap (updateMany com o
    // claimedAt ORIGINAL na condição where): se outro worker já reclamou
    // entre o findUnique acima e este updateMany, count será 0.
    const reclaim = await prisma.telegramUpdateReceipt.updateMany({
      where: { id: existing.id, status: STATUS.PROCESSING, claimedAt: existing.claimedAt },
      data: { claimedAt: now, senderId, chatId },
    });
    if (reclaim.count === 0) return { claimed: false, reason: "RACE_LOST" };
    return { claimed: true, receiptId: existing.id };
  }

  // status === FAILED — sempre pode tentar de novo (mesmo compare-and-swap
  // pattern, condicionado em status=FAILED em vez de claimedAt).
  const reclaim = await prisma.telegramUpdateReceipt.updateMany({
    where: { id: existing.id, status: STATUS.FAILED },
    data: { status: STATUS.PROCESSING, claimedAt: now, senderId, chatId },
  });
  if (reclaim.count === 0) return { claimed: false, reason: "RACE_LOST" };
  return { claimed: true, receiptId: existing.id };
}

export async function completeTelegramUpdate(receiptId, { now = new Date() } = {}) {
  await prisma.telegramUpdateReceipt.update({ where: { id: receiptId }, data: { status: STATUS.COMPLETED, completedAt: now } });
}

export async function failTelegramUpdate(receiptId) {
  await prisma.telegramUpdateReceipt.update({ where: { id: receiptId }, data: { status: STATUS.FAILED } });
}
