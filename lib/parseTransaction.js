export const CATEGORIES = [
  "Alimentação",
  "Transporte",
  "Moradia",
  "Saúde",
  "Lazer",
  "Trabalho",
  "Parcelas Cartão de Crédito",
  "Outros",
];

const INSTALLMENT_PREFIX = "parcela";
const INSTALLMENT_CATEGORY = "Parcelas Cartão de Crédito";

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

// contador de parcela tipo "3/10": não é valor, então some da busca do valor
// pra "parcela 3/10 150 celular" não confundir o 3 com o valor da compra.
const INSTALLMENT_COUNTER_REGEX = /\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/i;

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// match por borda de palavra: "includes" solto deixava "99" (99Pop) bater
// dentro de "199,90" e "vr" (vale-refeição) bater dentro de "livre".
function includesWord(normalizedText, normalizedWord) {
  const escaped = normalizedWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(normalizedText);
}

function parseAmount(raw) {
  const normalized = raw.replace(/\./g, "").replace(",", ".");
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function detectType(normalizedText) {
  return INCOME_KEYWORDS.some((kw) => includesWord(normalizedText, normalize(kw)))
    ? "income"
    : "expense";
}

function detectCategory(normalizedText) {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => includesWord(normalizedText, normalize(w)))) {
      return rule.category;
    }
  }
  return "Outros";
}

function detectPaymentMethod(normalizedText) {
  for (const rule of PAYMENT_METHOD_RULES) {
    if (rule.words.some((w) => includesWord(normalizedText, normalize(w)))) {
      return rule.method;
    }
  }
  return null;
}

function detectRecurring(normalizedText) {
  return RECURRING_KEYWORDS.some((kw) => includesWord(normalizedText, normalize(kw)));
}

function isInstallmentMessage(normalizedText) {
  return normalizedText.startsWith(INSTALLMENT_PREFIX);
}

function extractInstallmentCounter(rawMessage) {
  const match = rawMessage.match(INSTALLMENT_COUNTER_REGEX);
  if (!match) return null;

  const current = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= 0) {
    return null;
  }

  return { current, total, matchText: match[0] };
}

/**
 * Interpreta uma mensagem de texto livre tipo "50 mercado pix" ou "recebi 200 freela".
 * Retorna null se não conseguir achar um valor numérico na mensagem.
 */
export function parseTransaction(rawMessage) {
  const normalizedText = normalize(rawMessage);
  const isInstallment = isInstallmentMessage(normalizedText);

  const installmentCounter = isInstallment ? extractInstallmentCounter(rawMessage) : null;
  const textForAmount = installmentCounter
    ? rawMessage.replace(installmentCounter.matchText, " ")
    : rawMessage;

  const match = textForAmount.match(AMOUNT_REGEX);
  if (!match) return null;

  const amount = parseAmount(match[1]);
  if (amount === null || amount <= 0) return null;

  return {
    type: detectType(normalizedText),
    amount,
    category: isInstallment ? INSTALLMENT_CATEGORY : detectCategory(normalizedText),
    paymentMethod: detectPaymentMethod(normalizedText) || (isInstallment ? "credit_card" : null),
    isRecurring: detectRecurring(normalizedText),
    installmentCurrent: installmentCounter ? installmentCounter.current : null,
    installmentTotal: installmentCounter ? installmentCounter.total : null,
    description: rawMessage.trim(),
    rawMessage: rawMessage.trim(),
  };
}
