// ============================================================================
// Fase 7.0.1, item 4 — gate determinístico único de auto-apply.
//
// O LLM pode declarar confidence:"HIGH" no plano, mas isso é uma opinião
// SEMÂNTICA sobre a interpretação do texto — nunca uma autorização de
// escrita. `confidence` continua sendo UM dos fatos que este gate confere,
// mas nunca o único, e nunca por si só suficiente: mesmo com HIGH, uma
// action só é segura pra auto-apply se TODOS os fatos abaixo, verificáveis
// em código (nunca inferidos/confiados do LLM), também baterem.
//
// Esta é a ÚNICA função que decide "auto-apply é seguro" — confirmationPolicy.js
// delega a decisão final pra cá; ela mesma só decide os casos de
// curto-circuito (múltiplas actions, tipo sempre-confirma, duplicata) que
// nem chegam a ser candidatos a auto-apply.
// ============================================================================
const AUTO_APPLY_ALLOWED_TYPES = new Set(["RECORD_EXPENSE", "RECORD_INCOME", "RECORD_CARD_PURCHASE", "RECORD_TRANSFER"]);

const RECONCILIATION_TYPES = new Set(["SET_ACCOUNT_BALANCE_SNAPSHOT", "SET_VA_BALANCE_SNAPSHOT", "SET_CARD_BILL_SNAPSHOT"]);

const DECIMAL_STRING_RE = /^\d{1,12}(\.\d{1,2})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// `plan` inteiro (não só a action) — o número de actions no plano É um dos
// fatos verificáveis (item 4: "uma única action").
export function isSafeForAutoApply({ plan, action, resolution, duplicates } = {}) {
  const dup = duplicates || [];
  const res = resolution || {};

  const entityExplicit = action?.type === "RECORD_TRANSFER" ? Boolean(res.transferBothSidesResolved) : Boolean(res.accountOrCardExplicit);

  const checks = {
    singleAction: (plan?.actions?.length ?? 0) === 1,
    allowedType: AUTO_APPLY_ALLOWED_TYPES.has(action?.type),
    highConfidence: action?.confidence === "HIGH",
    amountExplicitAndValid: typeof action?.amount === "string" && DECIMAL_STRING_RE.test(action.amount) && Number(action.amount) > 0,
    dateValid: typeof action?.date === "string" && ISO_DATE_RE.test(action.date),
    paymentEntityResolvedUnambiguously: entityExplicit,
    noInstallments: action?.type !== "RECORD_INSTALLMENT_PURCHASE",
    noReconciliation: !RECONCILIATION_TYPES.has(action?.type),
    noDuplicate: dup.length === 0,
    noAmbiguousContextReference: !action?.referencesToPreviousMessage,
  };

  const failedChecks = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return { safe: failedChecks.length === 0, failedChecks };
}
