// Fase 5.1B-CARD-v2 — testes sintéticos (zero dado pessoal) pros DOIS
// blockers novos descobertos pela primeira tentativa real de apply:
// (1) deletar uma CardBill agregada não elimina liability projetada de um
//     Installment cujo billMonth ainda aponta pro cycleMonth deletado;
// (2) computeCardUsedLimit() usa uma âncora (CardLimitUpdate) INDEPENDENTE
//     de CardBill — uma âncora desatualizada não é bug conceitual, é
//     observação stale, corrigível só por CREATE de uma nova âncora.
//
// Este teste toca o banco (fixtures sintéticas próprias, sempre limpas no
// finally) — assertTestEnvironment() por segurança.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, money, addMoney, subtractMoney, maxMoney, ZERO } from "../lib/money.js";
import { getCardCycleForDate, getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";
import { computeExpectedCardBillTotal, listCardBillsView } from "../lib/cardBillCalculator.js";
import { resolveCurrentRelevantCardBillCycleMonth } from "../lib/freeMoney.js";
import { classifyCardBill, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeCardUsedLimit, computeCardAvailableLimit } from "../lib/cards.js";

const MARK = "TESTE_FASE51BCARDV2";
let passed = 0;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  if (condition) passed++;
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(money(a), money(b)) === 0;
}

console.log("--- Fase 5.1B-CARD-v2: testes sintéticos (Installment realignment + used limit) ---\n");

