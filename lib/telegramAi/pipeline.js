// ============================================================================
// Fase 7.0 — orquestrador do pipeline conversacional. É a ÚNICA função que
// lib/telegramUpdateHandler.js chama pra este pipeline (mesmo padrão de
// isolamento que lib/processTelegramMessage.js já tem pro parser antigo).
//
// Arquitetura (item "OBJETIVO DA ARQUITETURA" do pedido):
//   texto -> interpretação semântica (LLM) -> plano estruturado (Zod) ->
//   validação determinística (planValidator) -> dedupe -> política de
//   confirmação -> execução pelos serviços existentes (planExecutor) ->
//   resposta humana -> pending/undo via PendingBotMessage.
//
// O LLM NUNCA escreve — só preenche o plano. Tudo que grava passa por
// planExecutor.js, que só chama serviços financeiros JÁ EXISTENTES.
// ============================================================================
import { prisma } from "../prisma.js";
import { formatMoney } from "../formatMoney.js";
import { CATEGORIES } from "../categoryRules.js";
import { buildProductFinancialSnapshot } from "../productFinancialSnapshot.js";
import { handleReadIntent } from "../telegramReads.js";
import { interpretFinancialMessage, INTERPRETER_RESULT_KIND } from "./semanticInterpreter.js";
import { validatePlan } from "./planValidator.js";
import { evaluateConfirmationPolicy } from "./confirmationPolicy.js";
import { executePlan } from "./planExecutor.js";
import { buildConversationContext, savePendingPlan, savePendingCorrection, clearPendingPlan } from "./conversationContext.js";
import { previewBalanceReconciliation } from "../balanceReconciliation.js";
import { previewCardBillReconciliation } from "../cardBillReconciliation.js";
import { computeCategoryBreakdown } from "../categoryBreakdown.js";
import {
  formatBatchConfirmation,
  formatSingleActionConfirmation,
  formatExecutionSummary,
  formatClarificationQuestion,
  formatDuplicateWarning,
  formatReconciliationConfirmation,
  formatCategoryBreakdownReply,
  formatCorrectionPreview,
  formatDeletePreview,
  formatUndoPreview,
  STALE_CORRECTION_MESSAGE,
  PROVIDER_UNAVAILABLE_MESSAGE,
} from "./responseFormatter.js";
import { logPipelineEvent, shortHash } from "./observability.js";
import {
  SUPPORTED_CORRECTION_MODELS,
  resolveAppliedRecordTarget,
  describeFieldChanges,
  applyGuardedCorrection,
  applyGuardedDelete,
  findUndoableAudit,
  undoAudit,
  StaleRecordError,
  RecordNotFoundError,
} from "./correctionService.js";

const YES_RE = /^(s|sim|yes|confirmo|isso|correto|ok|manda|pode)\b/i;
const NO_RE = /^(n|nao|não|no|errado|cancela)\b/i;

const QUERY_TOPIC_TO_READ_INTENT = {
  free_money: "read_free_money",
  card_bill: "read_card",
  va_balance: "read_va",
  installment_relief: "read_external_installments",
  commitment_load: "read_next_income",
  general_snapshot: "read_summary",
};

export const PIPELINE_RESULT_KIND = Object.freeze({
  NO_PROVIDER: "no_provider", // provider não configurado -> caller deve usar o parser antigo (zero regressão).
  REPLY: "reply",
  SILENT: "silent", // NO_FINANCIAL_INTENT -> zero resposta financeira.
});

function todayIso(now) {
  return now.toISOString().slice(0, 10);
}

async function buildFinancialContextSummary({ client }) {
  try {
    const snap = await buildProductFinancialSnapshot({ client });
    return `status=${snap.liquidity.status}, dinheiro livre=${snap.liquidity.freeMoney}`;
  } catch {
    return null;
  }
}

