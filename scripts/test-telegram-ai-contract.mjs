// Fase 7.0 — testes PUROS (sem banco) do contrato FinancialIntentPlan e da
// política de confirmação. node scripts/test-telegram-ai-contract.mjs
import { parseAndValidatePlan, MAX_ACTIONS } from "../lib/telegramAi/financialIntentPlanSchema.js";
import { evaluateConfirmationPolicy } from "../lib/telegramAi/confirmationPolicy.js";

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

function baseAction(overrides = {}) {
  return { type: "RECORD_EXPENSE", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", ...overrides };
}

// ==========================================================================
// SCHEMA
// ==========================================================================
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [baseAction()] });
  check("[schema] plano simples válido passa", r.ok, JSON.stringify(r));
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [baseAction({ amount: 50 })] });
  check("[schema] amount como number (não string) é REJEITADO — nunca float como autoridade financeira", !r.ok);
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [baseAction({ date: "ontem" })] });
  check('[schema] data não-ISO ("ontem") é REJEITADA — data precisa já vir resolvida', !r.ok);
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [] });
  check("[schema] plano sem nenhuma action é REJEITADO (min 1)", !r.ok);
}
{
  const tooMany = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => baseAction({ localId: `a${i}` }));
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: tooMany });
  check(`[schema] mais de ${MAX_ACTIONS} actions é REJEITADO (máximo por mensagem)`, !r.ok);
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [baseAction({ localId: "dup" }), baseAction({ localId: "dup" })] });
  check("[schema] localId duplicado no mesmo plano é REJEITADO", !r.ok);
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [{ type: "TOTALLY_MADE_UP_TYPE", localId: "a1", confidence: "HIGH" }] });
  check("[schema] type fora do enum é REJEITADO (allowlist, item 15)", !r.ok);
}
{
  const r = parseAndValidatePlan({
    kind: "financial_plan",
    actions: [{ type: "RECORD_INSTALLMENT_PURCHASE", localId: "a1", confidence: "HIGH", totalAmount: "118.34", installments: 2, installmentAmount: "59.17", date: "2026-09-08", card: "Itaú", merchant: "Mercado Livre", description: "controle do portão" }],
  });
  check("[schema] compra parcelada real (caso B do pedido) valida corretamente", r.ok, JSON.stringify(r));
}
{
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [{ type: "CLARIFICATION_REQUIRED", localId: "a1", confidence: "LOW", question: "Foi no Itaú, cartão ou vale?" }] });
  check("[schema] CLARIFICATION_REQUIRED valida com só a pergunta", r.ok);
}
{
  const r = parseAndValidatePlan({
    kind: "financial_plan",
    actions: [{ type: "CORRECT_PREVIOUS_ACTION", localId: "a1", confidence: "HIGH", target: { kind: "pending_action", localId: "a1" }, fieldChanges: {} }],
  });
  check("[schema] correção sem NENHUM campo mudado é REJEITADA (correção vazia não faz sentido)", !r.ok);
}
{
  // Tentativa de payload malicioso/fora do schema — nunca passa (item 15: allowlist + schema).
  const r = parseAndValidatePlan({ kind: "financial_plan", actions: [{ type: "RECORD_EXPENSE", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", __proto__: { polluted: true }, sqlInjection: "DROP TABLE expense;" }] });
  check("[schema] campos desconhecidos/maliciosos não quebram a validação nem entram no objeto executável", r.ok && !("sqlInjection" in r.plan.actions[0]));
}

// ==========================================================================
// CONFIRMATION POLICY (item 5 — thresholds explícitos, testáveis)
// ==========================================================================
function planOf(...actions) {
  return { kind: "financial_plan", actions };
}

{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[]] });
  check("[policy] gasto simples + conta explícita + alta confiança + sem duplicata -> autoconfirma", decision.autoConfirm, JSON.stringify(decision));
}
{
  const plan = planOf(baseAction(), baseAction({ localId: "a2" }));
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }, { accountOrCardExplicit: true }], duplicateFlags: [[], []] });
  check("[policy] múltiplas actions -> SEMPRE confirma, mesmo com tudo explícito", !decision.autoConfirm && decision.reason === "multiplas_actions");
}
{
  const plan = planOf(baseAction({ type: "RECORD_INSTALLMENT_PURCHASE", totalAmount: "118.34", installments: 2, installmentAmount: "59.17", card: "Itaú" }));
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[]] });
  check("[policy] compra parcelada -> SEMPRE confirma (item 6)", !decision.autoConfirm);
}
{
  const plan = planOf({ type: "SET_ACCOUNT_BALANCE_SNAPSHOT", localId: "a1", confidence: "HIGH", account: "Itaú", observedBalance: "2099.34", date: "2026-09-16" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{}], duplicateFlags: [[]] });
  check("[policy] snapshot de saldo -> SEMPRE confirma (item 8)", !decision.autoConfirm);
}
{
  const plan = planOf({ type: "SET_CARD_BILL_SNAPSHOT", localId: "a1", confidence: "HIGH", card: "Itaú", observedTotal: "1553.19", date: "2026-09-16" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{}], duplicateFlags: [[]] });
  check("[policy] snapshot de fatura -> SEMPRE confirma (item 7)", !decision.autoConfirm);
}
{
  const plan = planOf({ type: "CREATE_CONFIRMED_COMMITMENT", localId: "a1", confidence: "HIGH", amount: "300.00", dueDate: "2026-10-01", description: "Aluguel" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{}], duplicateFlags: [[]] });
  check("[policy] compromisso confirmado -> SEMPRE confirma", !decision.autoConfirm);
}
{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[{ record: {}, model: "expense" }]] });
  check("[policy] possível duplicata -> SEMPRE confirma, mesmo simples/explícito", !decision.autoConfirm && decision.reason === "possivel_duplicata");
}
{
  const plan = planOf(baseAction({ confidence: "MEDIUM" }));
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[]] });
  check("[policy] confiança MEDIUM (não HIGH) -> confirma, nunca autoconfirma", !decision.autoConfirm && decision.reason === "baixa_confianca");
}
{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: false }], duplicateFlags: [[]] });
  check("[policy] conta/meio NÃO explícito (default silencioso) -> confirma, nunca autoconfirma", !decision.autoConfirm && decision.reason === "conta_meio_nao_explicito");
}
{
  const plan = planOf({ type: "RECORD_TRANSFER", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", toAccount: "Bia" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ transferBothSidesResolved: false }], duplicateFlags: [[]] });
  check("[policy] transferência com ponta ambígua -> confirma", !decision.autoConfirm && decision.reason === "transferencia_ambigua");
}
{
  const plan = planOf({ type: "RECORD_TRANSFER", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", fromAccount: "Itaú", toAccount: "Dinheiro" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ transferBothSidesResolved: true }], duplicateFlags: [[]] });
  check("[policy] transferência com as duas pontas resolvidas sem ambiguidade -> autoconfirma", decision.autoConfirm);
}
{
  const plan = planOf({ type: "DELETE_OR_UNDO_PREVIOUS_ACTION", localId: "a1", confidence: "HIGH", target: { kind: "applied_record", model: "expense", id: "x" } });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{}], duplicateFlags: [[]] });
  check("[policy] delete/undo -> SEMPRE confirma (nunca destrutivo sem confirmação)", !decision.autoConfirm);
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exitCode = fail > 0 ? 1 : 0;