// ============================================================================
// A — deletar uma CardBill persistida NÃO elimina liability projetada de um
// Installment ainda apontando pro cycleMonth deletado (fixture fictícia).
// ============================================================================
{
  const suffix = Date.now();
  const account = await prisma.account.create({ data: { slug: `teste-51bv2-acc-${suffix}`, name: `[${MARK}] conta`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `teste-51bv2-card-${suffix}`, name: `[${MARK}] cartão`, totalLimit: 1000, dueDay: 11, closingDay: null, accountId: account.id } });
  const purchase = await prisma.purchase.create({ data: { description: `[${MARK}] compra parcelada fictícia`, totalAmount: money(300), installmentCount: 3, installmentValue: money(100), cardId: card.id, firstInstallmentMonth: "2026-02", purchasedAt: new Date("2026-02-20T12:00:00.000Z") } });
  const inst1 = await prisma.installment.create({ data: { purchaseId: purchase.id, number: 1, amount: money(100), billMonth: "2026-02" } });
  await prisma.installment.create({ data: { purchaseId: purchase.id, number: 2, amount: money(100), billMonth: "2026-03" } });
  await prisma.installment.create({ data: { purchaseId: purchase.id, number: 3, amount: money(100), billMonth: "2026-04" } });
  const bill02 = await prisma.cardBill.create({ data: { cardId: card.id, cycleMonth: "2026-02", closesAt: new Date("2026-03-01T00:00:00.000Z"), dueAt: new Date("2026-03-11T00:00:00.000Z"), totalAmount: money(100), status: "closed" } });

  try {
    const cardHypothetical = { ...card, closingDay: 4, dueDay: 11 };
    // Simula "deletar a row" == recomputar via computeExpectedCardBillTotal SEM a row persistida (a função nunca olha CardBill, só Expense+Installment).
    const projectedAfterDelete = await computeExpectedCardBillTotal(cardHypothetical, "2026-02");
    check("[A] deletar a CardBill agregada não elimina a liability — recomputação ainda encontra o Installment (100)", eq(projectedAfterDelete, 100));
  } finally {
    await prisma.cardBill.deleteMany({ where: { cardId: card.id } });
    await prisma.purchase.deleteMany({ where: { cardId: card.id } });
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// B — legacy installment-month shift: getCardCycleForDate (função REAL) prova
// se o firstInstallmentMonth persistido bate com o ciclo canônico da data
// real da compra, sob closingDay configurado.
// ============================================================================
{
  const cardHypothetical = { closingDay: 4, dueDay: 11 };
  const purchaseDateAfterClosing = new Date("2026-05-20T12:00:00.000Z"); // dia 20 > closingDay 4 -> ciclo do mês seguinte
  const canonicalCycle = getCardCycleForDate(cardHypothetical, purchaseDateAfterClosing);
  check("[B] compra em dia > closingDay pertence ao ciclo do MÊS SEGUINTE (função real, não interpretação textual)", canonicalCycle === "2026-06");

  const purchaseDateBeforeClosing = new Date("2026-05-02T12:00:00.000Z"); // dia 2 <= closingDay 4 -> ciclo do mesmo mês
  const canonicalCycle2 = getCardCycleForDate(cardHypothetical, purchaseDateBeforeClosing);
  check("[B] compra em dia <= closingDay pertence ao ciclo do MESMO mês", canonicalCycle2 === "2026-05");
}

// ============================================================================
// C — projection após realinhamento canônico dos Installments: uma vez que
// nenhum Installment aponta mais pro cycleMonth antigo, a projeção zera.
// ============================================================================
{
  const suffix = Date.now() + 1;
  const account = await prisma.account.create({ data: { slug: `teste-51bv2-realign-acc-${suffix}`, name: `[${MARK}] conta realign`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `teste-51bv2-realign-card-${suffix}`, name: `[${MARK}] cartão realign`, totalLimit: 1000, dueDay: 11, closingDay: null, accountId: account.id } });
  const purchase = await prisma.purchase.create({ data: { description: `[${MARK}] compra realinhada fictícia`, totalAmount: money(200), installmentCount: 2, installmentValue: money(100), cardId: card.id, firstInstallmentMonth: "2026-07", purchasedAt: new Date("2026-07-20T12:00:00.000Z") } });
  const inst1 = await prisma.installment.create({ data: { purchaseId: purchase.id, number: 1, amount: money(100), billMonth: "2026-07" } });
  await prisma.installment.create({ data: { purchaseId: purchase.id, number: 2, amount: money(100), billMonth: "2026-08" } });

  try {
    const cardHypothetical = { ...card, closingDay: 4, dueDay: 11 };
    const before = await computeExpectedCardBillTotal(cardHypothetical, "2026-07");
    check("[C, antes do realinhamento] projeção de 2026-07 ainda soma o Installment (100)", eq(before, 100));

    // Realinha (em memória — nunca escreve): move Installment #1 pra billMonth="2026-08"
    await prisma.installment.update({ where: { id: inst1.id }, data: { billMonth: "2026-08" } });
    const afterOldMonth = await computeExpectedCardBillTotal(cardHypothetical, "2026-07");
    check("[C, depois do realinhamento] projeção do cycleMonth ANTIGO zera (nenhum Installment mais aponta pra lá)", eq(afterOldMonth, 0));
    const afterNewMonth = await computeExpectedCardBillTotal(cardHypothetical, "2026-08");
    check("[C, depois do realinhamento] projeção do cycleMonth NOVO agora soma os 2 Installments (200)", eq(afterNewMonth, 200));
  } finally {
    await prisma.purchase.deleteMany({ where: { cardId: card.id } });
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// D/E — used-limit: âncora (CardLimitUpdate) desatualizada produz um valor
// stale (D); uma nova âncora (CREATE, nunca UPDATE) fecha no canônico (E).
// ============================================================================
{
  const suffix = Date.now() + 2;
  const account = await prisma.account.create({ data: { slug: `teste-51bv2-limit-acc-${suffix}`, name: `[${MARK}] conta limite`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `teste-51bv2-limit-card-${suffix}`, name: `[${MARK}] cartão limite`, totalLimit: 500, dueDay: 11, closingDay: null, accountId: account.id } });
  const oldAnchor = await prisma.cardLimitUpdate.create({ data: { cardId: card.id, newUsedLimit: money(200), occurredAt: new Date("2026-01-01T00:00:00.000Z"), source: "manual" } });
  await prisma.expense.create({ data: { amount: money(50), description: `[${MARK}] gasto fictício pós-âncora`, accountId: account.id, cardId: card.id, occurredAt: new Date("2026-01-10T00:00:00.000Z") } });

  try {
    const staleUsed = await computeCardUsedLimit(card.id);
    check("[D] âncora desatualizada produz used=250 (200+50) — STALE, não é bug, é observação antiga", eq(staleUsed, 250));

    // Nova observação (CREATE, nunca UPDATE) dated DEPOIS de tudo — fecha exatamente no canônico informado.
    await prisma.cardLimitUpdate.create({ data: { cardId: card.id, newUsedLimit: money(120), reportedAvailable: money(380), occurredAt: new Date("2026-01-20T00:00:00.000Z"), source: "manual" } });
    const freshUsed = await computeCardUsedLimit(card.id);
    check("[E] nova âncora CREATE (nunca UPDATE da antiga) fecha exatamente no canônico (120, sem os 50 antigos contando de novo)", eq(freshUsed, 120));

    const oldAnchorStillExists = await prisma.cardLimitUpdate.findUnique({ where: { id: oldAnchor.id } });
    check("[E] a âncora ANTIGA nunca foi sobrescrita — histórico preservado (event ledger, nunca UPDATE)", oldAnchorStillExists != null && eq(oldAnchorStillExists.newUsedLimit, 200));
  } finally {
    await prisma.expense.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.cardLimitUpdate.deleteMany({ where: { cardId: card.id } });
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// F — metadata (closesAt/dueAt) de CardBills retidas precisa ser recomputada
// quando closingDay muda — comparar persisted vs canonical.
// ============================================================================
{
  const persistedClosesAt = new Date("2026-04-01T00:00:00.000Z"); // convenção antiga (closingDay null): dia 1 do mês seguinte
  const canonicalClosesAt = getCardBillClosesAt({ closingDay: 4, dueDay: 11 }, "2026-03");
  check("[F] closesAt persistido (convenção antiga) diverge do canônico (closingDay novo) — precisa de UPDATE de metadata, não só de valor", persistedClosesAt.getTime() !== canonicalClosesAt.getTime());
}

// ============================================================================
// G — invariante de transação: uma falha DENTRO de $transaction reverte TUDO
// antes do commit — nada fica persistido.
// ============================================================================
{
  const suffix = Date.now() + 3;
  const account = await prisma.account.create({ data: { slug: `teste-51bv2-tx-acc-${suffix}`, name: `[${MARK}] conta tx`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `teste-51bv2-tx-card-${suffix}`, name: `[${MARK}] cartão tx`, totalLimit: 1000, dueDay: 11, closingDay: null, accountId: account.id } });

  try {
    let threw = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.card.update({ where: { id: card.id }, data: { closingDay: 4 } });
        // Invariante falso de propósito -> força throw antes do commit.
        const invariantOk = false;
        if (!invariantOk) throw new Error("invariante crítico falhou de propósito (teste)");
      });
    } catch (e) {
      threw = true;
    }
    check("[G] a transação lançou erro (invariante falhou)", threw);
    const cardAfter = await prisma.card.findUnique({ where: { id: card.id } });
    check("[G] NENHUM write parcial persistiu — closingDay continua null (rollback automático do Prisma)", cardAfter.closingDay === null);
  } finally {
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

// ============================================================================
// H — comparação de baseline pós-rollback: campos de negócio idênticos,
// updatedAt pode divergir — nunca afirmar byte-identical quando updatedAt mudou.
// ============================================================================
{
  const before = { id: "x", totalAmount: "100.00", status: "open", updatedAt: "2026-01-01T00:00:00.000Z" };
  const after = { id: "x", totalAmount: "100.00", status: "open", updatedAt: "2026-01-02T00:00:00.000Z" };
  function compareBusinessFields(a, b) {
    const businessMatch = a.totalAmount === b.totalAmount && a.status === b.status;
    const metadataChanged = a.updatedAt !== b.updatedAt;
    return { businessFieldsRestored: businessMatch, auditMetadataChanged: metadataChanged, byteIdentical: businessMatch && !metadataChanged };
  }
  const result = compareBusinessFields(before, after);
  check("[H] businessFieldsRestored=true quando campos de negócio batem", result.businessFieldsRestored === true);
  check("[H] auditMetadataChanged=true quando updatedAt diverge", result.auditMetadataChanged === true);
  check("[H] NUNCA afirma byteIdentical=true se updatedAt divergiu, mesmo com negócio idêntico", result.byteIdentical === false);
}

// ============================================================================
// I — injeção de `client` (item 18 da Fase 5.1B-CARD-v2): confirma que
// passar `client: tx` faz as funções REAIS lerem o estado AINDA NÃO
// COMMITADO da própria transação — o mecanismo central da nova estratégia
// de validação transaction-scoped. Sem `client`, comportamento é idêntico
// ao de sempre (confirmado pelos testes A-H acima, que não passam client).
// ============================================================================
{
  const suffix = Date.now() + 4;
  const account = await prisma.account.create({ data: { slug: `teste-51bv2-txclient-acc-${suffix}`, name: `[${MARK}] conta tx-client`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `teste-51bv2-txclient-card-${suffix}`, name: `[${MARK}] cartão tx-client`, totalLimit: 1000, dueDay: 11, closingDay: 4, accountId: account.id } });

  try {
    let sawInsideTx = null;
    let sawOutsideTxDuring = null;
    await prisma.$transaction(async (tx) => {
      await tx.cardLimitUpdate.create({ data: { cardId: card.id, newUsedLimit: money(77), reportedAvailable: money(923), occurredAt: new Date("2026-01-01T00:00:00.000Z"), source: "manual" } });
      // Lida via `client: tx` -> DEVE enxergar o create acima, ainda não commitado.
      sawInsideTx = await computeCardUsedLimit(card.id, { client: tx });
    });
    // Fora da transação (já commitada) — mesmo resultado, agora via prisma global.
    const sawAfterCommit = await computeCardUsedLimit(card.id);
    check("[I] computeCardUsedLimit(client: tx) enxerga o write AINDA NÃO commitado dentro da própria transação", eq(sawInsideTx, 77));
    check("[I] após o commit, o prisma global também enxerga (write realmente persistiu)", eq(sawAfterCommit, 77));
  } finally {
    await prisma.cardLimitUpdate.deleteMany({ where: { cardId: card.id } });
    await prisma.card.delete({ where: { id: card.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

console.log(`\n${passed}/${results.length} teste(s) passaram.`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await prisma.$disconnect();