// Reconciliação (SET_*_SNAPSHOT) precisa mostrar o delta ANTES de confirmar
// — nunca escreve na primeira mensagem (item 7/8: sempre pergunta antes).
async function buildReconciliationPreviewReply(action, resolved, { client }) {
  if (action.type === "SET_ACCOUNT_BALANCE_SNAPSHOT" || action.type === "SET_VA_BALANCE_SNAPSHOT") {
    const preview = await previewBalanceReconciliation(resolved.account.id, action.observedBalance, { client });
    if (!preview.isDifferent) return { reply: `Seu saldo em ${resolved.account.name} já bate certinho com o que eu calculo. Nada pra reconciliar.`, skip: true };
    return { reply: formatReconciliationConfirmation({ label: `Saldo de ${resolved.account.name}`, calculated: preview.calculated, observed: preview.observed, delta: preview.delta }) };
  }
  if (action.type === "SET_CARD_BILL_SNAPSHOT") {
    const preview = await previewCardBillReconciliation(resolved.card.id, action.observedTotal, { date: new Date(`${action.date}T12:00:00.000Z`), client });
    if (!preview.isDifferent) return { reply: `A fatura de ${resolved.card.name} já bate certinho com o que eu calculo. Nada pra reconciliar.`, skip: true };
    return { reply: formatReconciliationConfirmation({ label: `Fatura de ${resolved.card.name}`, calculated: preview.calculated, observed: preview.observed, delta: preview.delta }) };
  }
  return null;
}

export async function handleConversationalMessage(text, chatId, { client = prisma, now = new Date(), provider, rawMessage } = {}) {
  const chatHash = shortHash(String(chatId));
  const conversationContext = await buildConversationContext(chatId, { client });
  logPipelineEvent("message_received", { chatHash, textLength: text?.length ?? 0, hasPending: conversationContext.hasPending });

  // Atalho barato pra "sim"/"não" quando há um plano pendente EXECUTÁVEL —
  // evita depender do LLM pra algo que já tem resposta determinística (mesmo
  // padrão de custo/confiabilidade do resolveYesNo do parser antigo). Uma
  // pendência do tipo CLARIFICATION_REQUIRED NÃO é executável (não tem
  // action real, só uma pergunta) — "sim" ali é a RESPOSTA à pergunta, não
  // uma confirmação de plano, então precisa voltar pro LLM com o contexto
  // completo (ver conversationContext.pendingAction abaixo) pra montar o
  // plano de verdade, nunca cair aqui.
  const pendingIsExecutable = conversationContext.hasPending && conversationContext.pendingAction?.type !== "CLARIFICATION_REQUIRED";
  if (pendingIsExecutable && (YES_RE.test(text.trim()) || NO_RE.test(text.trim()))) {
    logPipelineEvent("pending_confirmation_shortcut", { chatHash, answer: YES_RE.test(text.trim()) ? "yes" : "no" });
    return handlePendingConfirmationShortcut(text, chatId, conversationContext, { client, now, rawMessage });
  }

  const [accounts, cards] = await Promise.all([client.account.findMany(), client.card.findMany()]);
  const financialContext = await buildFinancialContextSummary({ client });

  const interpretation = await interpretFinancialMessage({
    text,
    now: todayIso(now),
    accounts,
    cards,
    categories: CATEGORIES,
    conversationContext,
    financialContext,
    provider,
  });

  if (interpretation.kind === INTERPRETER_RESULT_KIND.PROVIDER_UNAVAILABLE) {
    logPipelineEvent("provider_unavailable", { chatHash });
    return { kind: PIPELINE_RESULT_KIND.NO_PROVIDER };
  }
  if (interpretation.kind !== INTERPRETER_RESULT_KIND.OK) {
    // Provider configurado mas ESTA chamada falhou (timeout/erro/JSON
    // inválido) — item 21: zero write, nunca cai pro parser antigo (evitaria
    // reinterpretar com uma lógica diferente e potencialmente incompatível).
    // `detail` aqui é sempre uma mensagem de validação/erro genérica (nunca o
    // prompt ou o valor de um campo do usuário) — seguro pra logar.
    logPipelineEvent("interpretation_failed", { chatHash, kind: interpretation.kind, latencyMs: interpretation.latencyMs ?? null, detail: interpretation.detail ?? null });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: PROVIDER_UNAVAILABLE_MESSAGE };
  }

  logPipelineEvent("interpretation_ok", { chatHash, latencyMs: interpretation.latencyMs ?? null, actionCount: interpretation.plan.actions.length, actionTypes: interpretation.plan.actions.map((a) => a.type), confidences: interpretation.plan.actions.map((a) => a.confidence) });

  return handlePlan(interpretation.plan, chatId, { client, now, rawMessage, text, chatHash });
}

