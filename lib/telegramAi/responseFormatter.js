// ============================================================================
// Fase 7.0 — respostas humanas (item 14): curtas, sem enum, sem jargão
// técnico, sem repetir a frase inteira do usuário.
// ============================================================================
import { formatMoney as formatMoneyRaw } from "../formatMoney.js";

// formatMoney() de verdade espera number (usa .toLocaleString internamente)
// — os valores aqui podem chegar como string decimal (campos do plano,
// vindos do schema Zod) ou Decimal do Prisma (resultado de reconciliação);
// Number(...) normaliza os dois casos antes de formatar. Nunca faz conta
// com o valor numérico além disso — só formatação de exibição.
function fmtMoney(value) {
  return formatMoneyRaw(Number(value));
}

function fmtDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}

function actionSummaryLine(action) {
  switch (action.type) {
    case "RECORD_EXPENSE":
    case "RECORD_CARD_PURCHASE": {
      const who = action.merchant || action.payee || action.description || "Gasto";
      const via = action.card || action.account || "";
      return `• ${who} · ${fmtMoney(action.amount)}${via ? ` · ${via}` : ""}`;
    }
    case "RECORD_INCOME": {
      const who = action.payer || action.description || "Receita";
      return `• ${who} · +${fmtMoney(action.amount)}`;
    }
    case "RECORD_TRANSFER":
      return `• ${action.description || "Transferência"} · ${fmtMoney(action.amount)}${action.toAccount ? ` → ${action.toAccount}` : ""}`;
    case "RECORD_INSTALLMENT_PURCHASE":
      return `• ${action.merchant || action.description} · ${fmtMoney(action.totalAmount)} em ${action.installments}x de ${fmtMoney(action.installmentAmount)}${action.card ? ` · ${action.card}` : ""}`;
    case "RECORD_CARD_PAYMENT":
      return `• Pagamento fatura ${action.card} · ${fmtMoney(action.amount)}`;
    default:
      return `• ${action.description || action.type}`;
  }
}

// Agrupa por data (item 4: exemplo de resposta de batch agrupada por dia).
export function formatBatchConfirmation(plan) {
  const byDate = new Map();
  for (const action of plan.actions) {
    const date = action.date || "";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(action);
  }
  const dates = [...byDate.keys()].sort();
  const blocks = dates.map((date) => {
    const lines = byDate.get(date).map(actionSummaryLine).join("\n");
    return date ? `${fmtDate(date)}\n${lines}` : lines;
  });
  const count = plan.actions.length;
  return `Encontrei ${count} lançamento${count > 1 ? "s" : ""}:\n\n${blocks.join("\n\n")}\n\nRegistrar${count > 1 ? " os " + count : ""}?`;
}

export function formatSingleActionConfirmation(action) {
  return `${actionSummaryLine(action).replace(/^•\s*/, "")}\n\nConfirmar?`;
}

export function formatAutoConfirmedReply(executionResult) {
  return executionResult.reply || "✅ Registrado.";
}

export function formatExecutionSummary(results) {
  if (results.length === 1) return results[0].reply || "✅ Registrado.";
  const lines = results.map((r) => r.reply || `✅ ${r.type}`);
  return `Prontinho, registrei os ${results.length}:\n\n${lines.join("\n")}`;
}

export function formatClarificationQuestion(action) {
  return action.question;
}

export function formatDuplicateWarning(action, duplicates) {
  const d = duplicates[0];
  const label = d.record.description || "";
  const dateStr = d.record.occurredAt ? fmtDate(d.record.occurredAt.toISOString().slice(0, 10)) : d.record.purchasedAt ? fmtDate(d.record.purchasedAt.toISOString().slice(0, 10)) : "";
  return `Já encontrei algo parecido:\n${dateStr} · ${label} · ${fmtMoney(d.record.amount ?? d.record.totalAmount)}.\nÉ a mesma coisa? Se não for, me diga e eu registro assim mesmo.`;
}

export function formatReconciliationConfirmation({ label, calculated, observed, delta }) {
  const sign = Number(delta) >= 0 ? "+" : "";
  return `${label} observado: ${fmtMoney(observed)}.\nPelos detalhes conhecidos eu calculo ${fmtMoney(calculated)}.\nDiferença: ${sign}${fmtMoney(delta)}.\n\nQuer reconciliar?`;
}

// Fase 7.0.1, item 1 — texto LITERAL exigido: com TELEGRAM_AI_ENABLED=true, o
// pipeline é sempre chamado e NUNCA cai pro parser legado — então esta é a
// única mensagem que qualquer falha (sem chave, timeout, erro HTTP, resposta
// malformada, schema inválido) pode mostrar. Nunca variações/dicas extras
// aqui: o texto em si já foi pedido palavra por palavra.
export const PROVIDER_UNAVAILABLE_MESSAGE = "Não consegui interpretar isso com segurança agora. Não registrei nada.";

export const NO_FINANCIAL_INTENT_SILENT = null; // item J: mensagem não-financeira -> sem resposta financeira nenhuma (silêncio, não "não entendi").

// Fase 7.0.1, item 2 — "onde gastei mais esse mês?".
export function formatCategoryBreakdownReply(result) {
  if (result.categories.length === 0) return `Não achei nenhum gasto em ${result.label}.`;
  const top = result.categories.slice(0, 8);
  const lines = top.map((c) => `• ${c.category}: ${fmtMoney(c.total)}`);
  return `Gastos por categoria (${result.label}):\n${lines.join("\n")}\n\nTotal: ${fmtMoney(result.grandTotal)}`;
}

// Fase 7.0.1, item 3 — preview de correção de um registro JÁ APLICADO, antes
// de confirmar (nunca aplica direto — ver correctionService.js). `changes` é
// a lista de diffs campo-a-campo (describeFieldChanges).
export function formatCorrectionPreview({ label, changes }) {
  return `Vou mudar ${label}:\n${changes.map((c) => `• ${c}`).join("\n")}\n\nConfirma?`;
}

export function formatDeletePreview({ label }) {
  return `Vou apagar ${label}.\n\nConfirma?`;
}

export function formatUndoPreview({ label }) {
  return `Vou desfazer: ${label}.\n\nConfirma?`;
}

export const STALE_CORRECTION_MESSAGE = "Isso mudou desde que eu perguntei — não mexi em nada. Confere de novo e manda a correção outra vez.";
