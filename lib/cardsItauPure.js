// ============================================================================
// Fase 10 — CARTÃO ITAÚ: cálculos PUROS (sem Prisma, sem relógio implícito). Tudo aqui é determinístico e
// testável; lib/cardsItau.js só carrega os dados reais e chama estas funções.
//
// PROCEDÊNCIA DOS DADOS (auditoria da Fase 10):
//   AUTHORITATIVE  fatura corrente observada no banco (CardBillReconciliation.observedTotal) + o que foi
//                  lançado depois da observação; limite TOTAL informado (Card/CardLimitUpdate);
//                  parcelas cadastradas (Purchase/Installment); calendário do cartão (fecha/vence).
//   DERIVED        detalhamento da fatura (parcelas × compras avulsas × sem detalhamento), faturas futuras,
//                  alívio mensal, comprometimento conhecido do limite.
//   ESTIMATED      LIMITE DISPONÍVEL AGORA. O banco só foi observado numa data (âncora CardLimitUpdate); depois
//                  disso o Norte só conhece os lançamentos que ele próprio registrou. O gap conhecido da fatura
//                  (KNOWN_CARD_DETAIL_GAP) são compras do banco que o Norte não itemizou — elas ocupam limite
//                  mas não estão na derivação. Por isso o disponível é uma FAIXA (baixa/alta) + um TETO certo.
//   UNKNOWN        parcelas de compras não itemizadas (o Norte só sabe as que estão cadastradas); quando o
//                  banco recompõe o limite (assumimos: ao pagar cada fatura, e só isso).
// Nada aqui inventa compra para preencher o gap, nem distribui o gap em meses futuros.
// ============================================================================
import { addMonthKey } from "./formatMoney.js";
import { getCardBillClosesAt, getCardBillDueDate } from "./cardCycle.js";

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MONTHS_SHORT = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
const MONTHS_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const monthShort = (key) => `${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}/${key.slice(2, 4)}`;
export const monthLong = (key) => MONTHS_LONG[Number(key.slice(5, 7)) - 1];

// Descrições de compras vieram de mensagens cruas ("passei 363,60 reais no cartão de crédito, parcelado em 6x,
// aniversario da bia"). Só uma limpeza conservadora para exibir: nunca inventa merchant, e o texto original
// segue disponível em `rawDescription`.
export function cleanPurchaseName(description) {
  const raw = String(description ?? "").trim();
  if (!raw) return "Compra parcelada";
  if (raw.length <= 42 && !/\breais\b|\bparcelad/i.test(raw)) return raw;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const tail = parts.length > 1 ? parts[parts.length - 1] : raw;
  const cleaned = tail.replace(/^(no|na|em|de|do|da)\s+/i, "").trim();
  const pick = cleaned.length >= 3 && cleaned.length <= 48 ? cleaned : raw.slice(0, 44).trim() + "…";
  return pick.charAt(0).toUpperCase() + pick.slice(1);
}

// Agrupa parcelas por compra e resolve o estado em relação ao ciclo da fatura corrente.
// purchases: [{ id, description, totalAmount, installmentCount, installmentValue, installments:[{number, amount, billMonth}] }]
export function buildActiveInstallments(purchases, currentCycle) {
  const out = [];
  for (const p of purchases) {
    const rows = [...p.installments].sort((a, b) => a.number - b.number);
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    if (last.billMonth < currentCycle) continue; // já terminou (todas as parcelas em faturas anteriores)
    const inCurrent = rows.find((r) => r.billMonth === currentCycle);
    const upcoming = rows.find((r) => r.billMonth > currentCycle);
    const current = inCurrent ?? upcoming ?? last;
    const after = rows.filter((r) => r.billMonth > currentCycle);
    const billedBefore = rows.filter((r) => r.billMonth < currentCycle).length;
    out.push({
      id: p.id,
      name: cleanPurchaseName(p.description),
      rawDescription: p.description,
      totalAmount: round2(p.totalAmount),
      installmentCount: p.installmentCount,
      installmentValue: round2(p.installmentValue),
      currentNumber: current.number,
      billedBefore, // parcelas de faturas anteriores à corrente
      currentInThisBill: !!inCurrent,
      endMonth: last.billMonth,
      endLabel: monthLong(last.billMonth),
      endShort: monthShort(last.billMonth),
      remainingAmount: round2(after.reduce((a, r) => a + Number(r.amount), 0)), // ainda por vir (depois da fatura corrente)
      remainingCount: after.length,
      firstMonth: rows[0].billMonth,
    });
  }
  return out.sort((a, b) => a.endMonth.localeCompare(b.endMonth) || a.name.localeCompare(b.name));
}