async function handlePlan(plan, chatId, { client, now, rawMessage, text, chatHash = shortHash(String(chatId)) }) {
  const singleAction = plan.actions.length === 1 ? plan.actions[0] : null;

  if (singleAction?.type === "NO_FINANCIAL_INTENT") {
    logPipelineEvent("no_financial_intent", { chatHash });
    return { kind: PIPELINE_RESULT_KIND.SILENT };
  }

  if (singleAction?.type === "CLARIFICATION_REQUIRED") {
    logPipelineEvent("clarification_requested", { chatHash });
    await savePendingPlan(chatId, { plan, rawMessage, promptMessage: singleAction.question, confirmationReason: "clarification" }, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: formatClarificationQuestion(singleAction) };
  }

  if (singleAction?.type === "QUERY_FINANCIAL_STATE") {
    if (singleAction.topic === "category_breakdown") {
      // Fase 7.0.1, item 2 — cálculo 100% determinístico (lib/categoryBreakdown.js),
      // o LLM só identificou o tópico + (opcionalmente) o período. ZERO WRITE.
      const result = await computeCategoryBreakdown(singleAction.period, { now, client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: formatCategoryBreakdownReply(result) };
    }
    const readIntent = QUERY_TOPIC_TO_READ_INTENT[singleAction.topic];
    if (!readIntent) {
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Ainda não sei responder isso pelo chat com segurança — dá uma olhada no dashboard por enquanto." };
    }
    const reply = await handleReadIntent(readIntent);
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply };
  }

  if (singleAction?.type === "SIMULATE_PURCHASE") {
    // Reaproveita o motor de simulação real (zero persistência) E o
    // formatador real (lib/telegramSimulation.js:formatVerdict) — nunca o
    // LLM calculando ou narrando esses números sozinho.
    const { simulateFinancialScenario } = await import("../simulation/financialSimulator.js");
    const { formatVerdict } = await import("../telegramSimulation.js");
    const scenario =
      singleAction.installments && singleAction.installments > 1
        ? { type: "CARD_PURCHASE_INSTALLMENTS", amount: Number(singleAction.amount), installments: singleAction.installments }
        : singleAction.paymentMethod === "cartao_credito"
          ? { type: "CARD_PURCHASE_SINGLE", amount: Number(singleAction.amount) }
          : { type: "CASH_EXPENSE_NOW", amount: Number(singleAction.amount) };
    try {
      const result = await simulateFinancialScenario({ scenario });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: formatVerdict(result) };
    } catch (err) {
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `Não consegui simular isso agora (${err.message}).` };
    }
  }

  if (singleAction?.type === "CORRECT_PREVIOUS_ACTION" || singleAction?.type === "DELETE_OR_UNDO_PREVIOUS_ACTION") {
    return handleCorrectionOrUndo(singleAction, chatId, { client, rawMessage });
  }

  // ---- Actions financeiras de verdade: validar -> dedupe -> política -> executar/perguntar ----
  const validation = await validatePlan(plan, { client });
  if (!validation.ok) {
    logPipelineEvent("plan_validation_failed", { chatHash, blockingCount: validation.blocking.length });
    const reasons = validation.blocking.map((b) => b.reason).join(" ");
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `Não consegui confirmar tudo com segurança: ${reasons} Não registrei nada.` };
  }

  // Reconciliação sempre mostra o preview/delta antes de confirmar, mesmo
  // que a policy já force confirmação — o valor do delta É o conteúdo da
  // pergunta (item 7/8).
  if (singleAction && (singleAction.type === "SET_ACCOUNT_BALANCE_SNAPSHOT" || singleAction.type === "SET_VA_BALANCE_SNAPSHOT" || singleAction.type === "SET_CARD_BILL_SNAPSHOT")) {
    const preview = await buildReconciliationPreviewReply(singleAction, validation.perAction[0].resolved, { client });
    if (preview?.skip) return { kind: PIPELINE_RESULT_KIND.REPLY, reply: preview.reply };
    await savePendingPlan(chatId, { plan, rawMessage, promptMessage: preview.reply, confirmationReason: "reconciliation" }, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: preview.reply };
  }

  const duplicateFlags = validation.perAction.map((p) => p.duplicates || []);
  const resolutions = validation.perAction.map((p) => p.resolved);
  const totalDuplicates = duplicateFlags.reduce((sum, d) => sum + d.length, 0);
  logPipelineEvent("dedupe_checked", { chatHash, totalDuplicates });

  const decision = evaluateConfirmationPolicy(plan, { resolutions, duplicateFlags });
  logPipelineEvent("confirmation_decision", { chatHash, autoConfirm: decision.autoConfirm, reason: decision.reason });

  if (!decision.autoConfirm) {
    if (decision.reason === "possivel_duplicata") {
      const reply = formatDuplicateWarning(singleAction, duplicateFlags[0]);
      await savePendingPlan(chatId, { plan, rawMessage, promptMessage: reply, confirmationReason: decision.reason }, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply };
    }
    const reply = plan.actions.length > 1 ? formatBatchConfirmation(plan) : formatSingleActionConfirmation(singleAction);
    await savePendingPlan(chatId, { plan, rawMessage, promptMessage: reply, confirmationReason: decision.reason }, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply };
  }

  const results = await executePlan(validation.perAction, { client, rawMessage });
  logPipelineEvent("plan_executed", { chatHash, resultCount: results.length, actionTypes: results.map((r) => r.type) });
  await clearPendingPlan(chatId, { client });
  return { kind: PIPELINE_RESULT_KIND.REPLY, reply: formatExecutionSummary(results) };
}

