import { normalize } from "./categoryRules.js";
import { extractInstallmentCount } from "./amountExtractor.js";

const INCOME_KEYWORDS = [
  "recebi", "receb", "ganhei", "ganho", "entrou", "salario", "salário",
  "venda", "vendi", "freela", "freelance", "pix recebido", "deposito",
  "depósito", "caiu", "pagamento recebido", "renda",
];

const RECURRING_KEYWORDS = ["fixo", "fixa", "recorrente", "assinatura", "mensal", "mensalidade"];

const LIMIT_UPDATE_RE = /limite.*dispon[ií]ve(l|is)|dispon[ií]ve(l|is).*(no |do )?cart[ãa]o|limite (do|no) cart[ãa]o|atualizar limite/i;
const BILL_ANTECIPATION_RE = /(antecipei|antecipa[cç][ãa]o|adiantei).*fatura|fatura.*(antecipada|adiantada)/i;
const BILL_PAYMENT_RE = /(paguei|pagamento|paga|quitei).*fatura|fatura.*(paga|paguei|quitada)/i;
const CREATE_BILL_RE = /\bpreciso (pagar|mandar)\b|\btenho que pagar\b|\blembrar de pagar\b|\bn[ãa]o esque[cç]a de pagar\b|\bvence\s*(dia|em|no dia)?\b|\bvencimento\b/i;
const PAY_VERB_RE = /\b(paguei|j[aá] paguei|quitei|mandei)\b/i;
const INSTALLMENT_VERB_RE = /\bcomprei\b|\bcompra\b|\bparcelei\b/i;
const INSTALLMENT_COUNT_RE = /\b\d{1,2}\s*(x|vezes)\b|\bparcelas\b/i;
const TRANSFER_RE = /transfer[êe]ncia|\btransferi\b|\b(mandei|passei)\b.*(para|pra)\s+(a\s+)?(pix|itau|ita[uú]|dinheiro|vale|conta)\b/i;
const BALANCE_ADJUSTMENT_RE = /\bsaldo\b/i;
const CARD_MENTION_RE = /cart[ãa]o/i;

export function classifyIntent(rawMessage) {
  const text = rawMessage;
  const normalized = normalize(rawMessage);

  if (LIMIT_UPDATE_RE.test(text)) {
    return { intent: "limit_update" };
  }

  if (BILL_ANTECIPATION_RE.test(text)) {
    return { intent: "bill_payment", billPaymentKind: "installment_anticipation" };
  }

  if (BILL_PAYMENT_RE.test(text)) {
    return { intent: "bill_payment", billPaymentKind: "card_bill_payment" };
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

  if (CREATE_BILL_RE.test(text)) {
    return { intent: "create_bill" };
  }

  const isIncome = INCOME_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
  if (isIncome) return { intent: "income" };

  return { intent: "expense", payVerbCandidate: PAY_VERB_RE.test(text) };
}

export function detectRecurring(rawMessage) {
  const normalized = normalize(rawMessage);
  return RECURRING_KEYWORDS.some((kw) => normalized.includes(normalize(kw)));
}
