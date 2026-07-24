export const CATEGORIES = [
  "Alimentação",
  "Transporte",
  "Moradia",
  "Saúde",
  "Lazer",
  "Trabalho",
  "Outros",
];

export const PAYMENT_METHODS = [
  { value: "pix", label: "Pix" },
  { value: "credit_card", label: "Cartão de Crédito" },
  { value: "food_voucher", label: "Vale Alimentação" },
];

const INCOME_KEYWORDS = [
  "recebi", "receb", "ganhei", "ganho", "entrou", "salario", "salário",
  "venda", "vendi", "freela", "freelance", "pix recebido", "deposito",
  "depósito", "caiu", "pagamento recebido", "renda",
];

const RECURRING_KEYWORDS = [
  "fixo", "fixa", "recorrente", "assinatura", "mensal", "mensalidade",
];

const CATEGORY_RULES = [
  { category: "Alimentação", words: ["mercado", "supermercado", "restaurante", "ifood", "lanche", "comida", "padaria", "almoço", "almoco", "janta"] },
  { category: "Transporte", words: ["uber", "gasolina", "combustivel", "combustível", "99", "onibus", "ônibus", "metro", "metrô", "estacionamento"] },
  { category: "Moradia", words: ["aluguel", "condominio", "condomínio", "luz", "agua", "água", "internet", "energia"] },
  { category: "Saúde", words: ["farmacia", "farmácia", "remedio", "remédio", "medico", "médico", "plano de saude", "plano de saúde"] },
  { category: "Lazer", words: ["cinema", "bar", "show", "viagem", "streaming", "netflix", "spotify"] },
  { category: "Trabalho", words: ["freela", "freelance", "salario", "salário", "cliente", "projeto"] },
];

const PAYMENT_METHOD_RULES = [
  { method: "pix", words: ["pix"] },
  { method: "credit_card", words: ["cartao de credito", "cartão de crédito", "credito", "crédito", "cartao", "cartão"] },
  { method: "food_voucher", words: ["vale alimentacao", "vale alimentação", "vale", "va", "vr"] },
];

// aceita "50", "1200", "50,00", "1.200,50", "1.200", "R$ 50", "50 reais"
// ordem importa: tenta primeiro os formatos com separador de milhar/decimal
// antes do inteiro puro, senão "1200" seria cortado em "120" pelo grupo de milhar.
const AMOUNT_REGEX = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})|\d+(?:\.\d{1,2})|\d+)/i;

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function parseAmount(raw) {
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function detectType(normalizedText) {
  return INCOME_KEYWORDS.some((kw) => normalizedText.includes(normalize(kw)))
    ? "income"
    : "expense";
}

function detectCategory(normalizedText) {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => normalizedText.includes(normalize(w)))) {
      return rule.category;
    }
  }
  return "Outros";
}

function detectPaymentMethod(normalizedText) {
  for (const rule of PAYMENT_METHOD_RULES) {
    if (rule.words.some((w) => normalizedText.includes(normalize(w)))) {
      return rule.method;
    }
  }
  return null;
}

function detectRecurring(normalizedText) {
  return RECURRING_KEYWORDS.some((kw) => normalizedText.includes(normalize(kw)));
}

/**
 * Interpreta uma mensagem de texto livre tipo "50 mercado pix" ou "recebi 200 freela".
 * Retorna null se não conseguir achar um valor numérico na mensagem.
 */
export function parseTransaction(rawMessage) {
  const match = rawMessage.match(AMOUNT_REGEX);
  if (!match) return null;

  const amount = parseAmount(match[1]);
  if (amount === null || amount <= 0) return null;

  const normalizedText = normalize(rawMessage);

  return {
    type: detectType(normalizedText),
    amount,
    category: detectCategory(normalizedText),
    paymentMethod: detectPaymentMethod(normalizedText),
    isRecurring: detectRecurring(normalizedText),
    description: rawMessage.trim(),
    rawMessage: rawMessage.trim(),
  };
}
