import { buildProductFinancialSnapshot } from "./productFinancialSnapshot.js";
import { listCardsWithLimits } from "./cards.js";
import { getCardBillView } from "./cardBillCalculator.js";
import { getCardCycleForDate } from "./cardCycle.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { serializeMoney } from "./money.js";

// ============================================================================
// Fase 5.3D, item 0 — PRINCÍPIO CENTRAL: Telegram READ nunca reimplementa
// fórmula nenhuma. Todo número aqui vem de lib/productFinancialSnapshot.js
// (o MESMO read model que app/api/dashboard/route.js usa pro WEB) ou de
// outro helper canônico já usado pelo WEB (lib/cards.js/cardBillCalculator.js
// pro Card, exatamente como app/api/dashboard/route.js já faz). Este arquivo
// só FORMATA texto — READ CANONICAL PRODUCT MODEL -> FORMAT TEXT, nunca o
// contrário.
// ============================================================================

export const READ_INTENTS = new Set([
  "read_summary",
  "read_balance",
  "read_free_money",
  "read_next_income",
  "read_external_installments",
  "read_va",
  "read_card",
]);

const CLASS_LABEL = {
  INCURRED_LIABILITY: "dívida já incorrida",
  CURRENT_HORIZON_OBLIGATION: "até a próxima renda",
};

function fmt(decimalValue) {
  return formatMoney(serializeMoney(decimalValue));
}

// handleReadIntent(intent) -> texto de resposta (string), pronto pro Telegram.
// Nunca lança por conta de dado ausente — degrada pra uma frase honesta
// ("não sei") em vez de quebrar a resposta inteira.
// `now` opcional (default: relógio real, comportamento idêntico ao anterior) —
// existe só pra testes determinísticos com data controlada (Fase 7D.1).
// `client` opcional (Fase 9.1.1) — leitura dentro de uma transação de teste isolada; default = singleton.
export async function handleReadIntent(intent, { now = new Date(), client } = {}) {
  const snapshot = await buildProductFinancialSnapshot({ now, client });
  switch (intent) {
    case "read_summary":
      return formatSummary(snapshot);
    case "read_balance":
      return formatBalance(snapshot);
    case "read_free_money":
      return formatFreeMoney(snapshot);
    case "read_next_income":
      return formatNextIncome(snapshot);
    case "read_external_installments":
      return formatExternalInstallments(snapshot);
    case "read_va":
      return formatVa(snapshot);
    case "read_card":
      return formatCard(snapshot, now);
    default:
      return "Não entendi a pergunta.";
  }
}

// Fase 9.1.1 — contas variáveis ainda SEM valor: o cálculo não as inclui (nunca viram zero) e a resposta diz isso.
function unpricedNote(s) {
  const list = s.houseBills?.unpricedPendingBills ?? [];
  if (list.length === 0) return null;
  return `Obs.: calculado sem ${list.length === 1 ? "1 conta" : `${list.length} contas`} ainda sem valor (${list.map((b) => b.name).join(", ")}).`;
}

// Item 5 — resposta compacta, números principais primeiro (item 13: Telegram
// não é dashboard).
function formatSummary(s) {
  const { liquidity, nextIncome, nextIncomeCommitment } = s;
  const statusLabel = { TRANQUILO: "Tranquilo", ATENCAO: "Atenção", APERTADO: "Apertado", CRITICO: "Crítico" }[liquidity.status] || liquidity.status;
  const lines = [
    `Situação: ${statusLabel}`,
    `Caixa irrestrito: ${fmt(liquidity.unrestrictedCash)}`,
    `Livre: ${fmt(liquidity.freeMoney)}`,
    `Seguro pra gastar: ${fmt(liquidity.safeToSpend)}`,
  ];
  if (nextIncome.expectedDate) {
    lines.push(`Próxima renda: ${formatDate(nextIncome.expectedDate)} (base ${fmt(nextIncome.baseAmount)})`);
  }
  if (nextIncomeCommitment.baseCommittedPercent != null) {
    lines.push(`Já comprometido da base: ${fmt(nextIncomeCommitment.committedAmount)} (≈${nextIncomeCommitment.baseCommittedPercent.toFixed(1)}%)`);
  }
  if (unpricedNote(s)) lines.push(unpricedNote(s));
  return lines.join("\n");
}

// Item 6 — NUNCA soma unrestricted + VA e chama de "disponível". Sempre
// rotulado separadamente.
function formatBalance(s) {
  const lines = [`Caixa livre de restrição (Pix/Itaú + dinheiro): ${fmt(s.liquidity.unrestrictedCash)}`];
  if (s.restricted) {
    lines.push(`VA (uso restrito, separado — não soma no acima): ${fmt(s.restricted.vaBalance)}`);
  }
  return lines.join("\n");
}

