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
  { category: "Transporte", words: ["uber", "gasolina", "combustivel", "combustível", "99", "onibus", "ônibus", "metro", "metrô", "estacionamento"] },
  { category: "Moradia", words: ["aluguel", "condominio", "condomínio", "luz", "agua", "água", "internet", "energia"] },
  { category: "Saúde", words: ["farmacia", "farmácia", "remedio", "remédio", "medico", "médico", "plano de saude", "plano de saúde"] },
  { category: "Lazer", words: ["cinema", "bar", "show", "viagem", "streaming", "netflix", "spotify"] },
  { category: "Trabalho", words: ["freela", "freelance", "salario", "salário", "cliente", "projeto"] },
];

export function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function detectCategory(normalizedText) {
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some((w) => normalizedText.includes(normalize(w)))) {
      return rule.category;
    }
  }
  return "Outros";
}
