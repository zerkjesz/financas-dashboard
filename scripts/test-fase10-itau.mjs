// Fase 10 — ITAÚ (área Cartões v5): fatura observada autoritativa, gap preservado (nunca vira compra), competência
// da compra por fechamento, faturas futuras, alívio mensal, limite honesto (faixa + teto), cabe no limite ≠ cabe
// no orçamento, simulador compartilhado (contexto == sem contexto), busca de capacidade determinística e ZERO
// escrita. Fixtures MARK (cartão, compras, parcelas, despesas, reconciliação próprios); relógio controlado.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney } from "../lib/money.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";
import { buildItauModel } from "../lib/cardsItau.js";
import { buildCardsAreaModel } from "../lib/cardsArea.js";
import { buildFutureBills, buildRelief, buildCommitmentSeries, computeLimitKnowledge, evaluateCardCapacity, buildActiveInstallments, cleanPurchaseName, installmentValueOf } from "../lib/cardsItauPure.js";
import { simulateFinancialScenario, prepareSimulationContext } from "../lib/simulation/financialSimulator.js";
import { evaluatePurchase, computeBudgetCaps, clearCapacityContextCache } from "../lib/cardPurchaseCapacity.js";
import { computeInstallmentScheduleRows } from "../lib/installments.js";

const MARK = "TESTE_F10";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const n = (x) => Number(serializeMoney(money(x)));
const near = (a, b, e = 0.005) => Math.abs(Number(a) - Number(b)) <= e;
const NOW = new Date("2026-09-26T15:00:00.000Z"); // 26/09/2026 12:00 (-03) => ciclo corrente 2026-10 (fecha 04/10)
const created = { card: null, purchases: [], reconciliation: null };

async function counts() {
  const c = await Promise.all(["purchase", "installment", "expense", "income", "transfer", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "bill", "telegramCorrectionAudit", "balanceAdjustment"].map((m) => prisma[m].count()));
  return JSON.stringify(c);
}

async function mkPurchase({ description, count, value, firstMonth, purchasedAt }) {
  const total = value * count;
  const rows = computeInstallmentScheduleRows({ totalAmount: money(total), installmentCount: count, installmentValue: money(value), firstInstallmentMonth: firstMonth, startingInstallmentNumber: 1 });
  const p = await prisma.purchase.create({
    data: { description: `${MARK} ${description}`, totalAmount: total, installmentCount: count, installmentValue: value, cardId: created.card.id, firstInstallmentMonth: firstMonth, purchasedAt: new Date(purchasedAt), source: "manual", installments: { create: rows.map((r) => ({ number: r.number, amount: r.amount, billMonth: r.billMonth })) } },
  });
  created.purchases.push(p.id);
  return p;
}

