// Fase 4.1.3 — Card Read Paths Must Be Read-Only.
//
// Cobre os itens 9, 10, 11 e 12 do pedido: (a) prova antes/depois de que os
// caminhos de leitura (getCardBillView/listCardBillsView — as MESMAS funções
// chamadas por app/api/cards/route.js, app/api/cards/[id]/bills/route.js e
// app/api/dashboard/route.js) não gravam NADA no banco, mesmo chamadas
// repetidamente; (b) prova que uma fatura futura aparece na resposta como
// PROJEÇÃO em memória sem nenhuma CardBill nova ser criada; (c) prova que o
// fluxo de pagamento (mutação explícita) continua funcionando, incluindo
// materializar sob demanda uma fatura que só existia como projeção; (d) checa
// estruturalmente que as 3 rotas de leitura não importam as primitivas de
// mutação (getOrCreateBill/listBillsForCard).
//
// Cartão/conta/compra SINTÉTICOS — NUNCA dado real do usuário.
// assertTestEnvironment() + cleanup total, igual todo teste de integração desta fase.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { compareMoney, money } from "../lib/money.js";
import { getCardBillView, listCardBillsView, getOrCreateBill, payBill } from "../lib/cardBillCalculator.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";

const MARK = "TESTE_FASE413";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}

const created = { cards: [], accounts: [], purchases: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const c of created.cards) {
    await prisma.transfer.deleteMany({ where: { toCardId: c } }).catch(() => {});
    await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
  }
  for (const p of created.purchases) await prisma.purchase.delete({ where: { id: p } }).catch(() => {}); // cascade apaga Installment
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftoverCards = await prisma.card.count({ where: { slug: { contains: "teste-fase413" } } });
  const leftoverAccounts = await prisma.account.count({ where: { slug: { contains: "teste-fase413" } } });
  check("cleanup: zero cartão de teste restante", leftoverCards === 0, `contagem: ${leftoverCards}`);
  check("cleanup: zero conta de teste restante", leftoverAccounts === 0, `contagem: ${leftoverAccounts}`);
}

function snapshotBill(bill) {
  return {
    id: bill.id,
    cycleMonth: bill.cycleMonth,
    totalAmount: bill.totalAmount.toString(),
    paidAmount: bill.paidAmount == null ? null : bill.paidAmount.toString(),
    status: bill.status,
    createdAt: bill.createdAt?.toISOString() ?? null,
    updatedAt: bill.updatedAt?.toISOString() ?? null,
  };
}

async function fullDbSnapshot(cardId) {
  const rows = await prisma.cardBill.findMany({ where: { cardId }, orderBy: { cycleMonth: "asc" } });
  return { count: rows.length, rows: rows.map(snapshotBill) };
}

