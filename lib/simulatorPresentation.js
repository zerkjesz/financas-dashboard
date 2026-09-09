import { ArrowRightLeft, CreditCard, Layers, CircleDashed } from "lucide-react";
import { STATUS_COPY } from "./homePresentation";

// ============================================================================
// Fase 5.4E — SIMULATOR PRESENTATION HELPERS. Mesmo padrão de
// lib/homePresentation.js/lib/cardPresentation.js: pura derivação de
// apresentação sobre o resultado JÁ canônico de
// lib/simulation/financialSimulator.js — NUNCA recalcula freeMoney/
// safeToSpend/verdict/feasibility/safety/parcela/projeção. Reaproveita
// STATUS_COPY da Home (ONE_TRUTH_ONE_NAME — o mesmo status usa a mesma
// copy em qualquer superfície do produto).
// ============================================================================

export { STATUS_COPY };

// Item 4/5 — os 4 cenários canônicos preservados, com copy humana conceitual
// (nunca o enum técnico na tela).
export const SCENARIO_CONFIG = [
  { type: "CASH_EXPENSE_NOW", label: "PIX ou dinheiro", question: "E se eu gastar em dinheiro/débito agora?", icon: ArrowRightLeft },
  { type: "CARD_PURCHASE_SINGLE", label: "Cartão à vista", question: "E se eu comprar no cartão, à vista?", icon: CreditCard },
  { type: "CARD_PURCHASE_INSTALLMENTS", label: "Cartão parcelado", question: "E se eu parcelar essa compra no cartão?", icon: Layers },
  { type: "CONTINGENCY_REALIZATION", label: "Risco virar realidade", question: "E se um risco em aberto acontecer de verdade?", icon: CircleDashed },
];

export function scenarioLabel(type) {
  return SCENARIO_CONFIG.find((s) => s.type === type)?.label || type;
}

// Item 25-27 — feasibility (capacidade técnica do cartão) e safety
// (cabe no orçamento) são SEPARADOS por design — nunca uma frase só.
export const VERDICT_COPY = {
  SAFE: { label: "Cabe com segurança", tone: "positive" },
  NOT_SAFE: { label: "Cabe, mas aperta o orçamento", tone: "warning" },
  CANNOT_AUTHORIZE: { label: "O cartão não autorizaria", tone: "danger" },
};

export const FEASIBILITY_COPY = {
  CAN_AUTHORIZE: "O limite do cartão comporta esta compra.",
  CANNOT_AUTHORIZE: "O limite disponível do cartão não comporta esta compra.",
};

// Item 27 — copy factual, nunca moralista ("não faça isso").
//
// Fase 5.4E, item F — BUG REAL corrigido: a frase NOT_SAFE fixa ("...passa a
// Apertada ou Crítica") assume implicitamente que o baseline NÃO estava
// assim — mas com dado real (freeMoney já negativo, status já APERTADO), a
// hipótese não "leva a" esse estado, ele JÁ EXISTIA antes de qualquer
// simulação. "passa a" nesse caso atribui à compra hipotética um problema
// que já era real, escondendo o pré-existente. safetyBodyCopy() decide a
// frase certa comparando baseline.status com o resultado — nunca um texto
// fixo que finge que o "antes" era sempre seguro.
const NOT_SAFE_STATUSES = ["APERTADO", "CRITICO"];

export const SAFETY_COPY = {
  SAFE: "Nesse cenário, sua situação financeira continua Tranquila ou em Atenção.",
  NOT_SAFE: "Nesse cenário, sua situação financeira passa a Apertada ou Crítica — menos margem do que o normal.",
};

// Usar esta função em vez de indexar SAFETY_COPY direto quando o baseline
// estiver disponível (ResultPanel sempre tem — result.baseline.status).
export function safetyBodyCopy(verdict, baselineStatus) {
  if (verdict === "SAFE") return SAFETY_COPY.SAFE;
  const alreadyNotSafe = NOT_SAFE_STATUSES.includes(baselineStatus);
  if (alreadyNotSafe) {
    return "Sua situação financeira já estava Apertada ou Crítica antes dessa hipótese. Nesse cenário, ela continua assim — com ainda menos margem do que já tinha.";
  }
  return SAFETY_COPY.NOT_SAFE;
}

const CHECKPOINTS = [
  { key: "day30", label: "30 dias" },
  { key: "day60", label: "60 dias" },
  { key: "day90", label: "90 dias" },
];
export { CHECKPOINTS as PROJECTION_CHECKPOINTS };