// FUTURO DAS FATURAS. `currentBill` = fatura relevante (a primeira ainda não liquidada). Meses seguintes usam SÓ
// o que o Norte conhece: parcelas cadastradas + compras avulsas já lançadas naquele ciclo (nunca o total
// armazenado antigo, nunca uma distribuição do gap).
export function buildFutureBills({ card, currentCycle, currentBill, installmentRows, futureExpenseByCycle = {}, minRows = 4, maxRows = 12 }) {
  const byCycle = new Map();
  const ending = new Map();
  for (const r of installmentRows) {
    byCycle.set(r.billMonth, round2((byCycle.get(r.billMonth) ?? 0) + Number(r.amount)));
    if (r.isLast) ending.set(r.billMonth, [...(ending.get(r.billMonth) ?? []), r.purchaseName]);
  }
  const lastInstallmentMonth = installmentRows.reduce((m, r) => (r.billMonth > m ? r.billMonth : m), currentCycle);
  let endMonth = lastInstallmentMonth >= addMonthKey(currentCycle, minRows - 2) ? addMonthKey(lastInstallmentMonth, 1) : addMonthKey(currentCycle, minRows - 1);
  const keys = [];
  for (let k = currentCycle; k <= endMonth && keys.length < maxRows; k = addMonthKey(k, 1)) keys.push(k);

  const rows = keys.map((cycleMonth, i) => {
    const installmentAmount = i === 0 ? round2(currentBill.installments) : round2(byCycle.get(cycleMonth) ?? 0);
    const purchasesAmount = i === 0 ? round2(currentBill.purchases) : round2(futureExpenseByCycle[cycleMonth] ?? 0);
    const unknownDetailAmount = i === 0 ? round2(currentBill.unknownDetail) : 0;
    const total = i === 0 ? round2(currentBill.total) : round2(installmentAmount + purchasesAmount);
    return {
      cycleMonth,
      label: monthShort(cycleMonth),
      monthLong: monthLong(cycleMonth),
      closesAt: getCardBillClosesAt(card, cycleMonth),
      dueAt: getCardBillDueDate(card, cycleMonth),
      isCurrent: i === 0,
      tag: i === 0 ? (currentBill.isClosed ? "fatura fechada" : "fatura atual") : total > 0 ? "já carimbado" : "livre",
      installmentAmount,
      purchasesAmount,
      unknownDetailAmount,
      knownCommittedAmount: round2(installmentAmount + purchasesAmount),
      total,
      installmentsEnding: (ending.get(cycleMonth) ?? []).sort(),
      releasedVsPrevious: 0,
      note: i === 0 && unknownDetailAmount > 0 ? "sem detalhamento individual" : null,
    };
  });
  for (let i = 1; i < rows.length; i++) rows[i].releasedVsPrevious = Math.max(0, round2(rows[i - 1].installmentAmount - rows[i].installmentAmount));
  return rows;
}

// QUANDO O CARTÃO VOLTA A RESPIRAR — só parcelas conhecidas, meses de calendário reais.
export function buildRelief(rows, activeCount) {
  const monthlyNow = rows[0]?.installmentAmount ?? 0;
  if (!rows.length || monthlyNow <= 0) return { hasInstallments: false, monthlyNow: 0, activeCount: 0 };
  const firstRelief = rows.slice(1).find((r) => r.releasedVsPrevious > 0) ?? null;
  const biggest = rows.slice(1).reduce((b, r) => (r.releasedVsPrevious > (b?.releasedVsPrevious ?? 0) ? r : b), null);
  const zero = rows.slice(1).find((r) => r.installmentAmount <= 0) ?? null;
  return {
    hasInstallments: true,
    monthlyNow,
    activeCount,
    next: firstRelief && { cycleMonth: firstRelief.cycleMonth, label: firstRelief.label, monthLong: firstRelief.monthLong, released: firstRelief.releasedVsPrevious, after: firstRelief.installmentAmount },
    biggest: biggest && { cycleMonth: biggest.cycleMonth, label: biggest.label, monthLong: biggest.monthLong, released: biggest.releasedVsPrevious },
    zero: zero && { cycleMonth: zero.cycleMonth, label: zero.label, monthLong: zero.monthLong },
    endingBeforeZero: rows.reduce((n, r) => n + r.installmentsEnding.length, 0),
  };
}