// ============================================================================
// Item 9 — critical test: GET (via getCardBillView/listCardBillsView, as
// funções reais por trás das rotas GET) nunca escreve, mesmo repetido.
// ============================================================================
async function testReadPathsNeverWrite() {
  console.log("\n--- Item 9: GET não escreve, mesmo repetido ---\n");

  const card = await prisma.card.create({
    data: { slug: "teste-fase413-readonly", name: `[${MARK}] Cartão Read-Only`, totalLimit: 5000, dueDay: 11, closingDay: 4 },
  });
  created.cards.push(card.id);

  // Fase 5.0.3, item 19 — asOf fixo (não o relógio real), injetado nas
  // chamadas abaixo. As asserções desta função não dependem do campo
  // `status` de faturas projetadas (só de id/isPersisted/contagens), então
  // isto é defensivo/consistência, não a correção de um flake real.
  const FIXED_ASOF = new Date("2026-09-04T12:00:00.000Z");

  // Uma fatura PERSISTIDA de propósito (simula um pagamento real já feito) +
  // várias PROJECTED (nenhuma linha no banco) — a mistura é o cenário real do
  // item 8 do pedido.
  const currentCycle = "2026-09";
  const persistedBill = await prisma.cardBill.create({
    data: {
      cardId: card.id,
      cycleMonth: currentCycle,
      closesAt: new Date("2026-09-04T00:00:00.000Z"),
      dueAt: new Date("2026-09-11T00:00:00.000Z"),
      totalAmount: money(1859.01),
      paidAmount: money(1859.01),
      status: "paid",
    },
  });

  const before = await fullDbSnapshot(card.id);
  check("antes: exatamente 1 CardBill persistida (a que criamos de propósito)", before.count === 1, JSON.stringify(before));

  // Bate repetidamente nas MESMAS funções que as rotas GET chamam — várias
  // vezes, simulando vários loads de /cartoes e do dashboard.
  for (let i = 0; i < 5; i++) {
    await getCardBillView(card, currentCycle, { now: FIXED_ASOF });
    await getCardBillView(card, "2026-10", { now: FIXED_ASOF }); // ciclo futuro, nunca persistido
    await getCardBillView(card, "2026-11", { now: FIXED_ASOF }); // idem
    await listCardBillsView(card.id, { monthsBack: 1, monthsForward: 6, now: FIXED_ASOF });
  }

  const after = await fullDbSnapshot(card.id);

  check("depois: contagem de CardBill idêntica (nenhum INSERT)", after.count === before.count, `antes=${before.count}, depois=${after.count}`);
  check(
    "depois: a fatura persistida está byte-a-byte idêntica (createdAt/updatedAt/status/valores intocados — nenhum UPDATE)",
    JSON.stringify(after.rows) === JSON.stringify(before.rows),
    `antes=${JSON.stringify(before.rows)}, depois=${JSON.stringify(after.rows)}`
  );

  // Confere também que a fatura NÃO persistida realmente não virou uma row —
  // não basta a contagem bater, precisa ser especificamente ESSA fatura ausente.
  const outRow = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth: "2026-10" } } });
  check("fatura de outubro (nunca persistida) continua ausente do banco depois de 5 leituras", outRow === null);

  // E a view devolvida pro caller reflete a projeção corretamente (id: null,
  // isPersisted: false) mesmo sem nunca ter sido gravada.
  const octView = await getCardBillView(card, "2026-10", { now: FIXED_ASOF });
  check("view de outubro: id=null, isPersisted=false (é projeção, não persistida)", octView.id === null && octView.isPersisted === false, JSON.stringify({ id: octView.id, isPersisted: octView.isPersisted }));

  const sepView = await getCardBillView(card, currentCycle, { now: FIXED_ASOF });
  check(
    "view de setembro: reflete a fatura PERSISTIDA de verdade (isPersisted=true, mesmo id)",
    sepView.isPersisted === true && sepView.id === persistedBill.id,
    JSON.stringify({ id: sepView.id, isPersisted: sepView.isPersisted })
  );
}

