import { prisma } from "./prisma.js";
import { normalize } from "./categoryRules.js";
import { simulateFinancialScenario, SIMULATION_SCENARIO_TYPE, SimulationInputError } from "./simulation/financialSimulator.js";
import { extractInstallmentCount } from "./amountExtractor.js";
import { getNextIncomeInfo } from "./incomeHorizon.js";
import { formatMoney, formatDate } from "./formatMoney.js";
import { serializeMoney } from "./money.js";

// ============================================================================
// Fase 5.3E, itens 27-30 / Fase 5.3E.1 — Telegram SIMULATION + CLARIFICATION.
// Mesmo princípio central de lib/telegramReads.js: este arquivo só FORMATA
// texto em cima do que lib/simulation/financialSimulator.js já compôs —
// NENHUMA fórmula financeira nova.
//
// Duas famílias de intent, com durabilidade DIFERENTE (Fase 5.3E.1, item 14
// — nenhuma regressão na garantia de atomicidade da Fase 5.3C.2):
//
//   SIMULATION_BYPASS_INTENTS — nunca ambíguos, zero efeito persistente,
//   tratados por lib/telegramUpdateHandler.js EXATAMENTE como READ (bypassa
//   a transação/idempotência inteira). Hoje só `simulate_cash_expense` (item
//   3: "gastar"/"pagar" sempre têm método definido por si só).
//
//   SIMULATION_TRANSACTIONAL_INTENTS — podem precisar perguntar algo
//   (método de pagamento, qual cartão, timing de contingência) ANTES de
//   simular. Perguntar exige LEMBRAR o que já foi dito entre uma mensagem e
//   outra — o webhook de produção roda numa function serverless sem memória
//   —, então essa família passa por lib/processTelegramMessage.js e usa
//   PendingBotMessage como infraestrutura de estado (Fase 5.3E.1, item 12,
//   documentado explicitamente aqui): a clarificação em si é uma escrita
//   NÃO-FINANCEIRA (não é Expense/Income/Purchase/Bill/CardBill/
//   ConfirmedCommitment/Contingency — só lembra "o que perguntei, o que já
//   sei"), então roda dentro da MESMA transação atômica que já protege o
//   resto do bot (Fase 5.3C.2) sem enfraquecer nem duplicar essa garantia.
//   Consequência aceita e documentada: a resposta de uma clarificação é
//   "BEST-EFFORT POST-COMMIT REPLY" (mesmo termo já usado pra qualquer outro
//   fluxo de bot não-READ), não mais o bypass de retry-sempre-seguro que só
//   se aplica a leitura pura.
// ============================================================================

export const SIMULATION_BYPASS_INTENTS = new Set(["simulate_cash_expense"]);

export const SIMULATION_TRANSACTIONAL_INTENTS = new Set([
  "clarify_payment_method",
  "simulate_card_purchase_single",
  "simulate_card_purchase_installments",
  "simulate_contingency",
]);

const PAYMENT_METHOD_PROMPT = "Vai pagar como?\n• pix/dinheiro\n• cartão à vista\n• cartão parcelado";
const YES_RE = /^(s|sim|yes|confirmo|isso|correto|ok|agora|hoje|1)\b/i;
const NO_RE = /^(n|nao|não|no|cancela)\b/i;

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
// Fase 7.0 — exportada (era só interna) pra o pipeline conversacional
// (lib/telegramAi/pipeline.js) poder formatar o MESMO resultado de
// simulateFinancialScenario sem reimplementar a formatação — nenhuma
// mudança de comportamento pros call sites existentes deste arquivo.
export function formatVerdict(result) {
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

async function runCashSimulation(amount) {
  const result = await simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount } });
  return formatVerdict(result);
}

async function runCardSimulation(kind, cardId, amount, installmentCount) {
  const scenario =
    kind === "card_single"
      ? { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId, amount }
      : { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId, totalAmount: amount, installmentCount };
  const result = await simulateFinancialScenario({ scenario });
  return formatVerdict(result);
}

async function runContingencySimulation(contingency, amount, timing) {
  const scenario = { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: contingency.id, timing };
  // Valor: usa o número da própria frase quando presente ("ficar 2000"); sem
  // número, usa o expectedAmount REAL já cadastrado (nunca inventa).
  if (amount != null) scenario.amount = amount;
  else scenario.amountField = "expected";
  const result = await simulateFinancialScenario({ scenario });
  return `${contingency.description}:\n${formatVerdict(result)}`;
}

