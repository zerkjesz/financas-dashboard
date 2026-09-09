// Fase 3.1, Etapa 11 — testes de integração dos caminhos de MUTAÇÃO, contra o banco
// real do branch `dev` (não é possível testar Decimal write/read com mocks — precisa
// do Postgres de verdade fazendo o round-trip NUMERIC(12,2)).
//
// Regras obrigatórias deste script (repetidas aqui de propósito, não só no README):
//   - assertTestEnvironment() é a PRIMEIRA coisa que roda. Se o ambiente não for
//     inequivocamente dev/test, o processo aborta antes de tocar em qualquer dado.
//   - TODO dado criado aqui tem um marcador inconfundível (slug/descrição com o
//     prefixo TESTE_FASE31) — nunca reaproveita conta/cartão real (exceto o
//     sub-teste de VA, que precisa do slug fixo "vale-alimentacao"; ver nota lá).
//   - Cleanup roda em `finally`, sempre, mesmo se uma asserção falhar no meio —
///    zero dado de teste deve sobrar no banco ao final, sucesso ou falha.
//   - Ao final, uma verificação extra confirma que nenhum registro com os
//     marcadores de teste sobrou (evidência, não suposição — mesmo espírito do
//     Gate de Ambiente da Fase 2.1).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { computeCardUsedLimit } from "../lib/cards.js";
import { getOrCreateBill, payBill, computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { generateInstallmentSchedule } from "../lib/installments.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";
import { money, addMoney, subtractMoney, compareMoney, serializeMoney } from "../lib/money.js";

const MARK = "TESTE_FASE31";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const created = { accounts: [], cards: [], incomes: [], expenses: [], transfers: [], purchases: [], cardBills: [], bills: [], balanceAdjustments: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  // Ordem: filhos antes de pais (FKs).
  for (const p of created.purchases) await prisma.installment.deleteMany({ where: { purchaseId: p } }).catch(() => {});
  for (const p of created.purchases) await prisma.purchase.delete({ where: { id: p } }).catch(() => {});
  for (const t of created.transfers) await prisma.transfer.delete({ where: { id: t } }).catch(() => {});
  for (const e of created.expenses) await prisma.expense.delete({ where: { id: e } }).catch(() => {});
  for (const i of created.incomes) await prisma.income.delete({ where: { id: i } }).catch(() => {});
  for (const b of created.bills) await prisma.bill.delete({ where: { id: b } }).catch(() => {});
  for (const cb of created.cardBills) await prisma.cardBill.delete({ where: { id: cb } }).catch(() => {});
  for (const ba of created.balanceAdjustments) await prisma.balanceAdjustment.delete({ where: { id: ba } }).catch(() => {});
  for (const c of created.cards) await prisma.cardLimitUpdate.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  // Verificação de evidência — zero dado de teste deve sobrar, procurado pelo marcador.
  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase31" } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase31" } } }),
    prisma.income.count({ where: { description: { contains: MARK } } }),
    prisma.expense.count({ where: { description: { contains: MARK } } }),
    prisma.bill.count({ where: { description: { contains: MARK } } }),
    prisma.purchase.count({ where: { description: { contains: MARK } } }),
    prisma.transfer.count({ where: { description: { contains: MARK } } }),
  ]);
  const totalLeftover = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", totalLeftover === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de integração (branch dev) — Fase 3.1, Etapa 11 ---\n");

  // Fixtures isoladas — nunca reaproveita conta/cartão real.
  const accA = await prisma.account.create({ data: { slug: "teste-fase31-conta-a", name: `[${MARK}] Conta A`, type: "checking" } });
  created.accounts.push(accA.id);
  const accB = await prisma.account.create({ data: { slug: "teste-fase31-conta-b", name: `[${MARK}] Conta B`, type: "checking" } });
  created.accounts.push(accB.id);
  const card = await prisma.card.create({
    data: { slug: "teste-fase31-cartao", name: `[${MARK}] Cartão`, accountId: accA.id, totalLimit: 5000, closingDay: null, dueDay: 10 },
  });
  created.cards.push(card.id);

  // Saldo inicial das duas contas, via BalanceAdjustment (âncora), igual ao fluxo real.
  const anchorA = await prisma.balanceAdjustment.create({ data: { accountId: accA.id, newBalance: 1000, source: "manual", note: MARK } });
  created.balanceAdjustments.push(anchorA.id);
  const anchorB = await prisma.balanceAdjustment.create({ data: { accountId: accB.id, newBalance: 0, source: "manual", note: MARK } });
  created.balanceAdjustments.push(anchorB.id);

  // ---- 1. Expense com centavos ----
  const expense1 = await prisma.expense.create({
    data: { amount: 61.61, description: `[${MARK}] Mercado`, category: "Alimentação", accountId: accA.id, source: "manual" },
  });
  created.expenses.push(expense1.id);
  const balAfterExpense = await computeAccountBalance(accA.id);
  check("Expense com centavos: saldo = 1000 - 61.61 = 938.39", compareMoney(balAfterExpense, "938.39") === 0, serializeMoney(balAfterExpense).toString());

  // ---- 2. Income ----
  const income1 = await prisma.income.create({
    data: { amount: 114.63, description: `[${MARK}] Reembolso`, category: "Outros", accountId: accA.id, source: "manual" },
  });
  created.incomes.push(income1.id);
  const balAfterIncome = await computeAccountBalance(accA.id);
  // 938.39 + 114.63 = 1053.02 — mesmo caso do teste puro (61.61+114.63=176.24), aqui via DB real.
  check("Income: saldo = 938.39 + 114.63 = 1053.02", compareMoney(balAfterIncome, "1053.02") === 0, serializeMoney(balAfterIncome).toString());

  // ---- 3. Transfer entre as duas contas ----
  const transfer1 = await prisma.transfer.create({
    data: { amount: 209.11, description: `[${MARK}] Transferência`, fromAccountId: accA.id, toAccountId: accB.id, kind: "generic", source: "manual" },
  });
  created.transfers.push(transfer1.id);
  const [balA, balB] = await Promise.all([computeAccountBalance(accA.id), computeAccountBalance(accB.id)]);
  check("Transfer: conta A debitada = 1053.02 - 209.11 = 843.91", compareMoney(balA, "843.91") === 0, serializeMoney(balA).toString());
  check("Transfer: conta B creditada = 0 + 209.11 = 209.11", compareMoney(balB, "209.11") === 0, serializeMoney(balB).toString());

  // Ciclo corrente real (mesma fórmula usada pelo resto do app) — nunca hardcoded,
  // pra este script continuar correto em qualquer data em que for rodado.
  const now = new Date();
  const currentCycle = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  // ---- 4/5. Purchase parcelada + Installment (ajuste de arredondamento na última parcela) ----
  const purchase1 = await prisma.purchase.create({
    data: {
      description: `[${MARK}] Compra parcelada`,
      totalAmount: 512.04,
      installmentCount: 3,
      installmentValue: 170.68,
      category: "Outros",
      cardId: card.id,
      firstInstallmentMonth: currentCycle,
      startingInstallmentNumber: 1,
      source: "manual",
    },
  });
  created.purchases.push(purchase1.id);
  const installmentRows = await generateInstallmentSchedule(purchase1);
  const installmentSum = installmentRows.reduce((acc, r) => addMoney(acc, r.amount), money(0));
  check(
    "Installments: soma das 3 parcelas fecha exatamente em 512.04 (não 512.03999...)",
    compareMoney(installmentSum, "512.04") === 0,
    serializeMoney(installmentSum).toString()
  );
  const lastInstallment = installmentRows[installmentRows.length - 1];
  check("Installments: última parcela absorve a sobra (170.68 esperado)", compareMoney(lastInstallment.amount, "170.68") === 0, serializeMoney(money(lastInstallment.amount)).toString());

  // ---- Card used limit (depende da Purchase acima) ----
  const usedLimit = await computeCardUsedLimit(card.id);
  check("Card used limit: reflete a compra parcelada (512.04)", compareMoney(usedLimit, "512.04") === 0, serializeMoney(usedLimit).toString());

  // ---- 6. CardBill (agrega Expense do cartão + Installment do ciclo) ----
  const expenseOnCard = await prisma.expense.create({
    data: { amount: 35, description: `[${MARK}] Gasto no cartão`, category: "Outros", cardId: card.id, source: "manual", occurredAt: now },
  });
  created.expenses.push(expenseOnCard.id);
  const expectedTotal = await computeExpectedCardBillTotal(card, currentCycle);
  // Ciclo corrente (closingDay null = mês calendário): Installment #1 (170.68) +
  // Expense no cartão (35), ambos explicitamente datados/mesados pro ciclo corrente
  // acima. 170.68 + 35 = 205.68.
  check("CardBill esperado (Installment + Expense do ciclo) = 205.68", compareMoney(expectedTotal, "205.68") === 0, serializeMoney(expectedTotal).toString());

  const bill = await getOrCreateBill(card.id, currentCycle);
  created.cardBills.push(bill.id);
  check("getOrCreateBill grava o mesmo total (205.68)", compareMoney(bill.totalAmount, "205.68") === 0, serializeMoney(money(bill.totalAmount)).toString());

  // ---- 7. Pagamento parcial de fatura (não pode fechar como "paid") ----
  const partialPay = await payBill(bill.id, { fromAccountId: accB.id, amount: 100, description: `[${MARK}] Pagamento parcial` });
  created.transfers.push(partialPay.transfer.id);
  check("Pagamento parcial: status vira partially_paid (não paid)", partialPay.bill.status === "partially_paid", partialPay.bill.status);
  check("Pagamento parcial: paidAmount = 100.00", compareMoney(money(partialPay.bill.paidAmount), "100") === 0, serializeMoney(money(partialPay.bill.paidAmount)).toString());
  const balBAfterPay = await computeAccountBalance(accB.id);
  check("Pagamento parcial: conta B debitada = 209.11 - 100 = 109.11", compareMoney(balBAfterPay, "109.11") === 0, serializeMoney(balBAfterPay).toString());

  const finalPay = await payBill(bill.id, { fromAccountId: accB.id, amount: 105.68, description: `[${MARK}] Pagamento final` });
  created.transfers.push(finalPay.transfer.id);
  check("Pagamento final: status vira paid (100 + 105.68 = 205.68 = total)", finalPay.bill.status === "paid", finalPay.bill.status);

  // ---- Bill avulsa + cancelamento (fluxo de contas a pagar) ----
  const bill1 = await prisma.bill.create({
    data: { description: `[${MARK}] Conta avulsa`, amount: 245.9, category: "Outros", accountId: accA.id, dueDate: new Date(Date.now() + 5 * 86400000), source: "manual" },
  });
  created.bills.push(bill1.id);
  check("Bill avulsa: amount gravado como 245.90", compareMoney(money(bill1.amount), "245.90") === 0, serializeMoney(money(bill1.amount)).toString());

  // ---- 10. VA — usa o slug fixo real "vale-alimentacao" (não há como isolar; ver
  // cabeçalho do script). Mede o DELTA antes/depois de um Income temporário e confirma
  // que volta exatamente ao valor original após o cleanup, como evidência de que nada
  // ficou para trás.
  const vaAccount = await prisma.account.findUnique({ where: { slug: "vale-alimentacao" } });
  if (vaAccount) {
    const snapshotBefore = await buildVaSnapshot();
    const vaIncome = await prisma.income.create({
      data: { amount: 12.34, description: `[${MARK}] VA teste`, category: "Outros", accountId: vaAccount.id, source: "manual" },
    });
    created.incomes.push(vaIncome.id);
    const snapshotAfter = await buildVaSnapshot();
    const delta = subtractMoney(snapshotAfter.balance, snapshotBefore.balance);
    check("VA: Income de 12.34 reflete exatamente no snapshot.balance", compareMoney(delta, "12.34") === 0, serializeMoney(delta).toString());
  } else {
    check("VA: conta 'vale-alimentacao' não existe neste banco — sub-teste pulado (não é falha)", true, "sem conta VA no branch dev");
  }

  // ---- 11. Projeção de caixa — Bill temporária deve aparecer na timeline ----
  // Fase 5.4F — REMOVIDO: este teste chamava lib/cashFlowProjection.js (V1),
  // deletado nesta fase (zero caller real restante — ver FINAL_V1_CALLER_MAP
  // do relatório). Cobertura equivalente já existe em V2:
  // scripts/test-financial-engine-integration.mjs, seção 9 ("financialStatus
  // — smoke test das 4 regras") cria uma Bill real e confirma que
  // buildBaseProjection/buildExpectedProjection/buildStressProjection a
  // incorporam corretamente (o status financeiro escala pra CRITICO
  // especificamente por causa dessa Bill entrar na projeção — só é possível
  // se a Bill estiver na timeline). Não duplicado aqui de propósito.
}

let exitCode = 0;
try {
  await run();
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
