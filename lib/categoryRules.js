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
  { value: "cash", label: "Dinheiro" },
];

const CATEGORY_RULES = [
  { category: "Alimentação", words: ["mercado", "supermercado", "restaurante", "ifood", "lanche", "comida", "padaria", "almoço", "almoco", "janta"] },
  // "99" (o app) fica de fora de propósito: como substring bate em qualquer preço terminado
  // em ",99" (o final de preço mais comum no Brasil) — "uber" já cobre a categoria sozinho.
  { category: "Transporte", words: ["uber", "gasolina", "combustivel", "combustível", "onibus", "ônibus", "metro", "metrô", "estacionamento"] },
  { category: "Moradia", words: ["aluguel", "condominio", "condomínio", "luz", "agua", "água", "internet", "energia"] },
  { category: "Saúde", words: ["farmacia", "farmácia", "remedio", "remédio", "medico", "médico", "plano de saude", "plano de saúde", "gympass", "academia"] },
  { category: "Lazer", words: ["cinema", "bar", "show", "viagem", "streaming", "netflix", "spotify"] },
  { category: "Trabalho", words: ["freela", "freelance", "salario", "salário", "cliente", "projeto", "chatgpt", "claude", "openai", "anthropic"] },
];

export function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Match por palavra inteira, não substring — evita bugs tipo "69,99" batendo em "99" ou
// "estava"/"gastava" batendo em "va" (vale-alimentação). `word` pode ter espaço (frase).
export function includesWord(normalizedText, word) {
  const escaped = normalize(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\d])${escaped}(?![\\p{L}\\d])`, "u").test(normalizedText);
}

export function detectCategory(normalizedText) {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => includesWord(normalizedText, w))) {
      return rule.category;
    }
  }
  return "Outros";
}