// ============================================================================
// Item 10 — projection-without-persistence: compra parcelada com parcelas
// futuras aparece na visão multi-mês sem nenhuma CardBill ser criada.
// ============================================================================
async function testProjectionWithoutPersistence() {
  console.log("\n--- Item 10: projeção sem persistência ---\n");

  const card = await prisma.card.create({
    data: { slug: "teste-fase413-projection", name: `[${MARK}] Cartão Projeção`, totalLimit: 5000, dueDay: 11, closingDay: 4 },
  });
  created.cards.push(card.id);

  // Fase 5.0.3, item 19 — determinismo de VERDADE: um asOf FIXO e sintético
  // (não o relógio real), passado explicitamente pra listCardBillsView/
  // getCardBillView via clock injection (now = new Date() é só o default de
  // produção — lib/cardBillCalculator.js aceita now injetável desde esta
  // fase). O ciclo esperado é derivado deste MESMO asOf fixo com a função
  // pura getCardCycleForDate — o teste nunca lê o relógio da máquina, então
  // roda idêntico hoje, amanhã, ou em outro timezone.
  const FIXED_ASOF = new Date("2026-09-04T12:00:00.000Z");
  const firstCycle = getCardCycleForDate(card, FIXED_ASOF);
  const lastCycle = addMonthKeyLocal(firstCycle, 5); // 6 parcelas: firstCycle..firstCycle+5

  // Compra parcelada em 6x, iniciando no ciclo atual — todas as parcelas caem
  // em ciclos futuros/atual, NENHUM ainda materializado como CardBill.
  const purchase = await prisma.purchase.create({
    data: {
      description: `[${MARK}] Notebook`,
      totalAmount: money(600),
      installmentCount: 6,
      installmentValue: money(100),
      cardId: card.id,
      firstInstallmentMonth: firstCycle,
      installments: {
        create: Array.from({ length: 6 }, (_, i) => ({
          number: i + 1,
          amount: money(100),
          billMonth: addMonthKeyLocal(firstCycle, i),
        })),
      },
    },
  });
  created.purchases.push(purchase.id);

  const beforeCount = await prisma.cardBill.count({ where: { cardId: card.id } });
  check("antes: zero CardBill persistida pra este cartão (nada foi materializado ainda)", beforeCount === 0, `contagem: ${beforeCount}`);

  const view = await listCardBillsView(card.id, { monthsBack: 0, monthsForward: 6, now: FIXED_ASOF });
  const firstBill = view.find((b) => b.cycleMonth === firstCycle);
  const lastBill = view.find((b) => b.cycleMonth === lastCycle);

  check(`visão multi-mês mostra a parcela do ciclo atual (${firstCycle}, 100.00), calculada em memória`, firstBill && eq(firstBill.totalAmount, 100), firstBill && firstBill.totalAmount.toString());
  check(`visão multi-mês mostra a parcela do último ciclo (${lastCycle}, 100.00, última das 6)`, lastBill && eq(lastBill.totalAmount, 100), lastBill && lastBill.totalAmount.toString());
  check("todas as 7 faturas da janela (0..6 meses) vêm como projeção (id: null)", view.every((b) => b.id === null), JSON.stringify(view.map((b) => ({ cycleMonth: b.cycleMonth, id: b.id }))));

  const afterCount = await prisma.cardBill.count({ where: { cardId: card.id } });
  check("depois: contagem de CardBill continua exatamente igual (zero), mesmo mostrando 6 parcelas futuras", afterCount === beforeCount, `antes=${beforeCount}, depois=${afterCount}`);
}