// Item 7 — freeMoney e safeToSpend separados, com o breakdown canônico
// (nunca hardcoding de nome de item — vem de currentObligations.breakdown).
function formatFreeMoney(s) {
  const lines = [
    `Dinheiro livre: ${fmt(s.liquidity.freeMoney)}`,
    `Seguro pra gastar: ${fmt(s.liquidity.safeToSpend)}`,
  ];
  if (s.currentObligations.breakdown.length > 0) {
    lines.push("", "Por que:");
    for (const item of s.currentObligations.breakdown) {
      const label = item.description || `Fatura ${item.cardName} (${item.cycleMonth})`;
      let classLabel = CLASS_LABEL[item.class] || item.class;
      // Compromisso SEM prazo: "até a próxima renda" seria enganoso (não há data).
      if (item.type === "ConfirmedCommitment" && !(item.dueDate ?? item.dueAt)) classLabel = item.status === "FUNDED" ? "dinheiro separado, sem prazo definido" : "sem prazo definido";
      lines.push(`- ${label}: ${fmt(item.amount)} (${classLabel})`);
    }
  }
  if (unpricedNote(s)) lines.push("", unpricedNote(s));
  return lines.join("\n");
}

// Item 8 — semântica obrigatória: base salarial != promessa do valor real.
function formatNextIncome(s) {
  const { nextIncome, nextIncomeCommitment } = s;
  const lines = [];
  if (nextIncome.expectedDate) {
    lines.push(`Próxima renda esperada: ${formatDate(nextIncome.expectedDate)}`);
  } else {
    lines.push("Não há uma próxima renda configurada.");
  }
  if (nextIncome.baseAmount != null) {
    lines.push(`Base: ${fmt(nextIncome.baseAmount)} (salário-base — valor real só é confirmado quando cair)`);
  }
  if (!nextIncome.actualAmountKnown) {
    lines.push("Valor real ainda não confirmado.");
  }
  if (nextIncomeCommitment.baseCommittedPercent != null) {
    lines.push(`Já comprometido: ${fmt(nextIncomeCommitment.committedAmount)} (≈${nextIncomeCommitment.baseCommittedPercent.toFixed(1)}% da base)`);
  }
  return lines.join("\n");
}

// Item 9 — nunca inventa data exata pra AFTER_NEXT_INCOME; runoff em
// linguagem de "janela de renda", nunca uma data de calendário chutada.
function formatExternalInstallments(s) {
  const ext = s.externalInstallments;
  if (ext.activePlanCount === 0) {
    return "Você não tem parcelas externas ativas.";
  }
  const lines = [
    `${ext.activePlanCount} plano(s) ativo(s).`,
    `Na próxima renda: ${fmt(ext.nextWindowAmount)} (${ext.nextWindowCount} parcela(s)).`,
  ];
  if (ext.runoff && ext.runoff.length > 0) {
    const nonZero = ext.runoff.filter((r) => r.activePlanCount > 0);
    const zeroOffset = ext.runoff.find((r) => r.activePlanCount === 0);
    const compact = nonZero.slice(0, 4).map((r) => fmt(r.monthTotal)).join(" → ");
    if (zeroOffset) {
      lines.push(`Runoff: ${compact}${nonZero.length > 4 ? " → ..." : ""} → zera daqui a ${zeroOffset.offset} janela(s) de renda.`);
    } else {
      lines.push(`Runoff: ${compact}${nonZero.length > 4 ? " → ..." : ""}`);
    }
  }
  return lines.join("\n");
}

// Item 10 — VA nunca entra como unrestricted cash.
function formatVa(s) {
  if (!s.restricted) return "Não encontrei uma conta de Vale Alimentação configurada.";
  const r = s.restricted;
  const lines = [`VA: ${fmt(r.vaBalance)}`, `Recebido no ciclo: ${fmt(r.vaReceived)} · Gasto: ${fmt(r.vaSpent)}`];
  if (r.vaNextRecharge) lines.push(`Próxima recarga: ${formatDate(r.vaNextRecharge)}`);
  return lines.join("\n");
}

// Item 11 — helpers canônicos de Card (os MESMOS que o dashboard usa), nunca
// legacy CardBill/semântica de ciclo antiga; não corrige o known Card detail
// gap aqui (fora de escopo desta fase).
async function formatCard(s, now = new Date()) {
  const cards = await listCardsWithLimits();
  if (cards.length === 0) return "Você não tem cartão cadastrado.";
  const lines = [];
  for (const card of cards) {
    const currentCycle = getCardCycleForDate(card, now);
    const currentBill = await getCardBillView(card, currentCycle);
    lines.push(
      `${card.name}: fatura atual ${fmt(currentBill.totalAmount)}`,
      `Limite: ${fmt(card.availableLimit)} disponível de ${fmt(card.totalLimit)}`
    );
  }
  return lines.join("\n");
}
