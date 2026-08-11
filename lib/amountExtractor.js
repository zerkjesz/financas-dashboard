// Extrai o valor monetário de uma mensagem livre, priorizando números perto de palavras
// de dinheiro (R$, reais, valor, total, custou) e ignorando números que são claramente
// quantidade ("2 caixas", "10x", "3 unidades"). Fix direto pro bug de "2 caixas por 512
// reais" virar R$2 — antes o parser pegava sempre o primeiro número da frase.

const NUMBER_RE = /(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d+\.\d{1,2}|\d+)/g;
const CURRENCY_WORDS = ["r$", "reais", "real", "valor", "total", "custou"];
const QUANTITY_WORD_RE = /^\s*(caixas?|unidades?|itens?|vezes|x)\b/i;

function parseAmount(raw) {
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
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
      return {
        raw: m[0],
        value: parseAmount(m[0]),
        index: m.index,
        hasCurrencyContext: CURRENCY_WORDS.some((w) => before.includes(w) || after.toLowerCase().includes(w)),
        hasQuantityContext: QUANTITY_WORD_RE.test(after),
      };
    })
    .filter((c) => c.value !== null && c.value > 0);

  if (candidates.length === 0) return { amount: null, ambiguous: false, candidates: [] };

  const strong = candidates.filter((c) => c.hasCurrencyContext && !c.hasQuantityContext);
  if (strong.length === 1) return { amount: strong[0].value, ambiguous: false, candidates };
  if (strong.length > 1) return { amount: strong[0].value, ambiguous: true, candidates };

  const nonQuantity = candidates.filter((c) => !c.hasQuantityContext);
  if (nonQuantity.length === 1) return { amount: nonQuantity[0].value, ambiguous: false, candidates };
  if (nonQuantity.length > 1) return { amount: nonQuantity[0].value, ambiguous: true, candidates };

  const fallback = candidates.reduce((a, b) => (a.value > b.value ? a : b));
  return { amount: fallback.value, ambiguous: true, candidates };
}

export function extractInstallmentCount(rawMessage) {
  const match = rawMessage.match(/\b(\d{1,2})\s*x\b/i) || rawMessage.match(/\b(\d{1,2})\s*vezes\b/i) || rawMessage.match(/\b(\d{1,2})\s*parcelas\b/i);
  return match ? parseInt(match[1], 10) : null;
}
