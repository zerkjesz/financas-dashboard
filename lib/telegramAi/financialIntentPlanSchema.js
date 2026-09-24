import { z } from "zod";

// ============================================================================
// Fase 7.0 — CONTRATO: FinancialIntentPlan.
//
// Isto é a ÚNICA coisa que sai do LLM e entra no domínio determinístico do
// Norte. Nenhum campo aqui é executado sem passar por isto primeiro (item 15
// do pedido: "LLM output deve passar por allowlist + schema"). O LLM nunca
// grava nada — ele só preenche esta estrutura; lib/telegramAi/planExecutor.js
// é quem de fato chama os serviços financeiros existentes.
//
// Dinheiro é sempre STRING decimal (ex.: "118.34"), nunca number — o LLM
// nunca é autoridade sobre precisão monetária; o valor só vira Decimal de
// verdade dentro do executor, via lib/money.js (o mesmo caminho usado pelo
// resto do app). "Nunca float como autoridade financeira" (item 1).
// ============================================================================

const MAX_ACTIONS_PER_MESSAGE = 20; // item 15: "máximo de tamanho/ações por mensagem".

// Fase 7.0.3 — achado real contra a Groq: em Structured Outputs strict mode
// TODO campo é `required`, então um campo "opcional" nunca fica AUSENTE na
// resposta — o provider manda `null` explicitamente. `.nullish()` (Zod)
// só aceita `undefined`, não `null`; rejeitava toda resposta real da Groq
// com "Expected string, received null". `.nullish()` aceita os dois — e
// isso é seguro em todo o código posterior porque planExecutor.js,
// correctionService.js, entityResolver.js etc. já usam checagens
// `!= null`/truthy (nunca "in"/"hasOwnProperty"), que tratam `null` e
// `undefined` de forma idêntica. Nenhuma regra financeira mudou — só
// passou a aceitar a MESMA ausência representada de duas formas.
const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, "valor monetário precisa ser uma string decimal (ex: \"118.34\")");

const isoDateString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "data precisa estar em YYYY-MM-DD (já resolvida pelo interpretador, nunca texto solto tipo \"ontem\")");

const CONFIDENCE_LEVELS = z.enum(["HIGH", "MEDIUM", "LOW"]);

// ----------------------------------------------------------------------------
// Metadados comuns a toda action — nunca campos financeiros novos aqui, só o
// que ajuda a rastrear/auditar/desambiguar a origem da interpretação.
// ----------------------------------------------------------------------------
const baseActionFields = {
  // Índice estável desta action dentro do plano — usado por correções
  // subsequentes ("na verdade foi 90") pra apontar exatamente qual action
  // do plano anterior está sendo alterada (item 12: "não usar substring
  // heuristics frágeis pra decidir a referência").
  localId: z.string().min(1).max(40),
  confidence: CONFIDENCE_LEVELS,
  notes: z.string().max(500).nullish(),
  // Quando esta action é uma reinterpretação/correção de uma action de uma
  // mensagem anterior (ainda pendente ou já aplicada), aponta pro localId
  // ou pro id real do registro (id do Expense/Income/etc.), nunca por
  // adivinhação textual.
  referencesToPreviousMessage: z
    .object({
      kind: z.enum(["pending_action", "applied_record"]),
      // localId de uma action pendente, OU {model, id} de um registro já aplicado.
      localId: z.string().nullish(),
      model: z.string().nullish(),
      id: z.string().nullish(),
    })
    .nullish(),
};

const partyFields = {
  merchant: z.string().max(200).nullish(),
  payee: z.string().max(200).nullish(),
  payer: z.string().max(200).nullish(),
  category: z.string().max(80).nullish(),
  description: z.string().max(300).nullish(),
  account: z.string().max(120).nullish(), // nome livre — resolvido de verdade por lib/accountResolver.js no validator, nunca por ID inventado.
  card: z.string().max(120).nullish(),
  paymentMethod: z.enum(["pix", "dinheiro", "cartao_credito", "cartao_debito", "vale", "transferencia", "desconhecido"]).nullish(),
  source: z.string().max(40).nullish(), // proveniência livre (ex.: "telegram_text") — nunca "manual"/"migration" fabricado.
};

// ----------------------------------------------------------------------------
// RECORD_* — lançamentos de ledger reais (Expense/Income/Transfer/Purchase).
// ----------------------------------------------------------------------------
const recordExpense = z.object({
  type: z.literal("RECORD_EXPENSE"),
  ...baseActionFields,
  amount: decimalString,
  date: isoDateString,
  ...partyFields,
});

const recordIncome = z.object({
  type: z.literal("RECORD_INCOME"),
  ...baseActionFields,
  amount: decimalString,
  date: isoDateString,
  ...partyFields,
});

const recordTransfer = z.object({
  type: z.literal("RECORD_TRANSFER"),
  ...baseActionFields,
  amount: decimalString,
  date: isoDateString,
  fromAccount: z.string().max(120).nullish(),
  toAccount: z.string().max(120).nullish(),
  toCard: z.string().max(120).nullish(),
  description: z.string().max(300).nullish(),
});

