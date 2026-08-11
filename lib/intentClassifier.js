import { normalize } from "./categoryRules.js";
import { extractInstallmentCount } from "./amountExtractor.js";

const INCOME_KEYWORDS = [
  "recebi", "receb", "ganhei", "ganho", "entrou", "salario", "salário",
  "venda", "vendi", "freela", "freelance", "pix recebido", "deposito",
  "depósito", "caiu", "pagamento recebido", "renda",
];

const RECURRING_KEYWORDS = ["fixo", "fixa", "recorrente", "assinatura", "mensal", "mensalidade"];

const LIMIT_UPDATE_RE = /limite.*dispon[ií]ve(l|is)|dispon[ií]ve(l|is).*(no |do )?cart[ãa]o|limite (do|no) cart[ãa]o|atualizar limite/i;
const BILL_PAYMENT_RE = /(paguei|pagamento|paga|quitei|adiantei).*fatura|fatura.*(paga|paguei|quitada|adiantada)/i;
const INSTALLMENT_VERB_RE = /\bcomprei\b|\bcompra\b|\bparcelei\b/i;
const INSTALLMENT_COUNT_RE = /\b\d{1,2}\s*(x|vezes)\b|\bparcelas\b/i;
const TRANSFER_RE = /transfer[êe]ncia|\btransferi\b|\bpassei\b.*(para|pra)\b|\bmandei\b.*(para|pra)\b/i;
const BALANCE_ADJUSTMENT_RE = /\bsaldo\b/i;
const CARD_MENTION_RE = /cart[ãa]o/i;

export function classifyIntent(rawMessage) {
  const text = rawMessage;
  const normalized = normalize(rawMessage);

  if (LIMIT_UPDATE_RE.test(text)) {
    return { intent: "limit_update" };
  }

  if (BILL_PAYMENT_RE.test(text)) {
    return { intent: "bill_payment" };
  }

  if (INSTALLMENT_VERB_RE.test(text) && INSTALLMENT_COUNT_RE.test(text)) {
    return { intent: "installment_purchase", installmentCount: extractInstallmentCount(text) };
  }

  if (TRANSFER_RE.test(text)) {
    return { intent: "transfer" };
  }

  if (BALANCE_ADJUSTMENT_RE.test(text) && !CARD_MENTION_RE.test(text)) {
    return { intent: "balance_adjustment" };
  }

  const isIncome = INCOME_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
  return { intent: isIncome ? "income" : "expense" };
}

export function detectRecurring(rawMessage) {
  const normalized = normalize(rawMessage);
  return RECURRING_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
}