async function handlePendingConfirmationShortcut(text, chatId, conversationContext, { client, rawMessage }) {
  const chatHash = shortHash(String(chatId));
  const pendingRow = await client.pendingBotMessage.findUnique({ where: { chatId } });

  // Fase 7.0.1, item 3 — um pending pode ser uma correção/exclusão/desfazer
  // de um registro JÁ APLICADO (savePendingCorrection), formato totalmente
  // diferente de um plano — despacha ANTES de assumir `.plan`.
  if (pendingRow?.parsedPayload?.correction) {
    return handlePendingCorrectionShortcut(pendingRow, text, chatId, { client, rawMessage, chatHash });
  }

  const plan = pendingRow?.parsedPayload?.plan;
  if (!plan) return { kind: PIPELINE_RESULT_KIND.REPLY, reply: PROVIDER_UNAVAILABLE_MESSAGE };

  if (NO_RE.test(text.trim())) {
    logPipelineEvent("pending_plan_cancelled", { chatHash });
    await clearPendingPlan(chatId, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Beleza, não registrei nada." };
  }

  const validation = await validatePlan(plan, { client });
  if (!validation.ok) {
    logPipelineEvent("pending_plan_stale", { chatHash, blockingCount: validation.blocking.length });
    await clearPendingPlan(chatId, { client });
    const reasons = validation.blocking.map((b) => b.reason).join(" ");
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `Isso mudou desde que perguntei: ${reasons} Não registrei nada, manda de novo.` };
  }

  // O registro precisa guardar a mensagem ORIGINAL que gerou o plano (ex.: a
  // compra de verdade), nunca o "sim" que só confirmou — senão o rawMessage
  // persistido em Expense/Transfer/etc. perde toda a rastreabilidade (item
  // 19) e a dedupe por mensagem de origem (item 11) fica sem sentido.
  const originalRawMessage = pendingRow.rawMessage ?? rawMessage;

  const singleAction = plan.actions.length === 1 ? plan.actions[0] : null;
  if (singleAction && (singleAction.type === "SET_ACCOUNT_BALANCE_SNAPSHOT" || singleAction.type === "SET_VA_BALANCE_SNAPSHOT")) {
    const { applyBalanceReconciliation } = await import("../balanceReconciliation.js");
    const { record } = await applyBalanceReconciliation(validation.perAction[0].resolved.account.id, singleAction.observedBalance, { rawMessage: originalRawMessage, client });
    await clearPendingPlan(chatId, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `✅ Reconciliado. Novo saldo: ${singleAction.observedBalance}.`, record };
  }
  if (singleAction?.type === "SET_CARD_BILL_SNAPSHOT") {
    const { applyCardBillReconciliation } = await import("../cardBillReconciliation.js");
    const { record } = await applyCardBillReconciliation(validation.perAction[0].resolved.card.id, singleAction.observedTotal, { date: new Date(`${singleAction.date}T12:00:00.000Z`), rawMessage: originalRawMessage, client });
    await clearPendingPlan(chatId, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `✅ Fatura reconciliada.`, record };
  }

  const results = await executePlan(validation.perAction, { client, rawMessage: originalRawMessage });
  logPipelineEvent("plan_executed", { chatHash, resultCount: results.length, actionTypes: results.map((r) => r.type), viaConfirmationShortcut: true });
  await clearPendingPlan(chatId, { client });
  return { kind: PIPELINE_RESULT_KIND.REPLY, reply: formatExecutionSummary(results) };
}

