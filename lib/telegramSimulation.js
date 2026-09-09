import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";
import { simulateFinancialScenario, SIMULATION_SCENARIO_TYPE, SimulationInputError } from "./simulation/financialSimulator.js";
import { getDefaultCard } from "./accountResolver.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { serializeMoney } from "./money.js";

// ============================================================================
// Fase 5.3E, itens 27-30 — Telegram SIMULATION READ intents. Mesmo princípio
// central de lib/telegramReads.js: este arquivo só FORMATA texto em cima do
// que lib/simulation/financialSimulator.js já compôs — NENHUMA fórmula
// financeira nova, NENHUM acesso a banco além de resolver qual cartão/
// contingência a frase se refere (o cálculo em si é 100% o simulador
// canônico). Tratado pelo telegramUpdateHandler.js exatamente como um READ
// (bypassa a transação/idempotência): zero efeito persistente, então um
// retry do mesmo update_id só recalcula e reenvia — nunca duplica nada.
// ============================================================================

export const SIMULATION_INTENTS = new Set([
  "simulate_cash_expense",
  "simulate_card_purchase_single",
  "simulate_card_purchase_installments",
  "simulate_contingency",
]);

function fmt(decimalValue) {
  return formatMoney(serializeMoney(decimalValue));
}

// Mesmo espírito de lib/billMatcher.js:significantWords (fuzzy match por
// sobreposição de palavras) — pequeno e local, porque a lista de stopwords é
// específica de nome de contingência ("a"/"o"/"minha"/etc.), diferente da
// lista de billMatcher (voltada a descrição de conta).
const CONTINGENCY_STOPWORDS = new Set(["a", "o", "de", "da", "do", "minha", "meu", "essa", "esse", "contingencia", "risco", "ficar"]);
function significantWords(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !CONTINGENCY_STOPWORDS.has(w));
}

// Fuzzy match por sobreposição de palavras contra a descrição real de cada
// Contingency ativa — nunca inventa uma contingência que não existe; se nada
// bater, quem chama degrada pra uma resposta honesta ("não encontrei").
async function matchContingency(query, { client = prisma } = {}) {
  const contingencies = await client.contingency.findMany({ where: { status: { not: "DISMISSED" } } });
  if (contingencies.length === 0) return { match: null };
  const queryWords = new Set(significantWords(query));
  const scored = contingencies
    .map((c) => ({ contingency: c, score: significantWords(c.description).filter((w) => queryWords.has(w)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return { match: scored[0]?.contingency ?? null };
}

// Resposta compacta (item 13, mesmo princípio de telegramReads.js — Telegram
// não é dashboard): CARD_FEASIBILITY separado de BUDGET_SAFETY sempre que
// existir, verdict geral por último, sempre com o lembrete de que é só
// simulação.
function formatVerdict(result) {
  const lines = [];
  if (result.cardFeasibility) {
    lines.push(
      result.cardFeasibility.verdict === "CAN_AUTHORIZE"
        ? `✅ O cartão ${result.cardFeasibility.cardName} autorizaria (disponível ${fmt(result.cardFeasibility.availableLimitBefore)}).`
        : `❌ O cartão ${result.cardFeasibility.cardName} NÃO autorizaria — faltam ${fmt(result.cardFeasibility.shortfall)} de limite.`
    );
  }
  lines.push(
    result.verdict === "SAFE"
      ? "✅ Cabe no seu orçamento (situação simulada continua Tranquila/Atenção)."
      : result.verdict === "CANNOT_AUTHORIZE"
        ? "❌ Não dá — o limite do cartão não cobre isso."
        : "⚠️ Cabe no cartão, mas NÃO é seguro pro orçamento (situação simulada ficaria Apertada/Crítica)."
  );
  lines.push(`Dinheiro livre: ${fmt(result.baseline.freeMoney)} → ${fmt(result.simulated.freeMoney)}`);
  if (result.installmentSchedule) {
    lines.push(`${result.installmentSchedule.length}x de ${fmt(result.installmentSchedule[0].amount)}, primeira parcela em ${formatDate(result.installmentSchedule[0].dueAt)}`);
  }
  lines.push("(simulação — não altera seus dados)");
  return lines.join("\n");
}

// handleSimulationIntent(intentResult, rawMessage) -> texto de resposta.
// `intentResult` é o objeto inteiro devolvido por classifyIntent (intent +
// amount/installmentCount/contingencyQuery já extraídos lá, de forma pura).
export async function handleSimulationIntent(intentResult) {
  const { intent, amount, installmentCount, contingencyQuery } = intentResult;
  try {
    if (intent === "simulate_cash_expense") {
      const result = await simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount } });
      return formatVerdict(result);
    }

    if (intent === "simulate_card_purchase_single" || intent === "simulate_card_purchase_installments") {
      // Nenhum cartão específico é nomeado nas frases-alvo desta fase ("e se
      // eu comprar 1200 no cartão?") — resolve pro MESMO default (cartão mais
      // antigo) que o resto do bot já usa quando o cartão não é dito (ver
      // lib/accountResolver.js:getDefaultCard, P3 documentado desde a
      // auditoria original: inofensivo com 1 cartão só, reavaliar se um 2º
      // cartão existir).
      const card = await getDefaultCard();
      if (!card) return "Você ainda não tem cartão cadastrado pra simular isso.";

      const scenario =
        intent === "simulate_card_purchase_single"
          ? { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount }
          : { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId: card.id, totalAmount: amount, installmentCount };
      const result = await simulateFinancialScenario({ scenario });
      return formatVerdict(result);
    }

    if (intent === "simulate_contingency") {
      const { match } = await matchContingency(contingencyQuery);
      if (!match) return `Não encontrei nenhuma contingência parecida com "${contingencyQuery}".`;

      // Timing: a frase-alvo desta fase ("se a X ficar Y como eu fico?") não
      // referencia nenhuma data futura — só o AGORA hipotético faz sentido
      // pra essa pergunta, então "NOW" aqui é a leitura natural da própria
      // frase (documentado), não uma omissão silenciosa como a API genérica
      // proíbe (essa continua exigindo timing explícito de quem chama
      // programaticamente).
      const scenario = { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: match.id, timing: "NOW" };
      // Valor: usa o número da própria frase quando presente ("ficar 2000");
      // sem número, usa o expectedAmount REAL já cadastrado (nunca inventa).
      if (amount != null) scenario.amount = amount;
      else scenario.amountField = "expected";

      const result = await simulateFinancialScenario({ scenario });
      return `${match.description}:\n${formatVerdict(result)}`;
    }

    return "Não entendi o que simular.";
  } catch (err) {
    if (err instanceof SimulationInputError) return `Não consegui simular isso: ${err.message}`;
    throw err;
  }
}