const recordCardPurchase = z.object({
  type: z.literal("RECORD_CARD_PURCHASE"),
  ...baseActionFields,
  amount: decimalString,
  date: isoDateString,
  card: z.string().max(120),
  ...partyFields,
});

const recordInstallmentPurchase = z.object({
  type: z.literal("RECORD_INSTALLMENT_PURCHASE"),
  ...baseActionFields,
  totalAmount: decimalString,
  installments: z.number().int().min(2).max(48),
  installmentAmount: decimalString,
  date: isoDateString,
  card: z.string().max(120),
  ...partyFields,
});

const recordCardPayment = z.object({
  type: z.literal("RECORD_CARD_PAYMENT"),
  ...baseActionFields,
  amount: decimalString,
  date: isoDateString,
  card: z.string().max(120),
  fromAccount: z.string().max(120).nullish(),
});

// ----------------------------------------------------------------------------
// SET_*_SNAPSHOT — observação/reconciliação. NUNCA vira Expense/Income.
// ----------------------------------------------------------------------------
const setAccountBalanceSnapshot = z.object({
  type: z.literal("SET_ACCOUNT_BALANCE_SNAPSHOT"),
  ...baseActionFields,
  account: z.string().max(120),
  observedBalance: decimalString,
  date: isoDateString,
});

const setVaBalanceSnapshot = z.object({
  type: z.literal("SET_VA_BALANCE_SNAPSHOT"),
  ...baseActionFields,
  observedBalance: decimalString,
  date: isoDateString,
});

const setCardBillSnapshot = z.object({
  type: z.literal("SET_CARD_BILL_SNAPSHOT"),
  ...baseActionFields,
  card: z.string().max(120),
  observedTotal: decimalString,
  date: isoDateString,
});

// ----------------------------------------------------------------------------
// Compromissos / contingências / recebíveis.
// ----------------------------------------------------------------------------
const createConfirmedCommitment = z.object({
  type: z.literal("CREATE_CONFIRMED_COMMITMENT"),
  ...baseActionFields,
  amount: decimalString,
  dueDate: isoDateString,
  description: z.string().max(300),
});

const updateConfirmedCommitment = z.object({
  type: z.literal("UPDATE_CONFIRMED_COMMITMENT"),
  ...baseActionFields,
  targetDescription: z.string().max(300),
  amount: decimalString.nullish(),
  dueDate: isoDateString.nullish(),
});

const settleConfirmedCommitment = z.object({
  type: z.literal("SETTLE_CONFIRMED_COMMITMENT"),
  ...baseActionFields,
  targetDescription: z.string().max(300),
  account: z.string().max(120).nullish(),
});

const createContingency = z.object({
  type: z.literal("CREATE_CONTINGENCY"),
  ...baseActionFields,
  description: z.string().max(300),
  maxAmount: decimalString,
  expectedAmount: decimalString.nullish(),
  expectedDate: isoDateString.nullish(),
});

const updateContingency = z.object({
  type: z.literal("UPDATE_CONTINGENCY"),
  ...baseActionFields,
  targetDescription: z.string().max(300),
  status: z.enum(["AWAITING_INFORMATION", "CONFIRMED", "DISMISSED"]).nullish(),
  maxAmount: decimalString.nullish(),
});

const createReceivable = z.object({
  type: z.literal("CREATE_RECEIVABLE"),
  ...baseActionFields,
  description: z.string().max(300),
  counterparty: z.string().max(200),
  amount: decimalString,
  expectedDate: isoDateString.nullish(),
});

// ----------------------------------------------------------------------------
// Leitura / simulação — NUNCA escreve; o LLM nunca calcula o número, só
// identifica a pergunta. O executor chama os serviços reais (item 13).
// ----------------------------------------------------------------------------
const queryFinancialState = z.object({
  type: z.literal("QUERY_FINANCIAL_STATE"),
  ...baseActionFields,
  topic: z.enum(["free_money", "card_bill", "va_balance", "commitment_load", "installment_relief", "category_breakdown", "general_snapshot"]),
  card: z.string().max(120).nullish(),
  // Fase 7.0.1, item 2 — só usado por topic="category_breakdown". Período já
  // resolvido pelo interpretador (nunca texto solto tipo "mês passado" chega
  // aqui cru) — "current_month"/"last_month", ou um intervalo ISO explícito
  // quando o usuário dá datas concretas. Ausente = mês atual (default seguro
  // em lib/categoryBreakdown.js, nunca um erro).
  period: z.union([z.enum(["current_month", "last_month"]), z.object({ start: isoDateString, end: isoDateString })]).nullish(),
});

const simulatePurchase = z.object({
  type: z.literal("SIMULATE_PURCHASE"),
  ...baseActionFields,
  amount: decimalString,
  installments: z.number().int().min(1).max(48).nullish(),
  paymentMethod: z.enum(["pix", "dinheiro", "cartao_credito", "vale", "desconhecido"]).nullish(),
  card: z.string().max(120).nullish(),
});

