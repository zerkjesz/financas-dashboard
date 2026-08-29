import { prisma } from "./prisma.js";
import { normalize, includesWord } from "./categoryRules.js";

const ACCOUNT_RULES = [
  { slug: "vale-alimentacao", words: ["vale alimentacao", "vale alimentação", "vale", "va", "vr"] },
  { slug: "dinheiro", words: ["dinheiro", "especie", "espécie"] },
  { slug: "itau", words: ["pix", "itau", "itaú"] },
];

const CARD_WORDS = ["cartao de credito", "cartão de crédito", "credito", "crédito", "cartao", "cartão"];

// Detecta qual conta/cartão a mensagem menciona. Cartão tem prioridade sobre conta
// (uma mensagem que cita "cartão" é sempre no cartão, mesmo que também cite "Itaú").
export async function resolvePaymentTarget(rawMessage) {
  const normalized = normalize(rawMessage);

  if (CARD_WORDS.some((w) => includesWord(normalized, w))) {
    const card = await prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
    if (card) return { type: "card", card };
  }

  for (const rule of ACCOUNT_RULES) {
    if (rule.words.some((w) => includesWord(normalized, w))) {
      const account = await prisma.account.findUnique({ where: { slug: rule.slug } });
      if (account) return { type: "account", account };
    }
  }

  // sem menção explícita: cai na conta principal (única conta corrente real hoje)
  const fallback = await prisma.account.findFirst({ where: { type: "checking" }, orderBy: { createdAt: "asc" } });
  return fallback ? { type: "account", account: fallback } : { type: "account", account: null };
}

export async function getDefaultCard() {
  return prisma.card.findFirst({ orderBy: { createdAt: "asc" } });
}

export async function getDefaultAccount() {
  return prisma.account.findFirst({ where: { type: "checking" }, orderBy: { createdAt: "asc" } });
}

// Retorna as contas mencionadas na mensagem, na ordem em que aparecem (usado por transferências).
export async function resolveMentionedAccounts(rawMessage) {
  const normalized = normalize(rawMessage);
  const found = [];
  for (const rule of ACCOUNT_RULES) {
    for (const word of rule.words) {
      if (includesWord(normalized, word)) {
        found.push({ slug: rule.slug, index: normalized.indexOf(normalize(word)) });
        break;
      }
    }
  }
  found.sort((a, b) => a.index - b.index);
  const accounts = [];
  for (const f of found) {
    const account = await prisma.account.findUnique({ where: { slug: f.slug } });
    if (account && !accounts.some((a) => a.id === account.id)) accounts.push(account);
  }
  return accounts;
}