function addMonthKeyLocal(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// ============================================================================
// Item 11 — mutation still works: materializar sob demanda (via cycleMonth)
// uma fatura que só existia como projeção, e pagá-la — reproduz exatamente o
// que a rota .../pay/route.js faz agora.
// ============================================================================
async function testMutationStillWorksWithMaterializeOnDemand() {
  console.log("\n--- Item 11: pagamento com materialização sob demanda ---\n");

  const account = await prisma.account.create({
    data: { slug: "teste-fase413-conta", name: `[${MARK}] Conta`, type: "checking" },
  });
  created.accounts.push(account.id);

  const card = await prisma.card.create({
    data: { slug: "teste-fase413-pagamento", name: `[${MARK}] Cartão Pagamento`, totalLimit: 5000, dueDay: 11, closingDay: 4 },
  });
  created.cards.push(card.id);

  const cycleMonth = "2026-09";

  // Uma parcela real (via Installment.billMonth) pra este ciclo, senão a fatura
  // materializaria com totalAmount=0 e o pagamento de teste não teria contra o
  // que comparar — não é sobre a compra em si, só dá substância à fatura.
  const purchase = await prisma.purchase.create({
    data: {
      description: `[${MARK}] Compra base`,
      totalAmount: money(100),
      installmentCount: 1,
      installmentValue: money(100),
      cardId: card.id,
      firstInstallmentMonth: cycleMonth,
      installments: { create: [{ number: 1, amount: money(100), billMonth: cycleMonth }] },
    },
  });
  created.purchases.push(purchase.id);

  // Confirma que, ANTES do pagamento, a fatura é só projeção — reproduz o
  // estado real que o frontend vê quando currentBill.id é null.
  const beforeCount = await prisma.cardBill.count({ where: { cardId: card.id, cycleMonth } });
  check("antes do pagamento: fatura ainda não materializada (0 rows)", beforeCount === 0);

  // Reproduz a lógica exata da rota: existing == null → getOrCreateBill → payBill.
  const existing = await prisma.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth } } });
  check("rota resolveria existing=null (billId da URL não correspondia a nenhuma row real)", existing === null);

  const materialized = await getOrCreateBill(card.id, cycleMonth);
  check("getOrCreateBill materializa a fatura sob demanda (mutação explícita, não um GET)", materialized.id != null);

  const paidAmount = 50;
  const { bill: paidBill, transfer } = await payBill(materialized.id, {
    fromAccountId: account.id,
    amount: paidAmount,
    description: `[${MARK}] Pagamento parcial`,
  });

  check("pagamento foi registrado (Transfer criado, ligado à CardBill materializada)", transfer.cardBillId === materialized.id && eq(money(transfer.amount), paidAmount));
  check(
    "CardBill agora tem paidAmount correto (50) e status derivado partially_paid (totalAmount=100, pago=50 < 100)",
    eq(money(paidBill.paidAmount), paidAmount) && paidBill.status === "partially_paid",
    `paidAmount=${paidBill.paidAmount}, status=${paidBill.status}`
  );

  const afterCount = await prisma.cardBill.count({ where: { cardId: card.id, cycleMonth } });
  check("depois do pagamento: exatamente 1 CardBill persistida (a materialização foi real e única)", afterCount === 1, `contagem: ${afterCount}`);
}

// ============================================================================
// Item 12 — checagem arquitetural: as 3 rotas de leitura não podem importar/
// chamar as primitivas de MUTAÇÃO (getOrCreateBill/listBillsForCard).
// ============================================================================
function testReadRoutesDoNotUseMutationPrimitives() {
  console.log("\n--- Item 12: rotas de leitura não usam primitivas de mutação ---\n");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, "..");
  const readRoutes = [
    "app/api/cards/route.js",
    "app/api/cards/[id]/bills/route.js",
    "app/api/dashboard/route.js",
  ];
  const forbidden = ["getOrCreateBill", "listBillsForCard"];
  // Checa USO real (import nomeado ou chamada com parênteses) — não texto de
  // comentário, que legitimamente cita esses nomes pra documentar a regra
  // (ver lib/cardBillCalculator.js, que referencia este próprio arquivo de
  // teste no comentário de getOrCreateBill/listBillsForCard).
  function realUsages(content, name) {
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`);
    const callRe = new RegExp(`\\b${name}\\s*\\(`);
    return importRe.test(content) || callRe.test(content);
  }

  for (const relPath of readRoutes) {
    const content = readFileSync(path.join(root, relPath), "utf8");
    const hits = forbidden.filter((name) => realUsages(content, name));
    check(`${relPath} não importa/chama ${forbidden.join("/")}`, hits.length === 0, hits.join(", "));
  }

  // A rota de pagamento é uma MUTAÇÃO — pode (e deve) usar getOrCreateBill.
  const payRouteContent = readFileSync(path.join(root, "app/api/cards/[id]/bills/[billId]/pay/route.js"), "utf8");
  check("rota de pagamento (mutação) CONTINUA usando getOrCreateBill — isso é esperado, não um vazamento", realUsages(payRouteContent, "getOrCreateBill"));
}

let exitCode = 0;
try {
  await testReadPathsNeverWrite();
  await testProjectionWithoutPersistence();
  await testMutationStillWorksWithMaterializeOnDemand();
  testReadRoutesDoNotUseMutationPrimitives();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checagem(ns) passaram.`);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  exitCode = 1;
}
process.exit(exitCode);
