// ============================================================================
// Fase 7.0 — validação/resolução determinística de um FinancialIntentPlan JÁ
// validado por schema (Zod). Aqui é onde o domínio real do Norte entra: nomes
// de conta/cartão viram IDs reais, candidatos de duplicata são buscados,
// e cada action recebe um veredito {ok:true, resolved:{...}} ou
// {ok:false, reason}. NENHUMA escrita acontece aqui — isto é 100% leitura.
//
// O executor (planExecutor.js) e a política de confirmação
// (confirmationPolicy.js) consomem o resultado desta função; nenhum dos
// dois reimplementa resolução de entidade.
// ============================================================================
import { resolvePaymentEntity, resolveAccountByName, resolveCardByName } from "./entityResolver.js";
import { findDuplicateCandidates } from "./dedupe.js";

const LEDGER_TYPES_NEEDING_PAYMENT_ENTITY = new Set(["RECORD_EXPENSE", "RECORD_INCOME", "RECORD_CARD_PURCHASE", "RECORD_INSTALLMENT_PURCHASE"]);

async function resolveLedgerAction(action, { client }) {
  const entity = await resolvePaymentEntity(action, { client });
  if (!entity.kind) {
    return { ok: false, reason: `Não consegui identificar a conta ou cartão de "${action.description || action.merchant || action.type}".` };
  }
  const duplicates = await findDuplicateCandidates(action, {
    client,
    resolvedAccountId: entity.kind === "account" ? entity.account.id : null,
    resolvedCardId: entity.kind === "card" ? entity.card.id : null,
  });
  return { ok: true, resolved: { entity, accountOrCardExplicit: entity.explicit }, duplicates };
}

async function resolveTransfer(action, { client }) {
  const from = action.fromAccount ? await resolveAccountByName(action.fromAccount, { client }) : null;
  const to = action.toAccount ? await resolveAccountByName(action.toAccount, { client }) : null;
  const toCard = action.toCard ? await resolveCardByName(action.toCard, { client }) : null;
  if (!from && !to && !toCard) {
    return { ok: false, reason: "Não consegui identificar origem/destino da transferência." };
  }
  const bothSidesResolved = Boolean(from) && Boolean(to || toCard);
  return { ok: true, resolved: { from, to, toCard, transferBothSidesResolved: bothSidesResolved }, duplicates: [] };
}

async function resolveCardBySnapshotField(cardName, { client }) {
  const card = cardName ? await resolveCardByName(cardName, { client }) : await client.card.findFirst({ orderBy: { createdAt: "asc" } });
  if (!card) return { ok: false, reason: `Não encontrei o cartão "${cardName}".` };
  return { ok: true, resolved: { card }, duplicates: [] };
}

async function resolveAccountBySnapshotField(accountName, { client }) {
  const account = accountName ? await resolveAccountByName(accountName, { client }) : await client.account.findFirst({ where: { type: "checking" } });
  if (!account) return { ok: false, reason: `Não encontrei a conta "${accountName}".` };
  return { ok: true, resolved: { account }, duplicates: [] };
}

async function resolveVaAccount({ client }) {
  const account = await client.account.findUnique({ where: { slug: "vale-alimentacao" } });
  if (!account) return { ok: false, reason: "Conta de Vale Alimentação não encontrada." };
  return { ok: true, resolved: { account }, duplicates: [] };
}

async function resolveCommitmentTarget(targetDescription, { client }) {
  const candidates = await client.confirmedCommitment.findMany({
    where: { description: { contains: targetDescription, mode: "insensitive" }, status: { in: ["CONFIRMED", "FUNDED"] } },
  });
  if (candidates.length === 0) return { ok: false, reason: `Não encontrei um compromisso confirmado parecido com "${targetDescription}".` };
  if (candidates.length > 1) return { ok: false, reason: `Encontrei ${candidates.length} compromissos parecidos com "${targetDescription}" — qual deles?` };
  return { ok: true, resolved: { commitment: candidates[0] }, duplicates: [] };
}

async function resolveContingencyTarget(targetDescription, { client }) {
  const candidates = await client.contingency.findMany({
    where: { description: { contains: targetDescription, mode: "insensitive" }, status: { not: "DISMISSED" } },
  });
  if (candidates.length === 0) return { ok: false, reason: `Não encontrei uma contingência parecida com "${targetDescription}".` };
  if (candidates.length > 1) return { ok: false, reason: `Encontrei ${candidates.length} contingências parecidas com "${targetDescription}" — qual delas?` };
  return { ok: true, resolved: { contingency: candidates[0] }, duplicates: [] };
}

// Resolve uma action pra {ok, resolved?, reason?, duplicates}. Ações
// read-only/sentinela não precisam de resolução de entidade (o pipeline as
// trata à parte) — devolvem ok:true com resolved vazio.
export async function resolveAction(action, { client }) {
  switch (action.type) {
    case "RECORD_EXPENSE":
    case "RECORD_INCOME":
    case "RECORD_CARD_PURCHASE":
    case "RECORD_INSTALLMENT_PURCHASE":
      return resolveLedgerAction(action, { client });
    case "RECORD_TRANSFER":
      return resolveTransfer(action, { client });
    case "RECORD_CARD_PAYMENT":
      return resolveCardBySnapshotField(action.card, { client });
    case "SET_ACCOUNT_BALANCE_SNAPSHOT":
      return resolveAccountBySnapshotField(action.account, { client });
    case "SET_VA_BALANCE_SNAPSHOT":
      return resolveVaAccount({ client });
    case "SET_CARD_BILL_SNAPSHOT":
      return resolveCardBySnapshotField(action.card, { client });
    case "CREATE_CONFIRMED_COMMITMENT":
    case "CREATE_CONTINGENCY":
    case "CREATE_RECEIVABLE":
      return { ok: true, resolved: {}, duplicates: [] };
    case "UPDATE_CONFIRMED_COMMITMENT":
    case "SETTLE_CONFIRMED_COMMITMENT":
      return resolveCommitmentTarget(action.targetDescription, { client });
    case "UPDATE_CONTINGENCY":
      return resolveContingencyTarget(action.targetDescription, { client });
    case "QUERY_FINANCIAL_STATE":
    case "SIMULATE_PURCHASE":
    case "CLARIFICATION_REQUIRED":
    case "NO_FINANCIAL_INTENT":
      return { ok: true, resolved: {}, duplicates: [] };
    case "CORRECT_PREVIOUS_ACTION":
    case "DELETE_OR_UNDO_PREVIOUS_ACTION":
      // Resolvido pelo conversationContext (aponta pro pending/applied
      // record) — nada a resolver aqui além do que já veio no plano.
      return { ok: true, resolved: {}, duplicates: [] };
    default:
      return { ok: false, reason: `Tipo de action desconhecido: ${action.type}` };
  }
}

// Resolve TODAS as actions do plano. Se QUALQUER uma falhar a resolução, o
// plano inteiro fica bloqueado (item 4: atomicidade — nunca aplica metade).
export async function validatePlan(plan, { client }) {
  const perAction = [];
  for (const action of plan.actions) {
    const result = await resolveAction(action, { client });
    perAction.push({ action, ...result });
  }
  const blocking = perAction.filter((r) => !r.ok);
  return { perAction, ok: blocking.length === 0, blocking };
}
