// ============================================================================
// Fase 5.4D — COMMITMENTS PRESENTATION HELPERS. Mesmo padrão de
// lib/homePresentation.js: pura derivação sobre o read model canônico
// (financial.currentObligations/nextIncomeCommitment/futureObligations/
// contingency/externalInstallments, todos de lib/productFinancialSnapshot.js)
// — NUNCA reclassifica, NUNCA recalcula freeMoney/committed/exposure aqui.
// ============================================================================

import { obligationItemLabel, obligationItemDate, obligationItemHref, OBLIGATION_CLASS_LABEL } from "./homePresentation";

// Item 26 — taxonomia humana aprovada, reaproveitando OBLIGATION_CLASS_LABEL
// que já existe (lib/homePresentation.js, Fase 5.4A/5.4C) em vez de inventar
// uma segunda tabela de rótulos pro mesmo enum.
export { OBLIGATION_CLASS_LABEL, obligationItemLabel, obligationItemDate, obligationItemHref };

export const FUTURE_TYPE_LABEL = {
  CardBill: "Fatura de cartão",
  Bill: "Conta avulsa",
  ExternalInstallment: "Parcela externa",
  ConfirmedCommitment: "Compromisso confirmado",
};

// Bills CRUD (Bill model) — mesmos rótulos que ContasAPagarView já usava,
// só centralizados pra reaproveitar no novo BillsManager.
export const BILL_STATUS_LABEL = { pending: "pendente", overdue: "atrasada", paid: "paga", cancelled: "cancelada" };
export const BILL_STATUS_BADGE_VARIANT = { pending: "neutral", overdue: "danger", paid: "positive", cancelled: "neutral" };
