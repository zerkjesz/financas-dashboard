// ============================================================================
// Fase 7.0 — resolve entidades JÁ EXTRAÍDAS pelo LLM (nomes de conta/cartão,
// paymentMethod) contra os registros REAIS do banco. Diferente de
// lib/accountResolver.js (que faz keyword-matching em TEXTO CRU — o caminho
// do parser antigo): aqui a entrada já é uma entidade estruturada que o
// interpretador extraiu; a resolução é só "esse nome bate com qual Account/
// Card de verdade", nunca reinterpretação de linguagem natural.
// ============================================================================
import { normalize } from "../categoryRules.js";

const PAYMENT_METHOD_TO_ACCOUNT_SLUG = {
  pix: "itau",
  dinheiro: "dinheiro",
  vale: "vale-alimentacao",
};

// Resolve um nome livre (ex.: "Itaú", "itau", "conta corrente") contra as
// Account reais — match exato normalizado primeiro, depois substring.
export async function resolveAccountByName(name, { client }) {
  if (!name) return null;
  const target = normalize(name);
  const accounts = await client.account.findMany();
  const exact = accounts.find((a) => normalize(a.name) === target || normalize(a.slug) === target);
  if (exact) return exact;
  return accounts.find((a) => normalize(a.name).includes(target) || target.includes(normalize(a.name))) || null;
}

export async function resolveCardByName(name, { client }) {
  if (!name) return null;
  const target = normalize(name);
  const cards = await client.card.findMany();
  const exact = cards.find((c) => normalize(c.name) === target || normalize(c.slug) === target);
  if (exact) return exact;
  return cards.find((c) => normalize(c.name).includes(target) || target.includes(normalize(c.name))) || null;
}

export async function resolveAccountByPaymentMethod(paymentMethod, { client }) {
  const slug = PAYMENT_METHOD_TO_ACCOUNT_SLUG[paymentMethod];
  if (!slug) return null;
  return client.account.findUnique({ where: { slug } });
}

// Resolução central pra uma action de despesa/receita: tenta account/card
// explícitos por nome primeiro (mais específico), depois paymentMethod,
// nunca inventa um default silencioso aqui — quem decide "sem menção
// explícita = default" é o planValidator (que também marca
// accountOrCardExplicit=false nesse caso, pra a política de confirmação
// saber que não foi uma escolha inequívoca do usuário).
export async function resolvePaymentEntity(action, { client }) {
  if (action.card) {
    const card = await resolveCardByName(action.card, { client });
    if (card) return { kind: "card", card, explicit: true };
  }
  if (action.account) {
    const account = await resolveAccountByName(action.account, { client });
    if (account) return { kind: "account", account, explicit: true };
  }
  if (action.paymentMethod === "cartao_credito" || action.paymentMethod === "cartao_debito") {
    const card = await client.card.findFirst({ orderBy: { createdAt: "asc" } });
    if (card) return { kind: "card", card, explicit: true };
  }
  if (action.paymentMethod) {
    const account = await resolveAccountByPaymentMethod(action.paymentMethod, { client });
    if (account) return { kind: "account", account, explicit: true };
  }
  return { kind: null, explicit: false };
}