function describeRecordShort(model, record) {
  const date = record.occurredAt.toISOString().slice(0, 10);
  return `${record.description} · ${formatMoney(Number(record.amount))} · ${date}`;
}

async function handleCorrectionOrUndo(action, chatId, { client, rawMessage }) {
  const pendingRow = await client.pendingBotMessage.findUnique({ where: { chatId } });
  const pendingPlan = pendingRow?.parsedPayload?.plan;

  // Alvo é a action PENDENTE (ainda não aplicada) — corrige em memória e
  // pergunta de novo, nunca toca o banco.
  if (action.target.kind === "pending_action" && pendingPlan) {
    const targetIdx = pendingPlan.actions.findIndex((a) => a.localId === action.target.localId) ?? 0;
    const idx = targetIdx >= 0 ? targetIdx : 0;
    if (action.type === "DELETE_OR_UNDO_PREVIOUS_ACTION") {
      await clearPendingPlan(chatId, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Beleza, cancelei." };
    }
    const updatedActions = [...pendingPlan.actions];
    updatedActions[idx] = { ...updatedActions[idx], ...action.fieldChanges };
    const updatedPlan = { ...pendingPlan, actions: updatedActions };
    await savePendingPlan(chatId, { plan: updatedPlan, rawMessage, promptMessage: "corrigido", confirmationReason: "correction" }, { client });
    const reply = updatedActions.length > 1 ? formatBatchConfirmation(updatedPlan) : formatSingleActionConfirmation(updatedActions[0]);
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply };
  }

  // Fase 7.0.1, item 3 — alvo é um registro JÁ APLICADO. Nunca mais um
  // update/delete bruto direto: sempre PREVIEW + CONFIRMAÇÃO explícita, com
  // o registro real re-lido do banco (nunca confia em dado velho do plano) e
  // um `expectedUpdatedAt` capturado AGORA pro guard de estado obsoleto
  // conferir na hora de aplicar (correctionService.js). Escopo continua só
  // expense/income/transfer — qualquer outro model é fail-closed.
  if (action.target.kind === "applied_record" && action.target.model && action.target.id) {
    if (!SUPPORTED_CORRECTION_MODELS.includes(action.target.model)) {
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: `Ainda não sei desfazer/corrigir um ${action.target.model} pelo chat — isso precisa ser feito no dashboard por enquanto.` };
    }

    if (action.type === "CORRECT_PREVIOUS_ACTION") {
      const resolved = await resolveAppliedRecordTarget(action.target.model, action.target.id, { client });
      if (!resolved.ok) return { kind: PIPELINE_RESULT_KIND.REPLY, reply: resolved.reason };
      const diffLines = describeFieldChanges(resolved.record, action.fieldChanges || {});
      if (diffLines.length === 0) return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Não entendi o que corrigir." };
      const correction = { kind: "correct", model: action.target.model, recordId: action.target.id, fieldChanges: action.fieldChanges, expectedUpdatedAt: resolved.expectedUpdatedAt };
      const preview = formatCorrectionPreview({ label: describeRecordShort(action.target.model, resolved.record), changes: diffLines });
      await savePendingCorrection(chatId, { correction, rawMessage, promptMessage: preview }, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: preview };
    }

    // DELETE_OR_UNDO_PREVIOUS_ACTION — decide "desfazer a última operação
    // auditada" vs "apagar o registro inteiro" checando a trilha de
    // auditoria PRIMEIRO (funciona mesmo se o registro já foi apagado: a
    // trilha continua existindo mesmo depois — é o caso "delete + undo").
    const undoable = await findUndoableAudit({ model: action.target.model, recordId: action.target.id, chatId }, { client });
    if (undoable) {
      const label = undoable.action === "delete" ? `a exclusão de "${undoable.preimage.description}" (${formatMoney(Number(undoable.preimage.amount))})` : `a última correção em "${undoable.preimage.description}"`;
      const correction = { kind: "undo", model: action.target.model, recordId: action.target.id, auditIdToUndo: undoable.id };
      const preview = formatUndoPreview({ label });
      await savePendingCorrection(chatId, { correction, rawMessage, promptMessage: preview }, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: preview };
    }

    const resolved = await resolveAppliedRecordTarget(action.target.model, action.target.id, { client });
    if (!resolved.ok) return { kind: PIPELINE_RESULT_KIND.REPLY, reply: resolved.reason };
    const correction = { kind: "delete", model: action.target.model, recordId: action.target.id, expectedUpdatedAt: resolved.expectedUpdatedAt };
    const preview = formatDeletePreview({ label: describeRecordShort(action.target.model, resolved.record) });
    await savePendingCorrection(chatId, { correction, rawMessage, promptMessage: preview }, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: preview };
  }

  return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Não achei a qual lançamento isso se refere. Pode ser mais específico?" };
}