async function cleanup() {
  if (created.card) {
    await prisma.cardBillReconciliation.deleteMany({ where: { cardId: created.card.id } }).catch(() => {});
    await prisma.expense.deleteMany({ where: { cardId: created.card.id } }).catch(() => {});
    await prisma.installment.deleteMany({ where: { purchaseId: { in: created.purchases } } }).catch(() => {});
    await prisma.purchase.deleteMany({ where: { cardId: created.card.id } }).catch(() => {});
    await prisma.cardBill.deleteMany({ where: { cardId: created.card.id } }).catch(() => {});
    await prisma.cardLimitUpdate.deleteMany({ where: { cardId: created.card.id } }).catch(() => {});
    await prisma.card.deleteMany({ where: { id: created.card.id } }).catch(() => {});
  }
  const left = await Promise.all([prisma.card.count({ where: { slug: { contains: "teste-f10" } } }), prisma.purchase.count({ where: { description: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((c) => c === 0), JSON.stringify(left));
}

async function main() {
  // ================= PUROS =================
  const card = { closingDay: 4, dueDay: 11 };
  check("[COMPETÊNCIA] compra ANTES do fechamento (03/10) cai na fatura que fecha em outubro (2026-10)", getCardCycleForDate(card, new Date("2026-10-03T12:00:00Z")) === "2026-10");
  check("[COMPETÊNCIA] compra NO DIA do fechamento (04/10): último dia inclusivo do ciclo => 2026-10 (convenção documentada em cardCycle.js)", getCardCycleForDate(card, new Date("2026-10-04T12:00:00Z")) === "2026-10");
  check("[COMPETÊNCIA] compra DEPOIS do fechamento (05/10) cai na fatura seguinte (2026-11)", getCardCycleForDate(card, new Date("2026-10-05T12:00:00Z")) === "2026-11");
  check("[COMPETÊNCIA] virada de ano: compra 10/12 => 2027-01; nunca mês civil puro", getCardCycleForDate(card, new Date("2026-12-10T12:00:00Z")) === "2027-01");
  check("[NOMES] descrição crua de mensagem vira nome curto; texto original preservado em rawDescription", cleanPurchaseName("passei 363,60 reais no cartão de crédito, parcelado em 6x, aniversario da bia") === "Aniversario da bia" && cleanPurchaseName("Mercado Livre — Controle do portão") === "Mercado Livre — Controle do portão");
  check("[LIMITE] valor da parcela = mesma regra do simulador/compra real (arredondada)", installmentValueOf(100, 3) === 33.33 && installmentValueOf(600, 3) === 200 && installmentValueOf(50, 1) === 50);
  const kNoAnchor = computeLimitKnowledge({ totalLimit: 1000, anchor: null, derivedUsed: 200, currentRemaining: 150, futureKnown: 50, knownDetailGap: 0, now: NOW });
  check("[LIMITE] sem observação do banco: derivado = estimativa (sem faixa), NÃO reconciliado, confiança ESTIMATED, sem bankObservation", kNoAnchor.bankObservation === null && kNoAnchor.availableStatus === "NOT_RECONCILED" && kNoAnchor.confidence === "ESTIMATED" && kNoAnchor.estimate.low === kNoAnchor.estimate.high && kNoAnchor.derivedAvailable === 800);
  const kNeg = computeLimitKnowledge({ totalLimit: 1000, anchor: null, derivedUsed: 1500, currentRemaining: 1400, futureKnown: 500, knownDetailGap: 700, now: NOW });
  check("[LIMITE] nunca negativo nem acima do limite total; low <= high <= teto", kNeg.derivedAvailable === 0 && kNeg.ceilingAvailable === 0 && kNeg.estimate.low === 0 && kNeg.estimate.high === 0);
  const k = computeLimitKnowledge({ totalLimit: 5000, anchor: { newUsedLimit: 3000, reportedAvailable: 2000, occurredAt: new Date("2026-09-04T23:59:59Z"), source: "manual", confidence: "CONFIRMED" }, derivedUsed: 3120, currentRemaining: 730, futureKnown: 1190, knownDetailGap: 300, now: NOW });
  check("[LIMITE] faixa: baixa = derivado − gap; alta = min(derivado, teto); teto = total − comprometido conhecido", k.estimate.low === 1580 && k.estimate.high === 1880 && k.ceilingAvailable === 3080 && k.knownCommitted === 1920, JSON.stringify(k.estimate));
  check("[LIMITE] observação do banco preservada como VERDADE DAQUELA DATA (2.000 em 04/09, há 22 dias), separada da estimativa atual", k.bankObservation.availableAtObservation === 2000 && k.bankObservation.daysAgo === 22 && k.bankObservation.confidence === "CONFIRMED");
  const caps = (a) => evaluateCardCapacity(k, a);
  check("[CABE NO LIMITE] ≤ faixa baixa => FITS_LIKELY (estimativa, nunca HIGH)", caps(1500).status === "FITS_LIKELY" && caps(1500).confidence === "ESTIMATED");
  check("[CABE NO LIMITE] entre baixa e alta => UNCERTAIN; entre alta e teto => UNLIKELY", caps(1700).status === "UNCERTAIN" && caps(2500).status === "UNLIKELY");
  check("[CABE NO LIMITE] acima do TETO => EXCEEDS com confiança HIGH (impossível caber) e falta calculada", caps(3200).status === "EXCEEDS" && caps(3200).confidence === "HIGH" && caps(3200).shortfallVsCeiling === 120);
  check("[CABE NO LIMITE] o valor INTEIRO ocupa o limite mesmo parcelado (requiredLimit = total)", caps(1200).requiredLimit === 1200 && evaluateCardCapacity(k, 1200).availableLimit.status === "NOT_RECONCILED");
  check("[SEM MOCK] 'limite disponível' nunca é apresentado como observado/exato (availableStatus NOT_RECONCILED)", k.availableStatus === "NOT_RECONCILED");

  // ================= COM BANCO (fixtures MARK) =================
  created.card = await prisma.card.create({ data: { slug: "teste-f10-card", name: `${MARK} Itaú`, totalLimit: 5000, closingDay: 4, dueDay: 11 } });
  await prisma.cardLimitUpdate.create({ data: { cardId: created.card.id, newTotalLimit: 5000, newUsedLimit: 3000, reportedAvailable: 2000, note: MARK, source: "manual", confidence: "CONFIRMED", occurredAt: new Date("2026-09-04T23:59:59.999Z") } });
  const A = await mkPurchase({ description: "Notebook", count: 3, value: 100, firstMonth: "2026-09", purchasedAt: "2026-08-20T12:00:00Z" }); // set/out/nov
  const B = await mkPurchase({ description: "Fone", count: 2, value: 50, firstMonth: "2026-10", purchasedAt: "2026-08-20T12:00:00Z" }); // out/nov
  const C = await mkPurchase({ description: "Geladeira", count: 6, value: 200, firstMonth: "2026-10", purchasedAt: "2026-08-20T12:00:00Z" }); // out..mar/27
  await prisma.expense.create({ data: { amount: 80, description: `${MARK} Mercado (cartão)`, category: "Outros", accountId: null, cardId: created.card.id, occurredAt: new Date("2026-09-10T00:00:00Z"), source: "manual" } });
  await prisma.expense.create({ data: { amount: 40, description: `${MARK} Compra depois do fechamento`, category: "Outros", cardId: created.card.id, occurredAt: new Date("2026-10-06T00:00:00Z"), source: "manual" } });
  // a fatura de setembro (1ª parcela do Notebook) já foi PAGA — senão o motor a trata como "primeira não liquidada"
  await prisma.cardBill.create({ data: { cardId: created.card.id, cycleMonth: "2026-09", closesAt: new Date("2026-09-04T00:00:00Z"), dueAt: new Date("2026-09-11T00:00:00Z"), totalAmount: 100, status: "paid", paidAmount: 100, paidAt: new Date("2026-09-11T12:00:00Z") } });
  // cálculo conhecido do ciclo 2026-10: parcelas 100+50+200 = 350 + compra 80 = 430; observado no banco: 730 (gap 300)
  await prisma.cardBillReconciliation.create({ data: { cardId: created.card.id, cycleMonth: "2026-10", observedTotal: 730, calculatedTotal: 430, delta: 300, note: `${MARK} observado`, source: "manual", confidence: "CONFIRMED", occurredAt: new Date("2026-09-25T12:00:00Z") } });

  const before = await counts();
  const m = await buildItauModel({ cardId: created.card.id, now: NOW });
  const b = m.currentBill;

  check("[FATURA] a fatura observada é AUTORITATIVA: total 730, fonte 'observed'", b.total === 730 && b.totalSource === "observed" && b.cycleMonth === "2026-10");
  check("[FATURA] composição: parcelas 350 + compras avulsas 80 + sem detalhamento 300 = 730", b.installments === 350 && b.purchases === 80 && b.unknownDetail === 300 && near(b.installments + b.purchases + b.unknownDetail, b.total));
  check("[GAP] KNOWN_CARD_DETAIL_GAP preservado (300) e NENHUMA compra fake foi criada (contagens idênticas)", b.unknownDetail === 300 && (await counts()) === before);
  check("[GAP] o gap pertence só à fatura corrente: faturas futuras têm 0 de 'sem detalhamento' (nunca distribuído)", m.futureBills.slice(1).every((r) => r.unknownDetailAmount === 0) && m.futureBills[0].unknownDetailAmount === 300);
  check("[CALENDÁRIO] fecha 04/10, vence 11/10; faltam 15 dias para vencer (relógio 26/09)", b.closesAt === "2026-10-04" && b.dueAt === "2026-10-11" && b.daysToClose === 8 && b.daysToDue === 15 && b.isClosed === false);

  const rows = m.futureBills;
  const by = Object.fromEntries(rows.map((r) => [r.cycleMonth, r]));
  check("[FUTURAS] novembro = parcelas 350 (Notebook 100 + Fone 50 + Geladeira 200) + compra já lançada depois do fechamento 40 = 390", by["2026-11"].installmentAmount === 350 && by["2026-11"].purchasesAmount === 40 && by["2026-11"].total === 390);
  check("[FUTURAS] dezembro a março: só a Geladeira (200/mês); abril: livre (0)", ["2026-12", "2027-01", "2027-02", "2027-03"].every((c) => by[c].installmentAmount === 200 && by[c].total === 200) && by["2027-04"] && by["2027-04"].total === 0 && by["2027-04"].tag === "livre");
  check("[FUTURAS] meses reais do calendário, sem hardcode: primeira linha = ciclo corrente; ordem crescente contígua", rows[0].cycleMonth === "2026-10" && rows.every((r, i) => i === 0 || r.cycleMonth > rows[i - 1].cycleMonth) && rows[0].isCurrent && rows[0].tag === "fatura atual");
  check("[ALÍVIO MENSAL] dezembro libera 150 (Notebook 100 + Fone 50 terminam em novembro); abril libera 200", by["2026-12"].releasedVsPrevious === 150 && by["2027-04"].releasedVsPrevious === 200 && by["2026-11"].releasedVsPrevious === 0);
  check("[PARCELA TERMINANDO] novembro tem 'última de' Fone e Notebook; março tem a Geladeira", JSON.stringify(by["2026-11"].installmentsEnding) === JSON.stringify([`${MARK} Fone`, `${MARK} Notebook`]) && JSON.stringify(by["2027-03"].installmentsEnding) === JSON.stringify([`${MARK} Geladeira`]));
  const rel = m.relief;
  check("[RELIEF] hoje 350/mês; próximo alívio em dezembro (+150 → 200/mês); zera em abril/27; 3 compras ativas", rel.monthlyNow === 350 && rel.next.cycleMonth === "2026-12" && rel.next.released === 150 && rel.next.after === 200 && rel.zero.cycleMonth === "2027-04" && rel.activeCount === 3);
  check("[RELIEF] maior alívio = abril (+200)", rel.biggest.cycleMonth === "2027-04" && rel.biggest.released === 200);
  check("[RELIEF] sem parcelas: estado vazio honesto (não inventa alívio)", buildRelief([{ installmentAmount: 0, releasedVsPrevious: 0, installmentsEnding: [] }], 0).hasInstallments === false);
  const ser = m.commitmentSeries;
  check("[SÉRIE] comprometimento conhecido: HOJE 1.920 (fatura 730 + futuras 1.190); depois de pagar out: 1.190; zera após março", ser[0].committed === 1920 && ser[1].committed === 1190 && ser.find((p) => p.cycleMonth === "2027-03").committed === 0);
  check("[SÉRIE] nunca apresentada como 'limite livre exato': só comprometimento conhecido e % do limite", ser.every((p) => "committed" in p && "pctOfLimit" in p && !("free" in p)));

  // parcelamentos ativos reais
  const inst = m.installments;
  const geladeira = inst.find((p) => p.name === `${MARK} Geladeira`);
  check("[PARCELAMENTOS] 3 ativos, ordenados por término; Geladeira: 6x de 200, parcela 1/6 na fatura atual, termina em março, faltam 1.000", inst.length === 3 && inst[inst.length - 1].name === `${MARK} Geladeira` && geladeira.installmentCount === 6 && geladeira.installmentValue === 200 && geladeira.currentNumber === 1 && geladeira.endLabel === "março" && geladeira.remainingAmount === 1000);
  const notebook = inst.find((p) => p.name === `${MARK} Notebook`);
  check("[PARCELAMENTOS] Notebook: parcela 2/3 (a 1ª foi na fatura anterior), termina em novembro, faltam 100", notebook.currentNumber === 2 && notebook.billedBefore === 1 && notebook.endLabel === "novembro" && notebook.remainingAmount === 100);
  check("[PARCELAMENTOS] compra totalmente faturada em ciclos anteriores não aparece como ativa", buildActiveInstallments([{ id: "x", description: "Velha", totalAmount: 100, installmentCount: 2, installmentValue: 50, installments: [{ number: 1, amount: 50, billMonth: "2026-07" }, { number: 2, amount: 50, billMonth: "2026-08" }] }], "2026-10").length === 0);

  const lim = m.limit;
  check("[LIMITE REAL] total 5.000; comprometido conhecido 1.920; teto 3.080; faixa 1.580–1.880; NOT_RECONCILED", lim.total === 5000 && lim.knownCommitted === 1920 && lim.ceilingAvailable === 3080 && lim.estimate.low === 1580 && lim.estimate.high === 1880 && lim.availableStatus === "NOT_RECONCILED");
  check("[LIMITE REAL] observação do banco (2.000 em 04/09) exposta como tal, separada do estimado", lim.bankObservation.availableAtObservation === 2000 && lim.bankObservation.asOf.startsWith("2026-09-04"));

  // ================= MOTOR / SIMULADOR COMPARTILHADO =================
  clearCapacityContextCache();
  const ctx = await prepareSimulationContext({ now: NOW, cardId: created.card.id });
  const plain = await simulateFinancialScenario({ now: NOW, scenario: { type: "CARD_PURCHASE_INSTALLMENTS", cardId: created.card.id, totalAmount: 900, installmentCount: 3 } });
  const shared = await simulateFinancialScenario({ now: NOW, scenario: { type: "CARD_PURCHASE_INSTALLMENTS", cardId: created.card.id, totalAmount: 900, installmentCount: 3 }, context: ctx });
  check("[SIMULADOR COMPARTILHADO] com contexto pré-carregado == sem contexto (freeMoney, safeToSpend, status, veredito, fluxo de caixa)", near(n(plain.simulated.freeMoney), n(shared.simulated.freeMoney)) && near(n(plain.simulated.safeToSpend), n(shared.simulated.safeToSpend)) && plain.simulated.status.status === shared.simulated.status.status && plain.verdict === shared.verdict && JSON.stringify(plain.delta.projectionCheckpoints.base, (k, v) => (v && v.d ? n(v) : v)) === JSON.stringify(shared.delta.projectionCheckpoints.base, (k, v) => (v && v.d ? n(v) : v)));
  const ev = await evaluatePurchase({ cardId: created.card.id, amount: 900, installments: 3, knowledge: lim, context: ctx });
  check("[COMPAT /simulador] o orçamento de /cartoes usa a MESMA simulação: projectedFreeMoney e veredito idênticos ao do /simulador", near(ev.budgetCapacity.projectedFreeMoney, n(plain.simulated.freeMoney)) && ev.budgetCapacity.status === plain.budgetSafety.verdict && near(ev.budgetCapacity.baselineFreeMoney, n(plain.baseline.freeMoney)));
  check("[COMPAT /simulador] impacto mensal = parcela (900/3=300); pior momento do caixa reportado; limite e orçamento SEPARADOS", ev.installmentAmount === 300 && ev.budgetCapacity.monthlyImpact === 300 && !!ev.budgetCapacity.worstMonth && !!ev.cardCapacity.status && ev.cardCapacity !== ev.budgetCapacity);
  check("[COMPRA À VISTA] 1x usa CARD_PURCHASE_SINGLE: 1 parcela, valor cheio", (await evaluatePurchase({ cardId: created.card.id, amount: 400, installments: 1, knowledge: lim, context: ctx })).installmentSchedule.length === 1);
  const ev2 = await evaluatePurchase({ cardId: created.card.id, amount: 600, installments: 2, knowledge: lim, context: ctx });
  check("[PARCELAMENTO 2x] duas parcelas de 300 em faturas consecutivas (competência real pelo fechamento)", ev2.installmentSchedule.length === 2 && ev2.installmentSchedule[0].amount === 300 && ev2.installmentSchedule[1].billMonth > ev2.installmentSchedule[0].billMonth);
  const ev6 = await evaluatePurchase({ cardId: created.card.id, amount: 1200, installments: 6, knowledge: lim, context: ctx });
  const months = ev6.installmentSchedule.map((r) => r.billMonth);
  check("[MULTI-CICLO] 6x: 6 faturas distintas, sequenciais, com vencimento real (dueAt) de cada ciclo", new Set(months).size === 6 && months.every((mo, i) => i === 0 || mo > months[i - 1]) && ev6.installmentSchedule.every((r) => /^2026-|^2027-/.test(r.dueAt)));
  const evLim = await evaluatePurchase({ cardId: created.card.id, amount: 3500, installments: 10, knowledge: lim, context: ctx });
  check("[CABE NO LIMITE ≠ ORÇAMENTO] 3.500 em 10x: não cabe no limite (EXCEEDS) independentemente do orçamento, e os dois resultados são campos distintos", evLim.cardCapacity.status === "EXCEEDS" && typeof evLim.budgetCapacity.status === "string");

  // busca de capacidade
  const t0 = Date.now();
  const capsByN = await computeBudgetCaps({ cardId: created.card.id, knowledge: lim, context: ctx, hi: lim.total });
  const ms = Date.now() - t0;
  check("[CAPACIDADE] tetos por parcelamento calculados por busca binária determinística, rápido em memória (< 5s)", [1, 2, 3, 6, 10].every((k) => Number.isInteger(capsByN[k]) && capsByN[k] >= 0) && ms < 5000, `${ms}ms ${JSON.stringify(capsByN)}`);
  const safeAt = async (amt, k) => (await simulateFinancialScenario({ now: NOW, scenario: k === 1 ? { type: "CARD_PURCHASE_SINGLE", cardId: created.card.id, amount: amt } : { type: "CARD_PURCHASE_INSTALLMENTS", cardId: created.card.id, totalAmount: amt, installmentCount: k }, context: ctx })).budgetSafety.verdict === "SAFE";
  let boundaryOk = true, monotonicOk = true;
  for (const k of [1, 3, 10]) {
    const c = capsByN[k];
    if (c > 0 && !(await safeAt(c, k))) boundaryOk = false;
    if (c < lim.total && (await safeAt(c + 1, k))) boundaryOk = false;
    let prev = true;
    for (const a of [50, 200, 500, 900, 1500, 2500, 4000]) { const s = await safeAt(a, k); if (s && !prev) monotonicOk = false; prev = s; }
  }
  check("[CAPACIDADE] fronteira exata: cap é SAFE e cap+1 não é (ou bate no limite total)", boundaryOk);
  check("[CAPACIDADE] monotônica: se um valor é inseguro, valores maiores também são (pressuposto da busca)", monotonicOk);
  check("[CAPACIDADE] mais parcelas nunca reduzem o teto de orçamento (1x ≤ 2x ≤ 3x ≤ 6x ≤ 10x)", capsByN[1] <= capsByN[2] && capsByN[2] <= capsByN[3] && capsByN[3] <= capsByN[6] && capsByN[6] <= capsByN[10]);
  const again = await computeBudgetCaps({ cardId: created.card.id, knowledge: lim, context: ctx, hi: lim.total });
  check("[CAPACIDADE] determinística: duas execuções dão exatamente os mesmos tetos", JSON.stringify(again) === JSON.stringify(capsByN));

  // read-only
  const beforeRead = await counts();
  await buildItauModel({ cardId: created.card.id, now: NOW });
  await buildCardsAreaModel({ now: NOW });
  await evaluatePurchase({ cardId: created.card.id, amount: 700, installments: 2, knowledge: lim, context: ctx });
  await computeBudgetCaps({ cardId: created.card.id, knowledge: lim, context: ctx, hi: 1000 });
  check("[ZERO ESCRITA] read-model, simulação e busca de capacidade não escrevem nada (contagens idênticas em 11 tabelas)", (await counts()) === beforeRead);
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
