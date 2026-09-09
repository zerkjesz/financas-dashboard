import { normalize } from "./categoryRules.js";
import { extractAmount, extractInstallmentCount } from "./amountExtractor.js";

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
const CREATE_CARD_RE = /\b(criar|novo|cadastrar)\s+cart[ãa]o\b/i;
const CREATE_RECURRING_BILL_RE = /\b(criar|nova|cadastrar)\s+conta\s+(fixa|recorrente)\b|\bconta\s+recorrente\b/i;
const CREATE_GOAL_RE = /\b(criar|nova|cadastrar)\s+meta\b/i;
const ADD_TO_GOAL_RE = /\b(guardei|separei)\b.*\bmeta\b|\bpra\s+meta\b/i;
const CREATE_ACCOUNT_RE = /\b(criar|nova|cadastrar)\s+conta\b/i;
const PAY_VERB_RE = /\b(paguei|j[aá] paguei|quitei|mandei)\b/i;
const INSTALLMENT_VERB_RE = /\bcomprei\b|\bcompra\b|\bparcelei\b|\bpassei\b|\bpassou\b/i;
const INSTALLMENT_COUNT_RE = /\b\d{1,2}\s*(x|vezes)\b|\bparcelas\b/i;
const TRANSFER_RE = /transfer[êe]ncia|\btransferi\b|\b(mandei|passei)\b.*(para|pra)\s+(a\s+)?(pix|itau|ita[uú]|dinheiro|vale|conta)\b/i;
const BALANCE_ADJUSTMENT_RE = /\bsaldo\b/i;
const CARD_MENTION_RE = /cart[ãa]o/i;

// ============================================================================
// Fase 5.3D, itens 1-2 — READ vs WRITE. CRÍTICO: só é tratado como READ
// quando a frase é INEQUIVOCAMENTE interrogativa (tem "?" OU começa com um
// marcador interrogativo) — nunca por causa de uma palavra-chave sozinha
// ("saldo"/"fatura"/"parcela" aparecem tanto em READ quanto em WRITE). Essa é
// a garantia central que evita a colisão descrita no pedido: "saldo 800"
// (afirmação, WRITE) nunca vira "qual meu saldo?" (pergunta, READ) só porque
// as duas têm a palavra "saldo".
//
// Checado ANTES de qualquer regra de WRITE (precedência mais alta) — se cair
// aqui, NUNCA passa pelas regras de mutação abaixo.
// ============================================================================
// Fase 5.3D.1, item 1/5 — TUDO abaixo é testado contra `normalized`
// (lib/categoryRules.js:normalize — minúsculas + acentos removidos via NFD),
// NUNCA contra o texto cru. Achado real da 5.3D: READ_SUMMARY_RE era testada
// contra `rawMessage` com classes de caractere manuais tipo `t[oô]` pra
// tentar cobrir "tô"/"to" — `\b` do JS usa a definição ASCII de "caractere de
// palavra", então um `\b` logo depois de uma letra acentuada (ô, ã, ç...) não
// se comporta de forma confiável ("como eu tô" falhava silenciosamente,
// "como eu to" funcionava — inconsistência real, corrigida aqui). Normalizar
// ANTES elimina a classe de bug inteira: depois de normalize(), só sobra
// ASCII puro, onde `\b` sempre funciona como esperado — nenhuma classe de
// caractere manual (`[oô]`/`[ãa]`/`[cç]`) é mais necessária em lugar nenhum.
const INTERROGATIVE_START_RE = /^\s*(quanto|quantos?|quanta|qual|quais|como|quando|cade|o que)\b/i;

// Tolera "?" ausente (item 2), maiúsculas/minúsculas (normalize já
// lowercase), acento presente ou ausente (normalize já remove), espaços
// extras (`^\s*` + `\b` não se importam com espaço à direita).
function isInterrogative(normalizedText) {
  return normalizedText.includes("?") || INTERROGATIVE_START_RE.test(normalizedText);
}

// READ_SUMMARY não exige interrogação — "me dá um resumo" é um pedido, não
// uma pergunta, mas é inequivocamente READ (nenhum verbo de escrita nela).
const READ_SUMMARY_RE = /\bresumo\b|\bcomo (eu )?(to|estou)\b|\bsituacao financeira\b|\bcomo (estao|esta) minhas financas\b/i;
const READ_FREE_MONEY_RE = /\blivre\b|\bposso gastar\b|\bseguro.*gastar\b|\bgastar.*seguro\b/i;
const READ_NEXT_INCOME_RE = /\bsalario\b|\brenda\b/i;
const READ_EXTERNAL_INSTALLMENTS_RE = /\bparcelas?\b/i;
const READ_VA_RE = /\bvale\b|\bcaju\b|\bva\b/i;
const READ_CARD_RE = /\bfatura\b|\blimite\b|\bcartao\b/i;
const READ_BALANCE_RE = /\bsaldo\b|\btenho\b/i;