// Fase 7.0.1, item 3 — confirma (ou cancela) uma correção/exclusão/desfazer
// de registro já aplicado. Sempre re-verifica o estado atual no banco antes
// de escrever (staleness guard) — nunca confia cegamente no que foi
// calculado no momento do preview.
async function handlePendingCorrectionShortcut(pendingRow, text, chatId, { client, rawMessage, chatHash }) {
  const correction = pendingRow.parsedPayload.correction;
  const originalRawMessage = pendingRow.rawMessage ?? rawMessage;

  if (NO_RE.test(text.trim())) {
    logPipelineEvent("pending_correction_cancelled", { chatHash });
    await clearPendingPlan(chatId, { client });
    return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Beleza, não mexi em nada." };
  }

  try {
    if (correction.kind === "correct") {
      await applyGuardedCorrection({ model: correction.model, id: correction.recordId, fieldChanges: correction.fieldChanges, expectedUpdatedAt: correction.expectedUpdatedAt, chatId, rawMessage: originalRawMessage }, { client });
      logPipelineEvent("correction_applied", { chatHash, model: correction.model });
      await clearPendingPlan(chatId, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "✅ Corrigido." };
    }

    if (correction.kind === "delete") {
      await applyGuardedDelete({ model: correction.model, id: correction.recordId, expectedUpdatedAt: correction.expectedUpdatedAt, chatId, rawMessage: originalRawMessage }, { client });
      logPipelineEvent("delete_applied", { chatHash, model: correction.model });
      await clearPendingPlan(chatId, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "✅ Apagado. Se precisar, é só pedir pra desfazer." };
    }

    if (correction.kind === "undo") {
      // Re-verifica que o audit que a gente viu no preview AINDA é o mais
      // recente/desfazível — se outra coisa mexeu nesse registro nesse meio
      // tempo (outra correção, outro undo), trata como obsoleto e não desfaz.
      const stillUndoable = await findUndoableAudit({ model: correction.model, recordId: correction.recordId, chatId }, { client });
      if (!stillUndoable || stillUndoable.id !== correction.auditIdToUndo) {
        await clearPendingPlan(chatId, { client });
        logPipelineEvent("undo_stale", { chatHash });
        return { kind: PIPELINE_RESULT_KIND.REPLY, reply: STALE_CORRECTION_MESSAGE };
      }
      await undoAudit(correction.auditIdToUndo, { chatId, rawMessage: originalRawMessage }, { client });
      logPipelineEvent("undo_applied", { chatHash, model: correction.model });
      await clearPendingPlan(chatId, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "✅ Desfeito." };
    }
  } catch (err) {
    if (err instanceof StaleRecordError || err instanceof RecordNotFoundError) {
      logPipelineEvent("correction_stale", { chatHash, errorName: err.name });
      await clearPendingPlan(chatId, { client });
      return { kind: PIPELINE_RESULT_KIND.REPLY, reply: STALE_CORRECTION_MESSAGE };
    }
    throw err;
  }

  await clearPendingPlan(chatId, { client });
  return { kind: PIPELINE_RESULT_KIND.REPLY, reply: "Não entendi essa confirmação — não mexi em nada." };
}