function buildCardChoicePrompt(cards) {
  return `Qual cartão?\n${cards.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}`;
}

function matchCardChoice(answer, cardOptions) {
  const index = parseInt(answer, 10);
  if (Number.isInteger(index) && cardOptions[index - 1]) return cardOptions[index - 1];
  const normalizedAnswer = normalize(answer);
  return cardOptions.find((c) => normalizedAnswer.includes(normalize(c.name))) || null;
}

// Fase 5.3E.1, item 10 — resolve qual cartão usar SEM adivinhar quando há
// mais de um. Exactly one eligible card = comportamento não-ambíguo (usa
// direto, como já era). Mais de um = pergunta (nunca mais "o mais antigo"
// silenciosamente).
async function resolveCardOrAskChoice(amount, installmentCount, simulationKind, { client = prisma } = {}) {
  const cards = await client.card.findMany({ orderBy: { createdAt: "asc" } });
  if (cards.length === 0) return { reply: "Você ainda não tem cartão cadastrado pra simular isso." };
  if (cards.length === 1) {
    const reply = await runCardSimulation(simulationKind, cards[0].id, amount, installmentCount);
    return { reply };
  }
  const promptMessage = buildCardChoicePrompt(cards);
  return {
    reply: promptMessage,
    pending: {
      promptMessage,
      data: { stage: "card_choice", simulationKind, amount, installmentCount, cardOptions: cards.map((c) => ({ id: c.id, name: c.name })) },
    },
  };
}

// handleBypassSimulationIntent(intentResult) -> texto de resposta. Só
// `simulate_cash_expense` — nunca ambíguo, zero DB write, seguro pro bypass
// de READ (retry do mesmo update_id sempre pode recalcular e reenviar).
export async function handleBypassSimulationIntent(intentResult) {
  try {
    return await runCashSimulation(intentResult.amount);
  } catch (err) {
    if (err instanceof SimulationInputError) return `Não consegui simular isso: ${err.message}`;
    throw err;
  }
}

// handleTransactionalSimulationIntent(classified, {client}) ->
// { reply } quando já dá pra simular direto, ou
// { reply, pending: { promptMessage, data } } quando falta uma resposta do
// usuário — quem chama (lib/processTelegramMessage.js) grava `pending` num
// PendingBotMessage (mesma infra não-financeira do resto do bot, item 12).
export async function handleTransactionalSimulationIntent(classified, { client = prisma } = {}) {
  const { intent, amount, installmentCount, contingencyQuery, timingExplicit } = classified;
  try {
    if (intent === "clarify_payment_method") {
      return { reply: PAYMENT_METHOD_PROMPT, pending: { promptMessage: PAYMENT_METHOD_PROMPT, data: { stage: "payment_method", amount } } };
    }

    if (intent === "simulate_card_purchase_single" || intent === "simulate_card_purchase_installments") {
      const kind = intent === "simulate_card_purchase_single" ? "card_single" : "card_installments";
      return await resolveCardOrAskChoice(amount, installmentCount, kind, { client });
    }

    if (intent === "simulate_contingency") {
      const { match } = await matchContingency(contingencyQuery, { client });
      if (!match) return { reply: `Não encontrei nenhuma contingência parecida com "${contingencyQuery}".` };

      if (timingExplicit === "NOW") {
        const reply = await runContingencySimulation(match, amount, "NOW");
        return { reply };
      }

      // Fase 5.3E.1, itens 6/7 — timing NUNCA assumido silenciosamente.
      // NEXT_INCOME_WINDOW é honestamente suportado (nextIncomeDate real, já
      // usado em todo o resto do produto) — oferece as duas opções quando
      // existe uma próxima renda esperada; senão, só confirma "agora".
      const nextIncome = await getNextIncomeInfo({ client });
      const promptMessage = nextIncome?.expectedDate
        ? `Quer simular o pagamento de "${match.description}":\n1. Agora\n2. Depois da próxima renda (${formatDate(nextIncome.expectedDate)})`
        : `Quer que eu simule "${match.description}" assumindo pagamento agora?`;
      return {
        reply: promptMessage,
        pending: {
          promptMessage,
          data: {
            stage: "contingency_timing",
            contingencyId: match.id,
            amount,
            hasNextIncomeOption: nextIncome?.expectedDate != null,
            nextIncomeDate: nextIncome?.expectedDate ?? null,
          },
        },
      };
    }

    return { reply: "Não entendi o que simular." };
  } catch (err) {
    if (err instanceof SimulationInputError) return { reply: `Não consegui simular isso: ${err.message}` };
    throw err;
  }
}

