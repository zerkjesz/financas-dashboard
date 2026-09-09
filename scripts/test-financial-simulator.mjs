// Fase 5.3E — CANONICAL FINANCIAL SIMULATOR. Testes de integração contra o
// branch dev. Fixtures 100% sintéticas (nenhum valor real do usuário — nenhum
// nome/valor/data reais aparece hardcoded aqui). Mesma metodologia de
// scripts/test-financial-engine-integration.mjs: banco tem dados reais de
// fundo (Itaú, obrigações reais), então tudo que depende de totais globais é
// medido por DELTA (antes/depois da fixture desta seção), nunca por suposição
// de banco vazio.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { compareMoney, serializeMoney, addMoney, money, roundMoney, divideMoney, isNegative } from "../lib/money.js";
import { simulateFinancialScenario, SIMULATION_SCENARIO_TYPE, SimulationInputError } from "../lib/simulation/financialSimulator.js";
import { generateInstallmentSchedule } from "../lib/installments.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";

const MARK = "TESTE_FASE53E";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(a, b) === 0;
}
async function expectThrow(fn, matchCode) {
  try {
    await fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, code: err.code, message: err.message, isSimulationInputError: err instanceof SimulationInputError };
  }
}

const created = { accounts: [], cards: [], contingencies: [], purchases: [], bills: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const p of created.purchases) await prisma.installment.deleteMany({ where: { purchaseId: p } }).catch(() => {});
  for (const p of created.purchases) await prisma.purchase.delete({ where: { id: p } }).catch(() => {});
  for (const b of created.bills) await prisma.bill.delete({ where: { id: b } }).catch(() => {});
  for (const c of created.contingencies) await prisma.contingency.delete({ where: { id: c } }).catch(() => {});
  for (const c of created.cards) await prisma.cardBill.deleteMany({ where: { cardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.transfer.deleteMany({ where: { toCardId: c } }).catch(() => {});
  for (const c of created.cards) await prisma.card.delete({ where: { id: c } }).catch(() => {});
  for (const a of created.accounts) await prisma.balanceAdjustment.deleteMany({ where: { accountId: a } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase53e" } } }),
    prisma.card.count({ where: { slug: { contains: "teste-fase53e" } } }),
    prisma.contingency.count({ where: { description: { contains: MARK } } }),
    prisma.purchase.count({ where: { description: { contains: MARK } } }),
    prisma.bill.count({ where: { description: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function mkAccount(slug, type, initialBalance) {
  const account = await prisma.account.create({ data: { slug: `teste-fase53e-${slug}`, name: `[${MARK}] ${slug}`, type } });
  created.accounts.push(account.id);
  if (initialBalance != null) {
    await prisma.balanceAdjustment.create({ data: { accountId: account.id, newBalance: initialBalance, source: "manual", note: MARK } });
  }
  return account;
}

async function mkCard(slug, { totalLimit, dueDay = 15, closingDay = null }) {
  const card = await prisma.card.create({ data: { slug: `teste-fase53e-${slug}`, name: `[${MARK}] ${slug}`, totalLimit, dueDay, closingDay } });
  created.cards.push(card.id);
  return card;
}

const NOW = new Date("2026-09-08T12:00:00.000Z");

const FINANCIAL_MODELS = [
  "account", "card", "income", "expense", "transfer", "balanceAdjustment", "cardLimitUpdate", "purchase",
  "installment", "cardBill", "recurringRule", "bill", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency", "receivable",
  "categoryBudget", "telegramUpdateReceipt",
];
async function fingerprint() {
  const counts = await Promise.all(FINANCIAL_MODELS.map((m) => prisma[m].count()));
  return Object.fromEntries(FINANCIAL_MODELS.map((m, i) => [m, counts[i]]));
}

async function run() {
  console.log("--- Fase 5.3E: Canonical Financial Simulator (branch dev) ---\n");

  // ==========================================================================
  // 1) CASH_EXPENSE_NOW — reduz freeMoney/unrestrictedCash exatamente pelo
  //    valor simulado, nunca toca em limite de cartão.
  // ==========================================================================
  {
    const checking = await mkAccount("cash-checking", "checking", 5000);
    const baselineEngine = await buildFinancialEngineSummary({ now: NOW });

    const result = await simulateFinancialScenario({ now: NOW, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 300 } });
    check("CASH_EXPENSE_NOW: baseline.freeMoney bate com buildFinancialEngineSummary (mesma fonte)", eq(result.baseline.freeMoney, baselineEngine.freeMoney));
    check("CASH_EXPENSE_NOW: delta.freeMoney = -300 exato", eq(result.delta.freeMoney, -300), serializeMoney(result.delta.freeMoney).toString());
    check("CASH_EXPENSE_NOW: unrestrictedCash simulado = real - 300", eq(result.simulated.unrestrictedCash, addMoney(result.baseline.unrestrictedCash, money(-300))));
    check("CASH_EXPENSE_NOW: incurredLiabilities NUNCA muda (gasto em dinheiro não é cartão)", eq(result.simulated.incurredLiabilities, result.baseline.incurredLiabilities));
    check("CASH_EXPENSE_NOW: cardFeasibility é null (não se aplica a gasto em dinheiro)", result.cardFeasibility === null);
    check("CASH_EXPENSE_NOW: zeroWriteProof declarado", result.zeroWriteProof.ZERO_REAL_USER_FINANCIAL_WRITES === "YES");
  }

  // ==========================================================================
  // 2) CARD_PURCHASE_SINGLE — CAN_AUTHORIZE, incurredLiabilities só sobe se a
  //    compra cair na fatura atualmente relevante.
  // ==========================================================================
  {
    const card = await mkCard("single-ok", { totalLimit: 5000, dueDay: 15 });
    const result = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount: 500, description: `[${MARK}] compra única` },
    });
    check("CARD_PURCHASE_SINGLE: cardFeasibility.verdict = CAN_AUTHORIZE (limite 5000, sem uso)", result.cardFeasibility.verdict === "CAN_AUTHORIZE");
    check("CARD_PURCHASE_SINGLE: availableLimitAfter = 4500", eq(result.cardFeasibility.availableLimitAfter, 4500), serializeMoney(result.cardFeasibility.availableLimitAfter).toString());
    check("CARD_PURCHASE_SINGLE: unrestrictedCash simulado === baseline (cartão nunca debita conta direto)", eq(result.simulated.unrestrictedCash, result.baseline.unrestrictedCash));
    check("CARD_PURCHASE_SINGLE: incurredLiabilities sobe em 500 (cartão novo, única fatura = a relevante)", eq(result.delta.incurredLiabilities, 500), serializeMoney(result.delta.incurredLiabilities).toString());
    check("CARD_PURCHASE_SINGLE: verdict geral = SAFE (limite cabe e freeMoney não fica negativo)", result.verdict === "SAFE", JSON.stringify({ freeMoney: serializeMoney(result.simulated.freeMoney).toString(), status: result.simulated.status.status }));
    check("CARD_PURCHASE_SINGLE: installmentSchedule tem 1 parcela = valor total", result.installmentSchedule.length === 1 && eq(result.installmentSchedule[0].amount, 500));
  }

  // ==========================================================================
  // 3) CARD_PURCHASE_SINGLE — CANNOT_AUTHORIZE (limite insuficiente) — nunca
  //    silenciosamente aceito.
  // ==========================================================================
  {
    const card = await mkCard("single-over", { totalLimit: 200, dueDay: 15 });
    const result = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount: 500 },
    });
    check("CARD_PURCHASE_SINGLE (limite insuficiente): cardFeasibility.verdict = CANNOT_AUTHORIZE", result.cardFeasibility.verdict === "CANNOT_AUTHORIZE");
    check("CARD_PURCHASE_SINGLE (limite insuficiente): shortfall = 300 (500-200)", eq(result.cardFeasibility.shortfall, 300), serializeMoney(result.cardFeasibility.shortfall).toString());
    check("CARD_PURCHASE_SINGLE (limite insuficiente): verdict geral = CANNOT_AUTHORIZE (nunca SAFE)", result.verdict === "CANNOT_AUTHORIZE");
  }

  // ==========================================================================
  // 4) CARD_PURCHASE_INSTALLMENTS — rounding IDÊNTICO ao motor real de
  //    parcelamento (comparado contra uma Purchase de verdade, criada e
  //    apagada só pra esta comparação).
  // ==========================================================================
  {
    const card = await mkCard("installments-round", { totalLimit: 100000, dueDay: 15 });
    const totalAmount = 1000.01; // proposital: não divide exato por 3 -> força arredondamento na última parcela.
    const installmentCount = 3;

    const simResult = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId: card.id, totalAmount, installmentCount, purchasedAt: NOW.toISOString() },
    });

    // Compra REAL com os mesmos parâmetros, pra comparar linha a linha.
    const installmentValue = roundMoney(divideMoney(money(totalAmount), installmentCount));
    const realPurchase = await prisma.purchase.create({
      data: {
        description: `[${MARK}] compra real de comparação`,
        totalAmount,
        installmentCount,
        installmentValue,
        cardId: card.id,
        firstInstallmentMonth: "2026-09",
        purchasedAt: NOW,
      },
    });
    created.purchases.push(realPurchase.id);
    const realRows = await generateInstallmentSchedule(realPurchase);

    check(
      "CARD_PURCHASE_INSTALLMENTS: mesmo número de parcelas que o motor real",
      simResult.installmentSchedule.length === realRows.length
    );
    let allMatch = true;
    for (let i = 0; i < realRows.length; i++) {
      if (!eq(simResult.installmentSchedule[i].amount, realRows[i].amount) || simResult.installmentSchedule[i].billMonth !== realRows[i].billMonth) {
        allMatch = false;
      }
    }
    check("CARD_PURCHASE_INSTALLMENTS: cada parcela (valor + billMonth) bate exatamente com o motor real", allMatch, JSON.stringify({ sim: simResult.installmentSchedule, real: realRows }));
    check(
      "CARD_PURCHASE_INSTALLMENTS: última parcela absorve o resto do arredondamento (0.01 sobrando de 1000.01/3)",
      !eq(simResult.installmentSchedule[2].amount, simResult.installmentSchedule[0].amount)
    );
  }

  // ==========================================================================
  // 5) Fronteira de ciclo (closingDay=4) — parcela do dia 4 entra no ciclo que
  //    fecha ESTE mês; parcela do dia 5 já entra no ciclo do mês seguinte.
  // ==========================================================================
  {
    const card = await mkCard("cycle-boundary", { totalLimit: 100000, dueDay: 11, closingDay: 4 });
    const onBoundary = await simulateFinancialScenario({
      now: new Date("2026-09-04T00:00:00.000Z"),
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount: 100, purchasedAt: "2026-09-04T00:00:00.000Z" },
    });
    const afterBoundary = await simulateFinancialScenario({
      now: new Date("2026-09-05T00:00:00.000Z"),
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount: 100, purchasedAt: "2026-09-05T00:00:00.000Z" },
    });
    check("cycle-boundary: compra no dia 4 (closingDay) cai no ciclo 2026-09", onBoundary.installmentSchedule[0].billMonth === "2026-09");
    check("cycle-boundary: compra no dia 5 (closingDay+1) já cai no ciclo 2026-10", afterBoundary.installmentSchedule[0].billMonth === "2026-10");
    check("cycle-boundary: dueAt do ciclo 2026-09 (dueDay=11, closingDay=4, mesmo mês) = 2026-09-11", onBoundary.installmentSchedule[0].dueAt.toISOString().slice(0, 10) === "2026-09-11");
  }

  // ==========================================================================
  // 6) INVARIANTE OBRIGATÓRIA: cardFeasibility=CAN_AUTHORIZE (limite grande) +
  //    freeMoney simulado negativo NUNCA produz verdict geral SAFE.
  // ==========================================================================
  {
    const checking = await mkAccount("invariant-checking", "checking", 50); // caixa quase zerado.
    const card = await mkCard("invariant-card", { totalLimit: 999999, dueDay: 15 }); // limite absurdamente folgado -> sempre CAN_AUTHORIZE.
    // Obrigação sintética GIGANTE, vencendo amanhã (garantidamente antes da
    // próxima renda real, seja ela qual for) — força freeMoney simulado
    // negativo de forma determinística, sem depender do estado real de fundo
    // do banco (que pode mudar ao longo do tempo).
    const hugeBill = await prisma.bill.create({
      data: {
        description: `[${MARK}] invariant obrigação gigante`,
        amount: 500000,
        category: "Outros",
        accountId: checking.id,
        dueDate: new Date(NOW.getTime() + 86400000),
        status: "pending",
        source: "manual",
      },
    });
    created.bills.push(hugeBill.id);

    const result = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: card.id, amount: 900 },
    });
    check("invariante: cardFeasibility ainda é CAN_AUTHORIZE (limite gigante)", result.cardFeasibility.verdict === "CAN_AUTHORIZE");
    check(
      "invariante: freeMoney simulado é negativo de fato (obrigação sintética de 500000 dominando o cálculo)",
      isNegative(result.simulated.freeMoney),
      `freeMoneySimulado=${serializeMoney(result.simulated.freeMoney)}`
    );
    check("invariante: com freeMoney negativo, budgetSafety = NOT_SAFE (nunca SAFE)", result.budgetSafety.verdict === "NOT_SAFE");
    check(
      "invariante MANDATÓRIA (Fase 5.3E): cardFeasibility=CAN_AUTHORIZE + freeMoney negativo NUNCA produz verdict geral SAFE",
      result.verdict !== "SAFE",
      `verdict=${result.verdict}`
    );
  }

  // ==========================================================================
  // 7) CONTINGENCY_REALIZATION — usa a descrição REAL da contingência (nunca
  //    hardcoded), respeita timing explícito.
  // ==========================================================================
  {
    const contingency = await prisma.contingency.create({
      data: { description: `[${MARK}] Contingência simulada`, expectedAmount: 200, maxAmount: 800, status: "AWAITING_INFORMATION" },
    });
    created.contingencies.push(contingency.id);

    const nowResult = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: contingency.id, amount: 700, timing: "NOW" },
    });
    check("CONTINGENCY_REALIZATION (NOW): delta.freeMoney = -700 exato", eq(nowResult.delta.freeMoney, -700), serializeMoney(nowResult.delta.freeMoney).toString());
    check("CONTINGENCY_REALIZATION: explanation cita a descrição REAL da contingência (nunca hardcoded)", nowResult.explanation.some((e) => e.includes(contingency.description)));

    const futureResult = await simulateFinancialScenario({
      now: NOW,
      scenario: { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: contingency.id, amountField: "max", timing: "2026-12-01T00:00:00.000Z" },
    });
    check("CONTINGENCY_REALIZATION (futuro): freeMoney HOJE não muda (só entra na projeção)", eq(futureResult.delta.freeMoney, 0), serializeMoney(futureResult.delta.freeMoney).toString());
    check(
      "CONTINGENCY_REALIZATION (amountField=max): usa maxAmount real (800) da contingência — projeção do dia 90 (2026-12-01 cai dentro do horizonte de 2026-09-08+90d) reflete a saída de -800",
      eq(futureResult.delta.projectionCheckpoints.base.day90, -800),
      serializeMoney(futureResult.delta.projectionCheckpoints.base.day90).toString()
    );
  }

  // ==========================================================================
  // 8) Baseline immutability — chamar 2x com os mesmos parâmetros dá o MESMO
  //    baseline (sem drift, sem efeito colateral de uma chamada pra outra).
  // ==========================================================================
  {
    const fpBefore = await fingerprint();
    const r1 = await simulateFinancialScenario({ now: NOW, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 123.45 } });
    const r2 = await simulateFinancialScenario({ now: NOW, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 123.45 } });
    const fpAfter = await fingerprint();
    check("baseline immutability: freeMoney baseline idêntico entre as duas chamadas", eq(r1.baseline.freeMoney, r2.baseline.freeMoney));
    check("baseline immutability: freeMoney simulado idêntico entre as duas chamadas", eq(r1.simulated.freeMoney, r2.simulated.freeMoney));
    check("baseline immutability: NENHUM model financeiro muda de contagem entre as duas chamadas (zero write real)", JSON.stringify(fpBefore) === JSON.stringify(fpAfter), JSON.stringify({ fpBefore, fpAfter }));
  }

  // ==========================================================================
  // 9) Concurrency independence — duas simulações diferentes em paralelo não
  //    interferem uma na outra (cada uma é 100% leitura + memória local).
  // ==========================================================================
  {
    const [a, b] = await Promise.all([
      simulateFinancialScenario({ now: NOW, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 111 } }),
      simulateFinancialScenario({ now: NOW, scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 222 } }),
    ]);
    check("concurrency: cenário A (111) e B (222) mantêm baselines idênticos", eq(a.baseline.freeMoney, b.baseline.freeMoney));
    check("concurrency: delta A = -111 (não contaminado por B)", eq(a.delta.freeMoney, -111), serializeMoney(a.delta.freeMoney).toString());
    check("concurrency: delta B = -222 (não contaminado por A)", eq(b.delta.freeMoney, -222), serializeMoney(b.delta.freeMoney).toString());
  }

  // ==========================================================================
  // 10) Validação de entrada — nunca aceita silenciosamente valor inválido.
  // ==========================================================================
  {
    const negative = await expectThrow(() => simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: -50 } }));
    check("validação: amount negativo rejeitado com SimulationInputError", negative.threw && negative.isSimulationInputError);

    const nan = await expectThrow(() => simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: NaN } }));
    check("validação: amount NaN rejeitado", nan.threw && nan.isSimulationInputError);

    const infinite = await expectThrow(() => simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: Infinity } }));
    check("validação: amount Infinity rejeitado", infinite.threw && infinite.isSimulationInputError);

    const zero = await expectThrow(() => simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CASH_EXPENSE_NOW, amount: 0 } }));
    check("validação: amount zero rejeitado", zero.threw && zero.isSimulationInputError);

    const badInstallments = await expectThrow(() =>
      simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId: "qualquer", totalAmount: 100, installmentCount: 9999999 } })
    );
    check("validação: installmentCount absurdo (9999999x) rejeitado", badInstallments.threw && badInstallments.isSimulationInputError);

    const zeroInstallments = await expectThrow(() =>
      simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_INSTALLMENTS, cardId: "qualquer", totalAmount: 100, installmentCount: 0 } })
    );
    check("validação: installmentCount=0 rejeitado", zeroInstallments.threw && zeroInstallments.isSimulationInputError);

    const noCard = await expectThrow(() => simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CARD_PURCHASE_SINGLE, cardId: "cartao-inexistente-xyz", amount: 100 } }));
    check("validação: cardId inexistente rejeitado com SIMULATION_CARD_NOT_FOUND", noCard.threw && noCard.code === "SIMULATION_CARD_NOT_FOUND");

    const noContingency = await expectThrow(() =>
      simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: "contingencia-inexistente-xyz", amount: 100, timing: "NOW" } })
    );
    check("validação: contingencyId inexistente rejeitado com SIMULATION_CONTINGENCY_NOT_FOUND", noContingency.threw && noContingency.code === "SIMULATION_CONTINGENCY_NOT_FOUND");

    const contingencyNoTiming = await prisma.contingency.create({ data: { description: `[${MARK}] sem timing`, maxAmount: 100, status: "AWAITING_INFORMATION" } });
    created.contingencies.push(contingencyNoTiming.id);
    const missingTiming = await expectThrow(() =>
      simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: contingencyNoTiming.id, amount: 100 } })
    );
    check("validação: contingência sem timing rejeitada com SIMULATION_TIMING_REQUIRED (nunca assume NOW silenciosamente)", missingTiming.threw && missingTiming.code === "SIMULATION_TIMING_REQUIRED");

    const missingAmount = await expectThrow(() =>
      simulateFinancialScenario({ scenario: { type: SIMULATION_SCENARIO_TYPE.CONTINGENCY_REALIZATION, contingencyId: contingencyNoTiming.id, timing: "NOW" } })
    );
    check("validação: contingência sem amount/amountField rejeitada com SIMULATION_AMOUNT_REQUIRED (nunca inventa valor)", missingAmount.threw && missingAmount.code === "SIMULATION_AMOUNT_REQUIRED");

    const invalidType = await expectThrow(() => simulateFinancialScenario({ scenario: { type: "TIPO_INVENTADO_XYZ", amount: 100 } }));
    check("validação: scenario.type desconhecido rejeitado", invalidType.threw && invalidType.isSimulationInputError);
  }
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
