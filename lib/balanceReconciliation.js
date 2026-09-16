// ============================================================================
// Fase 7.0 — reconciliação de saldo observado vs calculado.
//
// Reaproveita 100% da infraestrutura existente: BalanceAdjustment já É o
// mecanismo de âncora de saldo (computeAccountBalance soma tudo a partir da
// última âncora). Este arquivo só adiciona a PARTE que faltava: computar o
// saldo atual ANTES de gravar a âncora, pra poder mostrar a diferença pro
// usuário e decidir (com o usuário) se vale reconciliar — nunca grava sem
// que o delta tenha sido mostrado e confirmado (a confirmação em si é
// responsabilidade do pipeline conversacional, não deste arquivo).
//
// confidence é SEMPRE "RECONCILIATION_ADJUSTMENT" aqui — nunca CONFIRMED
// (que sugeriria "eu tenho certeza absoluta", quando na verdade é o
// usuário resolvendo uma divergência) e nunca inventado pelo caller.
// ============================================================================
import { prisma } from "./prisma.js";
import { computeAccountBalance } from "./accounts.js";
import { money, subtractMoney, serializeMoney } from "./money.js";
import { formatMoney } from "./formatMoney.js";

// Read-only — nunca escreve. Usado pra montar a pergunta de confirmação
// ("Tenho R$X calculados. Você informou R$Y. Diferença: Z. Reconciliar?").
export async function previewBalanceReconciliation(accountId, observedBalance, { client = prisma } = {}) {
  const account = await client.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Conta ${accountId} não encontrada.`);
  const calculated = await computeAccountBalance(accountId, { client });
  const observed = money(observedBalance);
  const delta = subtractMoney(observed, calculated);
  return {
    account,
    calculated: serializeMoney(calculated),
    observed: serializeMoney(observed),
    delta: serializeMoney(delta),
    isDifferent: !delta.isZero(),
  };
}

// Grava a âncora de verdade — chamado só DEPOIS que o usuário confirmou (ou
// quando a diferença é zero, caso em que não há nada pra reconciliar e o
// caller nem deveria chamar isto).
export async function applyBalanceReconciliation(accountId, observedBalance, { note, rawMessage, client = prisma } = {}) {
  const account = await client.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`Conta ${accountId} não encontrada.`);
  const preview = await previewBalanceReconciliation(accountId, observedBalance, { client });
  const adjustment = await client.balanceAdjustment.create({
    data: {
      accountId,
      newBalance: money(observedBalance),
      note: note ?? `Reconciliação: calculado ${formatMoney(preview.calculated)}, informado ${formatMoney(preview.observed)} (diferença ${formatMoney(preview.delta)}).`,
      source: "telegram",
      confidence: "RECONCILIATION_ADJUSTMENT",
      rawMessage,
    },
  });
  return { record: adjustment, preview };
}