// ----------------------------------------------------------------------------
// Correção / desfazer — sempre aponta pra algo específico, nunca "o último"
// por heurística de texto (item 12).
// ----------------------------------------------------------------------------
const correctPreviousAction = z.object({
  type: z.literal("CORRECT_PREVIOUS_ACTION"),
  ...baseActionFields,
  target: z.object({
    kind: z.enum(["pending_action", "applied_record"]),
    localId: z.string().nullish(),
    model: z.string().nullish(),
    id: z.string().nullish(),
  }),
  fieldChanges: z
    .object({
      amount: decimalString.nullish(),
      date: isoDateString.nullish(),
      account: z.string().max(120).nullish(),
      card: z.string().max(120).nullish(),
      paymentMethod: z.enum(["pix", "dinheiro", "cartao_credito", "cartao_debito", "vale", "transferencia", "desconhecido"]).nullish(),
      description: z.string().max(300).nullish(),
      category: z.string().max(80).nullish(),
    })
    // Fase 7.0.3 — agora que os campos são .nullish() (aceitam null explícito
    // da Groq), TODAS as chaves sempre existem no objeto parseado, mesmo sem
    // nenhuma correção real (viriam todas null). "pelo menos um campo mudou"
    // deixou de ser "pelo menos uma chave presente" e passou a ser "pelo
    // menos um VALOR não-nulo" — mesma regra de negócio, checagem ajustada
    // pra continuar funcionando com a nova representação de ausência.
    .refine((obj) => Object.values(obj).some((v) => v != null), "correção precisa mudar pelo menos um campo"),
});

const deleteOrUndoPreviousAction = z.object({
  type: z.literal("DELETE_OR_UNDO_PREVIOUS_ACTION"),
  ...baseActionFields,
  target: z.object({
    kind: z.enum(["pending_action", "applied_record"]),
    localId: z.string().nullish(),
    model: z.string().nullish(),
    id: z.string().nullish(),
  }),
});

// ----------------------------------------------------------------------------
// Sentinelas — sempre um plano de 1 action só.
// ----------------------------------------------------------------------------
const clarificationRequired = z.object({
  type: z.literal("CLARIFICATION_REQUIRED"),
  ...baseActionFields,
  question: z.string().min(1).max(300),
  // O que já foi entendido com confiança, pra não perder contexto enquanto
  // pergunta o que falta (ex.: já sabe que foi R$50 de gasolina, só falta
  // saber a conta) — parcial, mesmo shape de uma action real, mas nunca
  // executável sozinho.
  partialAction: z.record(z.string(), z.unknown()).nullish(),
});

const noFinancialIntent = z.object({
  type: z.literal("NO_FINANCIAL_INTENT"),
  ...baseActionFields,
});

// ----------------------------------------------------------------------------
const actionSchema = z.discriminatedUnion("type", [
  recordExpense,
  recordIncome,
  recordTransfer,
  recordCardPurchase,
  recordInstallmentPurchase,
  recordCardPayment,
  setAccountBalanceSnapshot,
  setVaBalanceSnapshot,
  setCardBillSnapshot,
  createConfirmedCommitment,
  updateConfirmedCommitment,
  settleConfirmedCommitment,
  createContingency,
  updateContingency,
  createReceivable,
  queryFinancialState,
  simulatePurchase,
  correctPreviousAction,
  deleteOrUndoPreviousAction,
  clarificationRequired,
  noFinancialIntent,
]);

export const FinancialIntentPlanSchema = z
  .object({
    kind: z.literal("financial_plan"),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS_PER_MESSAGE),
  })
  .refine((plan) => {
    const localIds = plan.actions.map((a) => a.localId);
    return new Set(localIds).size === localIds.length;
  }, "localId duplicado dentro do mesmo plano");

export const ACTION_TYPES = Object.freeze([
  "RECORD_EXPENSE",
  "RECORD_INCOME",
  "RECORD_TRANSFER",
  "RECORD_CARD_PURCHASE",
  "RECORD_INSTALLMENT_PURCHASE",
  "RECORD_CARD_PAYMENT",
  "SET_ACCOUNT_BALANCE_SNAPSHOT",
  "SET_VA_BALANCE_SNAPSHOT",
  "SET_CARD_BILL_SNAPSHOT",
  "CREATE_CONFIRMED_COMMITMENT",
  "UPDATE_CONFIRMED_COMMITMENT",
  "SETTLE_CONFIRMED_COMMITMENT",
  "CREATE_CONTINGENCY",
  "UPDATE_CONTINGENCY",
  "CREATE_RECEIVABLE",
  "QUERY_FINANCIAL_STATE",
  "SIMULATE_PURCHASE",
  "CORRECT_PREVIOUS_ACTION",
  "DELETE_OR_UNDO_PREVIOUS_ACTION",
  "CLARIFICATION_REQUIRED",
  "NO_FINANCIAL_INTENT",
]);

export const MAX_ACTIONS = MAX_ACTIONS_PER_MESSAGE;

// Fail-closed (item 15/21): nunca lança pra fora — devolve um resultado
// tipado, o chamador decide o que fazer (nunca deixa um JSON inválido
// alcançar o executor).
export function parseAndValidatePlan(raw) {
  const result = FinancialIntentPlanSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, plan: result.data };
}