// resolveSimulationPending(pending, answer, {client}) -> { reply } (fim do
// fluxo) ou { reply, pending: {...} } (mais uma pergunta, ex: método
// "parcelado" sem dizer em quantas vezes). NUNCA chama commitBotIntent —
// ZERO mutação financeira em qualquer ramo (item 12).
export async function resolveSimulationPending(pending, answer, { client = prisma } = {}) {
  const data = pending.parsedPayload;
  const normalizedAnswer = normalize(answer);

  try {
    if (data.stage === "payment_method") {
      // NUNCA testar classe de caractere acentuado (`[ãa]`) contra texto já
      // normalizado — bug real já corrigido uma vez na Fase 5.3D.1 ("como eu
      // tô"): normalize() já removeu o acento, então só a forma ASCII existe
      // aqui (`\bcartao\b`, nunca `cart[ãa]o`).
      if (/\b(pix|dinheiro|debito)\b/.test(normalizedAnswer) && !/\bcartao\b/.test(normalizedAnswer)) {
        return { reply: await runCashSimulation(data.amount) };
      }
      if (/\bparcel/.test(normalizedAnswer)) {
        const installmentCount = extractInstallmentCount(answer);
        if (installmentCount == null) {
          const promptMessage = "Em quantas vezes?";
          return { reply: promptMessage, pending: { promptMessage, data: { stage: "installment_count", amount: data.amount } } };
        }
        return await resolveCardOrAskChoice(data.amount, installmentCount, "card_installments", { client });
      }
      if (/\b(vista|cartao|credito)\b/.test(normalizedAnswer)) {
        return await resolveCardOrAskChoice(data.amount, null, "card_single", { client });
      }
      return { reply: 'Não entendi. Tenta de novo do zero — responde "pix", "cartão à vista" ou "cartão parcelado".' };
    }

    if (data.stage === "installment_count") {
      const installmentCount = extractInstallmentCount(answer) || (Number.isInteger(parseInt(answer, 10)) ? parseInt(answer, 10) : null);
      if (installmentCount == null || installmentCount < 1) {
        return { reply: "Não entendi o número de parcelas. Tenta de novo do zero." };
      }
      return await resolveCardOrAskChoice(data.amount, installmentCount, "card_installments", { client });
    }

    if (data.stage === "card_choice") {
      const chosen = matchCardChoice(answer, data.cardOptions);
      if (!chosen) return { reply: `Não entendi qual cartão. Tenta de novo do zero — um desses: ${data.cardOptions.map((c) => c.name).join(", ")}.` };
      const reply = await runCardSimulation(data.simulationKind, chosen.id, data.amount, data.installmentCount);
      return { reply };
    }

    if (data.stage === "contingency_timing") {
      const contingency = await client.contingency.findUnique({ where: { id: data.contingencyId } });
      if (!contingency) return { reply: "Essa contingência não existe mais. Tenta de novo do zero." };

      // "depois da renda" checado ANTES de "agora"/yes — mais específico
      // (evita "2" ou "renda" caírem no ramo genérico de confirmação).
      let timing = null;
      if (data.hasNextIncomeOption && /\b(2|depois|proxima|renda)\b/.test(normalizedAnswer)) {
        timing = data.nextIncomeDate;
      } else if (YES_RE.test(answer) || /\bagora\b/.test(normalizedAnswer)) {
        timing = "NOW";
      } else if (!data.hasNextIncomeOption && NO_RE.test(answer)) {
        return { reply: "Beleza, não simulei nada." };
      }
      if (!timing) return { reply: 'Não entendi. Tenta de novo do zero — responde "agora" ou "depois da próxima renda".' };

      const reply = await runContingencySimulation(contingency, data.amount, timing);
      return { reply };
    }

    return { reply: "Não entendi. Tenta de novo do zero." };
  } catch (err) {
    if (err instanceof SimulationInputError) return { reply: `Não consegui simular isso: ${err.message}` };
    throw err;
  }
}
