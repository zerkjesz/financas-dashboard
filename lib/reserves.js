import { prisma } from "./prisma.js";
import { money, subtractMoney, sumMoney, maxMoney, isPositive, ZERO } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — Reserve: alocação virtual de dinheiro dentro de uma Account real.
// Reserve NÃO tem campo de saldo mutável — o saldo é SEMPRE a soma assinada do
// ledger (ReserveMovement), igual ao padrão já usado em Account/Card (âncora +
// eventos). O sinal de cada movimento vem do `kind`, nunca de um campo "direction"
// solto nem de um amount que pode ser negativo — amount é SEMPRE positivo (CHECK no
// banco), e a tabela abaixo é a ÚNICA fonte de verdade sobre a direção de cada kind.
const POSITIVE_KINDS = new Set(["ALLOCATE", "REPLENISH", "ADJUST_INCREASE"]);
const NEGATIVE_KINDS = new Set(["RELEASE", "ADJUST_DECREASE"]);

function assertValidKind(kind) {
  if (!POSITIVE_KINDS.has(kind) && !NEGATIVE_KINDS.has(kind)) {
    throw new Error(`ReserveMovementKind inválido: ${JSON.stringify(kind)}`);
  }
}

function signedAmount(movement) {
  const abs = money(movement.amount);
  return POSITIVE_KINDS.has(movement.kind) ? abs : abs.negated();
}

// ============================================================================
// READ — nunca materializa/cria nada.
// ============================================================================

// Fase 5.2A prep — `client` opcional (default: `prisma`), mesmo padrão aditivo
// já usado em lib/accounts.js — permite validar com `{ client: tx }` dentro de
// uma transação futura. Nenhum call-site existente muda de comportamento.
export async function getReserveBalance(reserveId, { client = prisma } = {}) {
  const movements = await client.reserveMovement.findMany({ where: { reserveId } });
  return sumMoney(movements.map(signedAmount));
}

export async function listReserves({ accountId, activeOnly = true } = {}) {
  const reserves = await prisma.reserve.findMany({
    where: { ...(accountId ? { accountId } : {}), ...(activeOnly ? { isActive: true } : {}) },
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(
    reserves.map(async (r) => {
      const balance = await getReserveBalance(r.id);
      return { ...r, balance, replenishmentGap: computeReplenishmentGap(r.targetAmount, balance) };
    })
  );
}

// Soma dos saldos de todas as Reserve ativas — "dinheiro protegido" bruto. NÃO é
// freeMoney/safeToSpend (esses ainda não existem — fase futura); é só o insumo.
export async function getProtectedMoney({ accountId } = {}) {
  const reserves = await prisma.reserve.findMany({ where: { isActive: true, ...(accountId ? { accountId } : {}) } });
  const balances = await Promise.all(reserves.map((r) => getReserveBalance(r.id)));
  return sumMoney(balances);
}

// Derivado, NUNCA armazenado em campo próprio (Fase 3.3, item 6) — evita uma
// segunda fonte de verdade que pode divergir do ledger real.
export function computeReplenishmentGap(targetAmount, currentBalance) {
  if (targetAmount == null) return ZERO;
  return maxMoney(ZERO, subtractMoney(money(targetAmount), currentBalance));
}

// ============================================================================
// MUTATION
// ============================================================================

export async function createReserve({ accountId, name, targetAmount, isActive } = {}) {
  if (!accountId) throw new Error("accountId é obrigatório");
  if (!name) throw new Error("name é obrigatório");
  return prisma.reserve.create({
    data: {
      accountId,
      name,
      targetAmount: targetAmount != null ? money(targetAmount) : null,
      isActive: isActive ?? true,
    },
  });
}

export async function createReserveMovement(reserveId, { amount, kind, note, confidence, occurredAt } = {}) {
  assertValidKind(kind);
  const amountMoney = money(amount);
  if (!isPositive(amountMoney)) {
    throw new Error("amount do ReserveMovement precisa ser positivo — o sinal vem do kind, nunca do amount");
  }
  const reserve = await prisma.reserve.findUnique({ where: { id: reserveId } });
  if (!reserve) throw new Error("Reserve não encontrada");

  return prisma.reserveMovement.create({
    data: {
      reserveId,
      amount: amountMoney,
      kind,
      note: note || null,
      confidence: resolveConfidence(confidence),
      occurredAt: occurredAt || undefined,
    },
  });
}
