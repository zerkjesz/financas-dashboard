// Fase 10 — helpers PUROS da área Cartões v5 (sem React, sem DOM): carrossel, swipe, teclado, veredito da compra,
// geometria dos gráficos e blocos do Caju. Testáveis em node (scripts/test-fase10-ui.mjs).
import { fmt, fmtS } from "../v4/format.js";
import { evaluateCardCapacity, installmentValueOf, round2 } from "../../../lib/cardsItauPure.js";

export const CARD_KEYS = ["itau", "caju"];
export const STORAGE_KEY = "norte.cartoes.card";

// ---------- carrossel ----------
export const clampIndex = (i, n) => ((i % n) + n) % n;
export const stepIndex = (index, delta, n = CARD_KEYS.length) => clampIndex(index + delta, n);
export const directionOf = (from, to) => (to === from ? 0 : to > from ? 1 : -1);
// Teclado: só ← / → trocam de cartão, e NUNCA quando o foco está num campo/slider (que usa as setas).
export function keyDelta(key, target) {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return 0;
  const tag = target?.tagName;
  const role = target?.getAttribute?.("role");
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || role === "slider" || target?.isContentEditable) return 0;
  return key === "ArrowRight" ? 1 : -1;
}
// Swipe horizontal: dx < 0 (arrastou para a esquerda) => próximo. Ignora gestos curtos e gestos mais verticais que horizontais.
export function swipeDelta(dx, dy = 0, threshold = 40) {
  if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
}
export function resolveInitialCard({ query, stored }) {
  if (CARD_KEYS.includes(query)) return CARD_KEYS.indexOf(query);
  if (CARD_KEYS.includes(stored)) return CARD_KEYS.indexOf(stored);
  return 0;
}
export const cardAnimClass = (dir, reduced) => (reduced ? "" : dir === 0 ? "n5-card-in" : dir > 0 ? "n5-card-r" : "n5-card-l");

// ---------- slider (posição <-> valor) ----------
export function valueFromRatio(ratio, min, max, step) {
  const t = Math.min(1, Math.max(0, ratio));
  const raw = min + t * (max - min);
  return Math.min(max, Math.max(min, Math.round(raw / step) * step));
}
export const ratioOf = (value, min, max) => (max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0);
export function sliderKeyValue(key, value, min, max, step) {
  const big = step * 10;
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(max, value + step);
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(min, value - step);
  if (key === "PageUp") return Math.min(max, value + big);
  if (key === "PageDown") return Math.max(min, value - big);
  if (key === "Home") return min;
  if (key === "End") return max;
  return value;
}

// ---------- compra: veredito (limite ≠ orçamento) ----------
export const CARD_STATUS_TEXT = {
  FITS_LIKELY: { title: "Deve passar no cartão", tone: "ok" },
  UNCERTAIN: { title: "Pode passar no cartão", tone: "warn" },
  UNLIKELY: { title: "Provavelmente não passa no cartão", tone: "warn" },
  EXCEEDS: { title: "Não cabe no limite", tone: "warn" },
};
export function purchaseVerdict({ cardStatus, budgetOk, amount, n, capacity, budgetCap }) {
  const card = CARD_STATUS_TEXT[cardStatus] ?? CARD_STATUS_TEXT.UNCERTAIN;
  const monthly = installmentValueOf(amount, n);
  const cardOk = cardStatus === "FITS_LIKELY";
  let verdict;
  if (cardStatus === "EXCEEDS") verdict = "Não cabe no limite.";
  else if (cardStatus === "UNLIKELY") verdict = budgetOk ? "Provavelmente não passa no cartão." : "Provavelmente não passa no cartão e aperta o orçamento.";
  else if (cardStatus === "UNCERTAIN") verdict = budgetOk ? "Pode passar no cartão — limite não reconciliado." : "Pode passar no cartão, mas aperta o orçamento.";
  else verdict = budgetOk ? "Deve passar no cartão e cabe no orçamento." : "Deve passar no cartão, mas aperta o orçamento.";
  let reason;
  if (cardStatus === "EXCEEDS") reason = `A compra inteira ocupa o limite. O comprometido conhecido já deixa no máximo ${fmt(capacity.availableLimit.ceiling)} livres.`;
  else if (!budgetOk) reason = `O banco pode aprovar, mas ${fmt(monthly)}${n > 1 ? "/mês" : ""} fica acima do que o seu orçamento aguenta${budgetCap > 0 ? ` (até ${fmt(budgetCap)} em ${n === 1 ? "1x" : n + "x"})` : ""}. ${n < 10 ? "Mais parcelas diluem o impacto." : ""}`.trim();
  else if (cardStatus === "FITS_LIKELY") reason = "Dentro do limite estimado, e o impacto mensal cabe na folga projetada.";
  else reason = "O limite disponível não está reconciliado com o banco; o impacto mensal cabe na folga projetada.";
  const good = cardOk && budgetOk;
  return { verdict, reason, tone: good ? "#C9FF29" : "#FFFFFF", dot: good ? "#C9FF29" : "#E0A94A", cardTitle: card.title };
}

