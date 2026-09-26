// ============================================================================
// Fase 10 — "SE EU COMPRAR ALGO HOJE" (área /cartoes). NÃO é um segundo motor financeiro: o resultado de
// ORÇAMENTO vem 100% de lib/simulation/financialSimulator.js (a mesma função do /simulador — mesmo baseline,
// mesmas projeções, mesma regra de status), avaliada sobre um contexto pré-carregado para poder rodar dezenas
// de compras hipotéticas em memória. O resultado de LIMITE é separado (lib/cardsItauPure.js) e honesto sobre
// o que o Norte não sabe. ZERO escrita: só leitura + aritmética.
// ============================================================================
import { prisma } from "./prisma.js";
import { serializeMoney } from "./money.js";
import { simulateFinancialScenario, prepareSimulationContext, SIMULATION_SCENARIO_TYPE } from "./simulation/financialSimulator.js";
import { evaluateCardCapacity, installmentValueOf, round2, monthShort } from "./cardsItauPure.js";

const num = (x) => (x == null ? null : Number(serializeMoney(x)));
export const PURCHASE_OPTIONS = [1, 2, 3, 6, 10];

// Cache curto do contexto (só quando o relógio não é injetado): a página faz várias chamadas seguidas.
let cache = { key: null, at: 0, ctx: null, promise: null };
const TTL_MS = 20000;
export function clearCapacityContextCache() { cache = { key: null, at: 0, ctx: null, promise: null }; }

export async function getCapacityContext({ cardId, now, client = prisma } = {}) {
  const injected = now != null;
  const useNow = now ?? new Date();
  if (!injected && cache.key === cardId && Date.now() - cache.at < TTL_MS && cache.ctx) return cache.ctx;
  const ctx = await prepareSimulationContext({ client, now: useNow, cardId });
  if (!injected) cache = { key: cardId, at: Date.now(), ctx };
  return ctx;
}

function scenarioFor(cardId, amount, n) {
  return n === 1
    ? { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId, amount }
    : { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId, totalAmount: amount, installmentCount: n };
}

function worstPoint(projection) {
  let worst = { cash: num(projection.startingCash), date: null };
  for (const e of projection.timeline) {
    const c = num(e.balanceAfter);
    if (c < worst.cash) worst = { cash: c, date: e.date };
  }
  return { cash: round2(worst.cash), date: worst.date ? new Date(worst.date).toISOString().slice(0, 10) : null, label: worst.date ? monthShort(new Date(worst.date).toISOString().slice(0, 7)) : null };
}

// Avalia UMA compra (amount, n). `knowledge` = limit do Itaú (buildItauModel().limit).
export async function evaluatePurchase({ cardId, amount, installments = 1, knowledge, now, client = prisma, context }) {
  const n = Number(installments);
  const ctx = context ?? (await getCapacityContext({ cardId, now, client }));
  const sim = await simulateFinancialScenario({ client, now: ctx.now, scenario: scenarioFor(cardId, amount, n), context: ctx });
  const installmentAmount = installmentValueOf(amount, n);
  const cardCapacity = evaluateCardCapacity(knowledge, amount);
  const worstAfter = worstPoint(sim.simulated.projections.base);
  const worstBefore = worstPoint(sim.baseline.projections.base);
  const budgetCapacity = {
    status: sim.budgetSafety.verdict, // SAFE | NOT_SAFE — reusa computeFinancialStatus (mesma regra do /simulador)
    monthlyImpact: installmentAmount,
    safeImpact: round2(num(sim.baseline.safeToSpend) - num(sim.simulated.safeToSpend)),
    freeImpact: round2(num(sim.baseline.freeMoney) - num(sim.simulated.freeMoney)),
    projectedFreeMoney: num(sim.simulated.freeMoney),
    baselineFreeMoney: num(sim.baseline.freeMoney),
    statusFrom: sim.baseline.status.status,
    statusTo: sim.simulated.status.status,
    worstMonth: worstAfter,
    worstMonthBefore: worstBefore,
    reasons: sim.budgetSafety.reasons ?? [],
  };
  return {
    amount: round2(amount),
    installments: n,
    installmentAmount,
    installmentSchedule: (sim.installmentSchedule ?? []).map((r) => ({ number: r.number, amount: num(r.amount), billMonth: r.billMonth, dueAt: new Date(r.dueAt).toISOString().slice(0, 10) })),
    cardCapacity,
    budgetCapacity,
    simulatorVerdict: sim.verdict, // veredito legado do /simulador (limite derivado + orçamento) — mantido só para comparação
    explanation: sim.explanation,
  };
}

// Capacidade segura de ORÇAMENTO por número de parcelas: maior valor (R$ inteiros) cujo veredito de orçamento
// ainda é SAFE, por busca binária determinística (≤ ~13 avaliações por opção). Pressuposto: a segurança do
// orçamento é monotônica no valor (mais caro nunca é mais seguro) — verificado nos testes.
export async function computeBudgetCaps({ cardId, knowledge, options = PURCHASE_OPTIONS, hi, now, client = prisma, context }) {
  const ctx = context ?? (await getCapacityContext({ cardId, now, client }));
  const upper = Math.max(1, Math.floor(hi ?? knowledge.total));
  const safe = async (amount, n) => (await simulateFinancialScenario({ client, now: ctx.now, scenario: scenarioFor(cardId, amount, n), context: ctx })).budgetSafety.verdict === "SAFE";
  const caps = {};
  for (const n of options) {
    if (!(await safe(1, n))) { caps[n] = 0; continue; }
    if (await safe(upper, n)) { caps[n] = upper; continue; }
    let lo = 1;
    let up = upper;
    let guard = 0;
    while (up - lo > 1 && guard++ < 20) {
      const mid = Math.floor((lo + up) / 2);
      if (await safe(mid, n)) lo = mid; else up = mid;
    }
    caps[n] = lo;
  }
  return caps;
}