// COMPROMETIMENTO CONHECIDO AO LONGO DO TEMPO. Cada ponto = quanto do limite o Norte sabe estar comprometido
// DEPOIS de pagar a fatura daquele mês (nada de curva de "limite livre exato": o banco decide a recomposição).
export function buildCommitmentSeries({ rows, currentRemaining, totalLimit, maxPoints = 8 }) {
  const futureAfter = (i) => round2(rows.slice(i + 1).reduce((a, r) => a + r.knownCommittedAmount, 0));
  const pts = [{ label: "HOJE", committed: round2(currentRemaining + futureAfter(0)), cycleMonth: null }];
  rows.forEach((r, i) => pts.push({ label: r.label.slice(0, 3), cycleMonth: r.cycleMonth, committed: futureAfter(i) }));
  return pts.slice(0, maxPoints).map((p) => ({ ...p, pctOfLimit: totalLimit > 0 ? round2((p.committed / totalLimit) * 100) : 0 }));
}

// LIMITE: total (informado), observação do banco (âncora), derivação do Norte, comprometimento conhecido, teto
// e faixa estimada. `derivedUsed` = computeCardUsedLimit (âncora + lançamentos do Norte desde ela).
export function computeLimitKnowledge({ totalLimit, anchor, derivedUsed, currentRemaining, futureKnown, knownDetailGap = 0, now = new Date() }) {
  const total = round2(totalLimit);
  const clamp = (v) => Math.min(total, Math.max(0, round2(v)));
  const derivedAvailable = clamp(total - derivedUsed);
  const knownCommitted = round2(currentRemaining + futureKnown);
  const ceilingAvailable = clamp(total - knownCommitted); // o banco NÃO pode ter MAIS que isto livre (o comprometido conhecido é piso do usado real)
  const high = Math.min(derivedAvailable, ceilingAvailable);
  const low = Math.min(high, clamp(derivedAvailable - knownDetailGap));
  const observed = anchor
    ? {
        availableAtObservation: anchor.reportedAvailable != null ? round2(anchor.reportedAvailable) : clamp(total - Number(anchor.newUsedLimit)),
        usedAtObservation: round2(anchor.newUsedLimit),
        asOf: anchor.occurredAt instanceof Date ? anchor.occurredAt.toISOString() : anchor.occurredAt,
        source: anchor.source ?? null,
        confidence: anchor.confidence ?? null,
        daysAgo: Math.max(0, Math.round((now.getTime() - new Date(anchor.occurredAt).getTime()) / 86400000)),
      }
    : null;
  return {
    total,
    totalSource: "INFORMADO_PELO_USUARIO",
    bankObservation: observed,
    derivedAvailable,
    knownCommitted,
    knownDetailGap: round2(knownDetailGap),
    ceilingAvailable,
    estimate: { low, high },
    availableStatus: "NOT_RECONCILED", // não existe fonte autoritativa de "limite disponível agora"
    confidence: "ESTIMATED",
  };
}

// CABE NO LIMITE — responde SÓ "o banco comporta esta compra?". O valor INTEIRO da compra ocupa o limite
// (mesmo parcelado). Estados honestos, nunca um sim/não falso:
//   EXCEEDS        > teto: impossível caber (certo, pois o comprometido conhecido é piso do usado real)
//   UNLIKELY       > faixa alta do estimado, mas ≤ teto
//   UNCERTAIN      entre a faixa baixa e a alta
//   FITS_LIKELY    ≤ faixa baixa (estimativa conservadora)
export function evaluateCardCapacity(knowledge, amount) {
  const required = round2(amount);
  const { ceilingAvailable, estimate } = knowledge;
  let status;
  let confidence;
  if (required > ceilingAvailable + 0.004) { status = "EXCEEDS"; confidence = "HIGH"; }
  else if (required > estimate.high + 0.004) { status = "UNLIKELY"; confidence = "ESTIMATED"; }
  else if (required > estimate.low + 0.004) { status = "UNCERTAIN"; confidence = "ESTIMATED"; }
  else { status = "FITS_LIKELY"; confidence = "ESTIMATED"; }
  return {
    status,
    confidence,
    requiredLimit: required,
    availableLimit: { status: knowledge.availableStatus, low: estimate.low, high: estimate.high, ceiling: ceilingAvailable },
    shortfallVsCeiling: status === "EXCEEDS" ? round2(required - ceilingAvailable) : 0,
  };
}

// Compra em `n` parcelas: valor da parcela com a MESMA regra do simulador/compra real (arredonda a parcela).
export function installmentValueOf(amount, n) {
  return round2(round2(amount) / Math.max(1, n));
}