// Avaliação local INSTANTÂNEA (o slider não espera a rede): usa os tetos por parcelamento já calculados pelo motor
// (busca determinística sobre o simulador) e a mesma função pura de limite do backend.
export function localAssessment({ amount, n, limit, caps }) {
  const capacity = evaluateCardCapacity({ ceilingAvailable: limit.ceiling, estimate: { low: limit.low, high: limit.high }, availableStatus: "NOT_RECONCILED" }, amount);
  const budgetCap = caps?.[n] ?? null;
  const budgetOk = budgetCap == null ? null : amount <= budgetCap;
  return { capacity, budgetCap, budgetOk };
}
export function capacityCells({ options, caps, limit }) {
  return options.map((n) => {
    const cap = caps?.[n] ?? null;
    const limited = cap != null && cap > limit.ceiling;
    return { n, label: n === 1 ? "À vista" : `${n}x`, cap: cap == null ? null : Math.min(cap, limit.ceiling), limitedByCard: limited };
  });
}
export const optionLabel = (n) => (n === 1 ? "À vista" : `${n}x`);

// ---------- Itaú: barras ----------
export function billSegments(bill) {
  const total = bill.total > 0 ? bill.total : 1;
  const pct = (v) => Math.max(0, (v / total) * 100);
  return [
    { key: "installments", label: "Parcelas", value: bill.installments, pct: pct(bill.installments), kind: "ink" },
    { key: "purchases", label: "Compras do mês", value: bill.purchases, pct: pct(bill.purchases), kind: "mid" },
    { key: "unknown", label: "Sem detalhamento", value: bill.unknownDetail, pct: pct(bill.unknownDetail), kind: "hatch" },
  ].filter((s) => s.value > 0.004);
}
export function limitSegments(limit) {
  const total = limit.total > 0 ? limit.total : 1;
  const known = Math.min(total, limit.knownCommitted);
  const estimatedUsed = Math.min(total, Math.max(known, total - limit.estimate.low));
  const uncertain = Math.max(0, estimatedUsed - known);
  const free = Math.max(0, total - estimatedUsed);
  const pct = (v) => (v / total) * 100;
  return [
    { key: "known", label: "Comprometido conhecido", value: known, pct: pct(known), kind: "ink" },
    { key: "uncertain", label: "Estimado, não reconciliado", value: uncertain, pct: pct(uncertain), kind: "hatch" },
    { key: "free", label: "Livre (mínimo estimado)", value: free, pct: pct(free), kind: "track" },
  ];
}
export function futureRowBars(row, scale) {
  const s = scale > 0 ? scale : 1;
  return { wInst: (row.installmentAmount / s) * 100, wPur: (row.purchasesAmount / s) * 100, wUnk: (row.unknownDetailAmount / s) * 100 };
}
// Degraus do comprometimento conhecido (viewBox 800x200; y cresce para baixo; topo = limite total).
export function commitmentChart(series, total) {
  const N = series.length;
  const yv = (v) => 200 - (total > 0 ? Math.min(1, Math.max(0, v / total)) : 0) * 200;
  let line = "";
  series.forEach((p, i) => {
    const y = yv(p.committed).toFixed(1);
    const x1 = (((i + 1) / N) * 800).toFixed(1);
    line += i === 0 ? `M0,${y} H${x1}` : ` V${y} H${x1}`;
  });
  const area = `${line} V200 H0 Z`;
  const points = series.map((p, i) => ({ x: (((i + 0.5) / N) * 100).toFixed(2), y: (yv(p.committed) / 2).toFixed(2), label: p.label, short: fmtS(p.committed), committed: p.committed, isNow: i === 0 }));
  return { line, area, points };
}
export function chartAlt(series, total) {
  return `Comprometimento conhecido do limite de ${fmt(total)}: ${series.map((p) => `${p.label} ${fmt(p.committed)}`).join(", ")}.`;
}
export function reliefHeadline(relief) {
  if (!relief?.hasInstallments) return { title: "O cartão está sem parcelas em andamento.", body: "Não há parcelas conhecidas nas próximas faturas." };
  const bits = [];
  bits.push(`Hoje são ${fmtS(relief.monthlyNow)}/mês.`);
  if (relief.endingBeforeZero > 0) bits.push(`${relief.endingBeforeZero === 1 ? "Uma compra termina" : `${relief.endingBeforeZero} compras terminam`} até lá${relief.zero ? `, e em ${relief.zero.monthLong} o cartão fica sem nenhuma parcela` : ""}.`);
  const title = relief.next ? `Em ${relief.next.monthLong} as parcelas caem para ${fmtS(relief.next.after)}/mês.` : `As parcelas seguem em ${fmtS(relief.monthlyNow)}/mês.`;
  return { title, body: bits.join(" ") };
}