// ============================================================================
// Fase 5.3E, itens 27-29 — SIMULAÇÃO ("e se..."). Checado ANTES de
// classifyReadIntent E de qualquer regra de WRITE (precedência mais alta de
// todas): uma frase hipotética nunca pode ser confundida com uma pergunta de
// leitura genérica nem com um lançamento real. Garantias de não-colisão
// (Fase 5.3E, item 28 — testadas em scripts/test-telegram-simulation-collision.mjs):
//   - "gastei 500"/"comprei 1200 em 6x" (SEM "e se"/"posso") nunca disparam
//     simulação — continuam WRITE, comportamento intacto.
//   - "quanto posso gastar?" (SEM valor numérico) nunca vira simulação — cai
//     no read_free_money genérico de sempre (a pergunta não tem "o quê"
//     simular, só "quanto").
//   - "posso gastar 500?"/"e se eu comprar 1200 no cartão?" SEMPRE viram
//     simulação, nunca read_free_money/expense.
const SIMULATE_HYPOTHETICAL_RE = /\be se\b/i;
const SIMULATE_CAN_SPEND_RE = /\b(posso|consigo)\s+gastar\b/i;
const SIMULATE_INSTALLMENT_VERB_RE = /\bparcelar\b/i;
const SIMULATE_CARD_PURCHASE_VERB_RE = /\bcomprar\b/i;
// "se a reforma ficar 2000 como eu fico?" — captura o NOME da contingência
// entre "se a/o" e "ficar" (grupo 1), resolvido por fuzzy-match contra as
// Contingency reais só depois, em lib/telegramSimulation.js (o classificador
// continua puro — nunca acessa o banco). Não exige "e se" (a frase natural do
// pedido usa só "se"), mas o padrão "se a/o <algo> ficar" é específico o
// bastante pra não colidir com frases de WRITE reais (nenhuma delas hoje usa
// essa forma — ver scripts/test-telegram-simulation-collision.mjs).
const SIMULATE_CONTINGENCY_RE = /\bse\s+(?:a|o)\s+(.+?)\s+ficar\b/;

function classifySimulationIntent(rawMessage) {
  const normalized = normalize(rawMessage);

  const contingencyMatch = normalized.match(SIMULATE_CONTINGENCY_RE);
  if (contingencyMatch) {
    const { amount } = extractAmount(rawMessage);
    return { intent: "simulate_contingency", contingencyQuery: contingencyMatch[1].trim(), amount };
  }

  const isHypothetical = SIMULATE_HYPOTHETICAL_RE.test(normalized);
  const isCanSpend = SIMULATE_CAN_SPEND_RE.test(normalized);
  if (!isHypothetical && !isCanSpend) return null;

  // Sem valor numérico não há o QUE simular (ex: "quanto posso gastar?", uma
  // pergunta genérica de leitura) — deixa cair pro fluxo normal em vez de
  // inventar um cenário sem parâmetro.
  const { amount } = extractAmount(rawMessage);
  if (amount == null) return null;

  if (SIMULATE_INSTALLMENT_VERB_RE.test(normalized) || INSTALLMENT_COUNT_RE.test(normalized)) {
    return { intent: "simulate_card_purchase_installments", amount, installmentCount: extractInstallmentCount(rawMessage) || 1 };
  }
  if (SIMULATE_CARD_PURCHASE_VERB_RE.test(normalized) && CARD_MENTION_RE.test(normalized)) {
    return { intent: "simulate_card_purchase_single", amount };
  }
  // Fallback documentado: hipotético sem menção explícita a cartão/parcela ->
  // tratado como gasto em dinheiro/débito (nunca assume cartão sem o usuário
  // ter dito "cartão" — mesma cautela de "nunca inventar o método de
  // pagamento" já aplicada no resto do parser).
  return { intent: "simulate_cash_expense", amount };
}

function classifyReadIntent(rawMessage) {
  const normalized = normalize(rawMessage);

  if (READ_SUMMARY_RE.test(normalized)) return { intent: "read_summary" };

  if (!isInterrogative(normalized)) return null; // tudo abaixo exige pergunta explícita.

  if (READ_FREE_MONEY_RE.test(normalized)) return { intent: "read_free_money" };
  if (READ_EXTERNAL_INSTALLMENTS_RE.test(normalized)) return { intent: "read_external_installments" };
  if (READ_VA_RE.test(normalized)) return { intent: "read_va" };
  if (READ_CARD_RE.test(normalized)) return { intent: "read_card" };
  if (READ_NEXT_INCOME_RE.test(normalized)) return { intent: "read_next_income" };
  if (READ_BALANCE_RE.test(normalized)) return { intent: "read_balance" };

  return null;
}

export function classifyIntent(rawMessage) {
  const text = rawMessage;
  const normalized = normalize(rawMessage);

  // Fase 5.3E — SIMULAÇÃO tem a precedência MAIS ALTA de todas (antes até de
  // READ): uma frase hipotética ("e se...", "posso gastar X?") nunca deve ser
  // respondida como se fosse uma leitura do estado atual real, nem como um
  // lançamento de verdade.
  const simulationIntent = classifySimulationIntent(rawMessage);
  if (simulationIntent) return simulationIntent;

  const readIntent = classifyReadIntent(rawMessage);
  if (readIntent) return readIntent;

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

  // Checados antes de create_bill: "criar cartão ... vencimento dia 10" também bate no
  // gatilho genérico de "vencimento" do create_bill, mas "criar cartão/conta/meta" é sinal
  // bem mais específico e tem que ganhar.
  if (CREATE_CARD_RE.test(text)) {
    return { intent: "create_card" };
  }

  if (CREATE_RECURRING_BILL_RE.test(text)) {
    return { intent: "create_recurring_bill" };
  }

  if (CREATE_GOAL_RE.test(text)) {
    return { intent: "create_goal" };
  }

  if (ADD_TO_GOAL_RE.test(text)) {
    return { intent: "add_to_goal" };
  }

  if (CREATE_ACCOUNT_RE.test(text)) {
    return { intent: "create_account" };
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
