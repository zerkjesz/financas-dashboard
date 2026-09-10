// Extrai o valor monetário de uma mensagem livre, priorizando números perto de palavras
// de dinheiro (R$, reais, valor, total, custou) e ignorando números que são claramente
// quantidade ("2 caixas", "10x", "3 unidades"). Fix direto pro bug de "2 caixas por 512
// reais" virar R$2 — antes o parser pegava sempre o primeiro número da frase.

import { money } from "./money.js";

const NUMBER_RE = /(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d+\.\d{1,2}|\d+)/g;
const CURRENCY_WORDS = ["r$", "reais", "real", "valor", "total", "custou"];
const QUANTITY_WORD_RE = /^\s*(caixas?|unidades?|itens?|vezes|x)\b/i;
const DAY_REFERENCE_RE = /\bdia\s*$/i;
// Fase 5.6.2 — um dígito colado a uma letra é parte de um IDENTIFICADOR
// (token de verificação `…VERIFY-231B329D`, código de pedido `X200`, placa,
// modelo, UUID) — nunca um valor monetário. Um valor de verdade é um número
// isolado ("gastei 50", "R$ 1.200,00"). Só é reconsiderado se a mesma
// vizinhança carregar contexto de moeda ("50reais" sem espaço).
const LETTER_RE = /[a-zA-ZÀ-ÿ]/;

// Decimal-first na fronteira de entrada (Fase 3.1, Etapa 8): parseia a string com o
// MESMO parser (decimal.js, via money()) usado no resto do app, em vez de `parseFloat`
// nativo — um único parser canônico pra texto monetário. `amount`/`session.data.amount`
// continuam sendo `number` JS por toda a cadeia do bot (wizard, PendingBotMessage,
// formatMoney de exibição) — isso é armazenamento/exibição, não cálculo financeiro, e
// mudar essa forma pra string exigiria tocar toda a serialização de sessão do bot, fora
// do escopo desta fase (ver docs/phase3-money-audit.md, achado P1, nota de escopo).
// `commitBotIntent.js` já é o ponto que faz esse number voltar pra Decimal (`money()`)
// antes de qualquer conta — este parser só evita que a leitura inicial do texto passe
// por uma segunda implementação de parsing divergente.
function parseAmount(raw) {
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  try {
    const value = money(normalized).toNumber();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function contextWindow(text, index, matchLength, radius = 12) {
  return {
    before: text.slice(Math.max(0, index - radius), index).toLowerCase(),
    after: text.slice(index + matchLength, index + matchLength + radius),
  };
}

export function extractAmount(rawMessage) {
  const matches = [...rawMessage.matchAll(NUMBER_RE)];
  const candidates = matches
    .map((m) => {
      const { before, after } = contextWindow(rawMessage, m.index, m[0].length);
      const isDayReference = DAY_REFERENCE_RE.test(before);
      const hasCurrencyContext = CURRENCY_WORDS.some((w) => before.includes(w) || after.toLowerCase().includes(w));
      // Fase 5.6.2 — dígito imediatamente colado a uma letra (dos dois lados
      // ou de um lado, sem contexto de moeda) = identificador, não valor.
      const prevChar = m.index > 0 ? rawMessage[m.index - 1] : "";
      const nextChar = rawMessage[m.index + m[0].length] || "";
      const isIdentifierFragment = !hasCurrencyContext && (LETTER_RE.test(prevChar) || LETTER_RE.test(nextChar));
      return {
        raw: m[0],
        value: parseAmount(m[0]),
        index: m.index,
        hasCurrencyContext,
        hasQuantityContext: QUANTITY_WORD_RE.test(after) || isDayReference,
        isDayReference,
        isIdentifierFragment,
      };
    })
    .filter((c) => c.value !== null && c.value > 0 && !c.isIdentifierFragment);

  if (candidates.length === 0) return { amount: null, ambiguous: false, candidates: [] };

  const strong = candidates.filter((c) => c.hasCurrencyContext && !c.hasQuantityContext);
  if (strong.length === 1) return { amount: strong[0].value, ambiguous: false, candidates };
  if (strong.length > 1) return { amount: strong[0].value, ambiguous: true, candidates };

  const nonQuantity = candidates.filter((c) => !c.hasQuantityContext);
  if (nonQuantity.length === 1) return { amount: nonQuantity[0].value, ambiguous: false, candidates };
  if (nonQuantity.length > 1) return { amount: nonQuantity[0].value, ambiguous: true, candidates };

  // Sobrou só candidato de quantidade/dia — "dia N" nunca vira valor por adivinhação.
  const guessable = candidates.filter((c) => !c.isDayReference);
  if (guessable.length === 0) return { amount: null, ambiguous: false, candidates };

  const fallback = guessable.reduce((a, b) => (a.value > b.value ? a : b));
  return { amount: fallback.value, ambiguous: true, candidates };
}

export function extractInstallmentCount(rawMessage) {
  const match = rawMessage.match(/\b(\d{1,2})\s*x\b/i) || rawMessage.match(/\b(\d{1,2})\s*vezes\b/i) || rawMessage.match(/\b(\d{1,2})\s*parcelas\b/i);
  return match ? parseInt(match[1], 10) : null;
}
