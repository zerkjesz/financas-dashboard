// Fase 5.3C.2 — REDESENHADO a partir da versão da Fase 5.3C.1. Antes, o
// claim (INSERT do receipt) e a mutação financeira aconteciam em
// transações SEPARADAS — isso deixava uma janela real (documentada,
// declarada como ATOMIC_IDEMPOTENCY_BLOCKED, nunca escondida) entre "a
// mutação financeira já commitou" e "o receipt foi marcado COMPLETED": se
// o processo morresse exatamente ali, um retry legítimo (depois do lease
// de 60s expirar) reprocessaria e duplicaria o efeito financeiro.
//
// Agora: o claim, TODA mutação persistente causada pelo update
// (lib/telegramUpdateHandler.js -> botWizard/processTelegramMessage/
// commitBotIntent, tudo via `client: tx`), e o marcar-completo vivem na
// MESMA `prisma.$transaction`. Consequência direta: não existe mais nenhum
// estado intermediário "PROCESSING" observável de FORA da transação — ou
// ela COMMITA inteira (receipt COMPLETED + toda mutação persistem juntos),
// ou é revertida INTEIRA (nem o receipt nem a mutação persistem — um retry
// processa do zero, livre, sem duplicar nada). Por isso o LEASE de 60s da
// versão anterior foi REMOVIDO (item 10 do pedido) — deixou de ter função
// real: não há mais cenário em que um receipt fique "preso" em PROCESSING
// esperando expirar, porque PROCESSING nunca é commitado sozinho, fora do
// contexto de uma transação ainda aberta.
//
// Concorrência real (2 requests simultâneos pro MESMO update_id, nunca
// visto antes) é resolvida pelo lock de linha do Postgres na própria
// constraint UNIQUE(updateId) — nunca por lógica de aplicação:
//   - a segunda transação tentando o mesmo INSERT BLOQUEIA até a primeira
//     COMMITAR ou ABORTAR;
//   - primeira COMMITA -> ao desbloquear, a segunda recebe conflito de
//     unicidade (P2002) -> tratado como ALREADY_COMPLETED (só é possível
//     ver esse erro DEPOIS de esperar se a linha já foi commitada por
//     outro processo);
//   - primeira ABORTA (throw em qualquer ponto da transação) -> o INSERT
//     dela nunca commitou -> a segunda desbloqueia e consegue seu próprio
//     INSERT normalmente (claimed:true) -> processa normalmente.

// claimTelegramUpdateInTx(tx, updateId, { senderId, chatId, now }) ->
//   { claimed: true, receiptId } | { claimed: false, reason: "ALREADY_CLAIMED" }
//
// DEVE ser chamado com um `tx` de dentro de `prisma.$transaction(async tx =>
// ...)` — nunca com o prisma global (isso quebraria a garantia de
// atomicidade inteira; ver lib/telegramUpdateHandler.js).
//
// `reason: "ALREADY_CLAIMED"` (não "ALREADY_COMPLETED") de propósito: esta
// função não sabe (nem precisa saber) o status exato da row pré-existente —
// só que já existe uma. No fluxo real de produção (claim+complete sempre na
// MESMA transação, ver lib/telegramUpdateHandler.js) uma row committada
// sempre está COMPLETED por construção, mas esta função em si permanece
// honesta sobre o que de fato verificou.
export async function claimTelegramUpdateInTx(tx, updateId, { senderId = null, chatId = null, now = new Date() } = {}) {
  try {
    const created = await tx.telegramUpdateReceipt.create({
      data: { updateId: BigInt(updateId), senderId, chatId, status: "PROCESSING", claimedAt: now },
    });
    return { claimed: true, receiptId: created.id };
  } catch (err) {
    if (err.code === "P2002") return { claimed: false, reason: "ALREADY_CLAIMED" };
    throw err;
  }
}

export async function completeTelegramUpdateInTx(tx, receiptId, { now = new Date() } = {}) {
  await tx.telegramUpdateReceipt.update({ where: { id: receiptId }, data: { status: "COMPLETED", completedAt: now } });
}