// ---------- Caju ----------
export function dayBars(cycle) {
  if (!cycle) return [];
  return Array.from({ length: cycle.length }, (_, i) => ({ state: i < cycle.elapsed ? "past" : i === cycle.elapsed ? "today" : "future", key: i }));
}
export function cajuRateFor({ caju, mode, weekendReserve }) {
  const p = caju.pacing;
  if (mode === "save") return { daily: p.modes.save.daily, note: `até ${caju.recharge?.nextLabel ?? "a recarga"}`, desc: p.modes.save.note };
  if (mode === "wk" && caju.weekend?.available) {
    const wk = Math.min(caju.balance, Math.max(0, weekendReserve));
    const rest = caju.pacing.daysLeft - caju.weekend.weekendDays;
    return { daily: rest > 0 ? round2((caju.balance - wk) / rest) : null, note: `nos outros ${Math.max(0, rest)} dias`, desc: "Separa a reserva do fim de semana e divide o resto pelos outros dias." };
  }
  return { daily: p.modes.eq.daily, note: `até ${caju.recharge?.nextLabel ?? "a recarga"}`, desc: p.modes.eq.note };
}
export const MODES = [
  { key: "eq", label: "Equilibrado", short: "Igual" },
  { key: "save", label: "Guardar sobra", short: "Guardar" },
  { key: "wk", label: "Fim de semana", short: "FDS" },
];
export const cajuFacts = (caju) => (caju?.facts ? [{ k: "Recarga", v: `dia ${caju.facts.rechargeDay}` }, { k: "Valor", v: caju.facts.rechargeAmount != null ? fmtS(caju.facts.rechargeAmount) : "—" }, { k: "Faltam", v: caju.facts.daysLeft != null && caju.facts.daysLeft > 0 ? `${caju.facts.daysLeft} dias` : caju.recharge?.state === "DUE_TODAY" ? "hoje" : "—" }] : []);
const MON = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const dmon = (iso) => `${String(Number(iso.slice(8, 10))).padStart(2, "0")} ${MON[Number(iso.slice(5, 7)) - 1]}`;
export const itauFacts = (itau) => [{ k: "Fecha", v: dmon(itau.currentBill.closesAt) }, { k: "Vence", v: dmon(itau.currentBill.dueAt) }, { k: "Faltam", v: itau.currentBill.daysToDue > 0 ? `${itau.currentBill.daysToDue} dias` : itau.currentBill.daysToDue === 0 ? "hoje" : "vencida" }];
export const dayMonthUpper = (iso) => (iso ? dmon(iso).toUpperCase() : "—");
export const dmLabel = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
