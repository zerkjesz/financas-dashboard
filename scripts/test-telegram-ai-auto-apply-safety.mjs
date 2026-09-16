// Fase 7.0.1, item 4 — prova que confidence:"HIGH" do LLM NUNCA é, sozinho,
// suficiente pra autorizar auto-apply: só isSafeForAutoApply() (gate
// determinístico) decide, e evaluateConfirmationPolicy delega pra ele.
// Testes puros, sem banco.
//
//   node scripts/test-telegram-ai-auto-apply-safety.mjs
import { isSafeForAutoApply } from "../lib/telegramAi/executionSafety.js";
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
function planOf(...actions) {
  return { kind: "financial_plan", actions };
}

// ==========================================================================
// isSafeForAutoApply — gate determinístico isolado
// ==========================================================================
{
  const action = baseAction();
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] caso simples totalmente explícito -> safe=true", r.safe, JSON.stringify(r));
}
{
  // "LLM diz HIGH mas faltam dados" — conta/cartão NÃO foi resolvido de forma explícita.
  const action = baseAction();
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: false }, duplicates: [] });
  check('[gate] HIGH mas conta/cartão NÃO explícito -> safe=false (confidence sozinho não basta)', !r.safe && r.failedChecks.includes("paymentEntityResolvedUnambiguously"), JSON.stringify(r));
}
{
  // "LLM diz HIGH mas há duplicata".
  const action = baseAction();
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [{ record: {}, model: "expense" }] });
  check("[gate] HIGH mas duplicata encontrada -> safe=false", !r.safe && r.failedChecks.includes("noDuplicate"), JSON.stringify(r));
}
{
  // "LLM diz HIGH em snapshot" — SET_ACCOUNT_BALANCE_SNAPSHOT não é um tipo elegível pra auto-apply.
  const action = { type: "SET_ACCOUNT_BALANCE_SNAPSHOT", localId: "a1", confidence: "HIGH", account: "Itaú", observedBalance: "2000.00", date: "2026-09-16" };
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] HIGH em snapshot de saldo -> safe=false (tipo nunca elegível, mesmo com tudo explícito)", !r.safe && r.failedChecks.includes("allowedType") && r.failedChecks.includes("noReconciliation"), JSON.stringify(r));
}
{
  // Confidence MEDIUM sozinho já reprova, mesmo com tudo mais perfeito.
  const action = baseAction({ confidence: "MEDIUM" });
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] confidence MEDIUM -> safe=false", !r.safe && r.failedChecks.includes("highConfidence"), JSON.stringify(r));
}
{
  // Múltiplas actions no plano -> nunca elegível a auto-apply, mesmo a 1ª sendo perfeita.
  const action = baseAction();
  const plan = planOf(action, baseAction({ localId: "a2" }));
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] múltiplas actions no plano -> safe=false", !r.safe && r.failedChecks.includes("singleAction"), JSON.stringify(r));
}
{
  // Parcelamento nunca é elegível, mesmo com HIGH/tudo explícito.
  const action = { type: "RECORD_INSTALLMENT_PURCHASE", localId: "a1", confidence: "HIGH", totalAmount: "200.00", installments: 2, installmentAmount: "100.00", date: "2026-09-16", card: "Itaú" };
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] compra parcelada -> safe=false", !r.safe && r.failedChecks.includes("allowedType"), JSON.stringify(r));
}
{
  // Referência contextual ambígua (correção implícita) nunca é auto-apply.
  const action = baseAction({ referencesToPreviousMessage: { kind: "pending_action", localId: "x" } });
  const plan = planOf(action);
  const r = isSafeForAutoApply({ plan, action, resolution: { accountOrCardExplicit: true }, duplicates: [] });
  check("[gate] com referência a mensagem anterior -> safe=false (não é uma intenção 100% autocontida)", !r.safe && r.failedChecks.includes("noAmbiguousContextReference"), JSON.stringify(r));
}
{
  // Transfer auto-aplica só com as duas pontas resolvidas.
  const action = { type: "RECORD_TRANSFER", localId: "a1", confidence: "HIGH", amount: "50.00", date: "2026-09-16", fromAccount: "Itaú", toAccount: "Dinheiro" };
  const plan = planOf(action);
  const rOk = isSafeForAutoApply({ plan, action, resolution: { transferBothSidesResolved: true }, duplicates: [] });
  const rAmbiguous = isSafeForAutoApply({ plan, action, resolution: { transferBothSidesResolved: false }, duplicates: [] });
  check("[gate] transferência com as duas pontas resolvidas -> safe=true", rOk.safe, JSON.stringify(rOk));
  check("[gate] transferência com ponta ambígua -> safe=false", !rAmbiguous.safe, JSON.stringify(rAmbiguous));
}

// ==========================================================================
// evaluateConfirmationPolicy — prova que a decisão final É delegada ao gate,
// não decidida ad-hoc (item 4: "apenas esse gate pode permitir auto-apply").
// ==========================================================================
{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[]] });
  check("[policy] caso simples totalmente explícito -> autoConfirm=true", decision.autoConfirm, JSON.stringify(decision));
}
{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: false }], duplicateFlags: [[]] });
  check("[policy] HIGH mas dados faltando (conta não explícita) -> NÃO autoaplica mesmo com confidence HIGH", !decision.autoConfirm, JSON.stringify(decision));
}
{
  const plan = planOf(baseAction());
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }], duplicateFlags: [[{ record: {}, model: "expense" }]] });
  check("[policy] HIGH mas duplicata -> NÃO autoaplica", !decision.autoConfirm && decision.reason === "possivel_duplicata", JSON.stringify(decision));
}
{
  const plan = planOf({ type: "SET_ACCOUNT_BALANCE_SNAPSHOT", localId: "a1", confidence: "HIGH", account: "Itaú", observedBalance: "2000.00", date: "2026-09-16" });
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{}], duplicateFlags: [[]] });
  check("[policy] HIGH em snapshot -> NÃO autoaplica (tipo sempre confirma, nem chega no gate)", !decision.autoConfirm, JSON.stringify(decision));
}
{
  // A confidence do LLM é só UM dos fatos — mesmo confidence:"HIGH" mentindo
  // sobre um plano de 2 actions não convence a policy (múltiplas actions
  // sempre vence, antes até do gate rodar).
  const plan = planOf(baseAction(), baseAction({ localId: "a2" }));
  const decision = evaluateConfirmationPolicy(plan, { resolutions: [{ accountOrCardExplicit: true }, { accountOrCardExplicit: true }], duplicateFlags: [[], []] });
  check("[policy] múltiplas actions, mesmo com HIGH e tudo explícito -> NÃO autoaplica", !decision.autoConfirm && decision.reason === "multiplas_actions", JSON.stringify(decision));
}

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exitCode = fail > 0 ? 1 : 0;
