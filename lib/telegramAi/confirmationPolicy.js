// ============================================================================
// Fase 7.0 — política de confirmação (item 5 do pedido): thresholds
// EXPLÍCITOS, testáveis, nunca "comportamento mágico". Esta função é pura
// (sem I/O) — recebe o plano JÁ VALIDADO + resultado de dedupe, devolve uma
// decisão determinística.
//
// Regra central: autoconfirma SÓ quando TODAS as condições de baixo risco
// batem pra TODAS as actions do plano. Qualquer action de risco mais alto
// (a lista fixa abaixo) força confirmação do plano INTEIRO — nunca aplica
// parte com confirmação e parte sem.
//
// Fase 7.0.1, item 4 — a decisão final de "pode autoaplicar" NUNCA é tomada
// aqui diretamente: é delegada pra isSafeForAutoApply() (executionSafety.js),
// o único lugar que confere os fatos determinísticos (amount válido, conta/
// cartão resolvido sem ambiguidade, sem parcelamento, sem duplicata, etc.).
// confidence:"HIGH" do LLM É um dos fatos conferidos por aquele gate — nunca
// uma autorização por si só. Esta função continua responsável pelos
// curto-circuitos que nem chegam a ser candidatos a auto-apply (múltiplas
// actions, tipo sempre-confirma, duplicata, transferência) — motivos que a
// mensagem de confirmação usa pra explicar o "porquê".
// ============================================================================
import { isSafeForAutoApply } from "./executionSafety.js";

// Tipos que NUNCA autoconfirmam, sempre exigem "sim" explícito — mesmo com
// alta confiança, conta explícita, valor simples (item 5: "reconciliação",
// "snapshot de saldo", "snapshot de fatura", "transferência ambígua",
// "compromisso", "contingência", "delete/undo", "correção relevante").
const ALWAYS_CONFIRM_TYPES = new Set([
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
  "CORRECT_PREVIOUS_ACTION",
  "DELETE_OR_UNDO_PREVIOUS_ACTION",
]);

// Tipos que PODEM autoconfirmar se as outras condições baterem.
const AUTO_CONFIRMABLE_TYPES = new Set(["RECORD_EXPENSE", "RECORD_INCOME", "RECORD_CARD_PURCHASE", "RECORD_TRANSFER"]);

export function evaluateConfirmationPolicy(plan, { resolutions = [], duplicateFlags = [] } = {}) {
  const actions = plan.actions;

  // Múltiplas actions -> sempre confirma o lote inteiro (item 5: "múltiplas actions").
  if (actions.length > 1) {
    return { autoConfirm: false, reason: "multiplas_actions" };
  }

  const action = actions[0];
  const resolution = resolutions[0] || {};
  const hasDuplicate = Boolean(duplicateFlags[0]?.length);

  if (hasDuplicate) return { autoConfirm: false, reason: "possivel_duplicata" };
  if (action.confidence !== "HIGH") return { autoConfirm: false, reason: "baixa_confianca" };
  if (ALWAYS_CONFIRM_TYPES.has(action.type)) return { autoConfirm: false, reason: `tipo_sempre_confirma:${action.type}` };

  if (!AUTO_CONFIRMABLE_TYPES.has(action.type)) {
    // QUERY_FINANCIAL_STATE/SIMULATE_PURCHASE nunca escrevem, então "confirmação"
    // não se aplica a elas — tratadas à parte pelo pipeline (sempre executam
    // direto, são leitura pura). CLARIFICATION_REQUIRED/NO_FINANCIAL_INTENT
    // também não passam por aqui (o pipeline intercepta antes).
    return { autoConfirm: true, reason: "read_only_ou_sentinela" };
  }

  // Candidato a auto-apply: a decisão final é SEMPRE do gate determinístico,
  // nunca desta função diretamente (item 4 — "apenas esse gate pode permitir
  // auto-apply"). Se algum fato verificável falhar (mesmo com confidence:HIGH
  // do LLM), nunca autoconfirma — inclusive pra RECORD_TRANSFER, cuja
  // ambiguidade de ponta o gate confere via resolution.transferBothSidesResolved.
  const gate = isSafeForAutoApply({ plan, action, resolution, duplicates: duplicateFlags[0] });
  if (!gate.safe) {
    if (action.type === "RECORD_TRANSFER" && gate.failedChecks.includes("paymentEntityResolvedUnambiguously")) {
      return { autoConfirm: false, reason: "transferencia_ambigua" };
    }
    // Preserva os motivos já testados (conta/meio não explícito é o caso mais
    // comum de chegar aqui) — os demais ficam explícitos na lista de checks
    // reprovados, pra quem for depurar/logar.
    if (gate.failedChecks.includes("paymentEntityResolvedUnambiguously")) {
      return { autoConfirm: false, reason: "conta_meio_nao_explicito" };
    }
    return { autoConfirm: false, reason: `gate_reprovado:${gate.failedChecks.join(",")}` };
  }

  return { autoConfirm: true, reason: action.type === "RECORD_TRANSFER" ? "transferencia_inequivoca" : "operacao_simples_alta_confianca" };
}
