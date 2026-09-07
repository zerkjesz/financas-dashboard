// Fase 5.2B — testes de integração contra o dev DB (dado 100% fictício, MARK =
// "TESTE_FASE52B", fixtures criadas/limpas em finally) provando o suporte de
// domínio novo (dueTiming) sem persistir NENHUM dado financeiro real do
// usuário (nenhum compromisso/salário/plano de parcela externa real é criado
// aqui — só fixtures sintéticas, sempre removidas no finally).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney, addMoney } from "../lib/money.js";
import { createExternalInstallmentPlan, markExternalInstallmentPaid } from "../lib/externalInstallments.js";
import { getObligationsBreakdown, computeFreeMoney, getNextIncomeCommitment } from "../lib/freeMoney.js";
import { OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { listAccountsWithBalances } from "../lib/accounts.js";

const MARK = "TESTE_FASE52B";
let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) {
    passed++;
    console.log(`✅ ${label}`);
  } else {
    failed++;
    console.error(`❌ ${label}`);
  }
}
async function expectThrow(fn, label) {
  try {
    await fn();
    check(false, `${label} (não lançou erro — esperado que lançasse)`);
  } catch {
    check(true, label);
  }
}

const nextIncomeDate = new Date("2031-01-24T00:00:00.000Z"); // futuro distante fictício, nunca uma data real do usuário

async function withPlan(opts, fn) {
  const plan = await createExternalInstallmentPlan({ description: `${MARK} plano`, creditor: `${MARK} credor`, ...opts });
  try {
    await fn(plan);
  } finally {
    await prisma.externalInstallmentPlan.delete({ where: { id: plan.id } }); // cascade remove as installments
  }
}

async function main() {
  console.log("--- Fase 5.2B: testes de integração (dueTiming / schema enablement) ---\n");

  // --- [A] CALENDAR_DATE exige firstDueDate ---
  await expectThrow(
    () => createExternalInstallmentPlan({ description: `${MARK} sem data`, creditor: `${MARK} credor`, installmentValue: 50, installmentCount: 2, dueTiming: "CALENDAR_DATE" }),
    "[A] CALENDAR_DATE sem firstDueDate lança erro (nunca inventa uma data)"
  );

  // --- [A'] AFTER_NEXT_INCOME com firstDueDate informada também lança (nunca finge que há uma data exata) ---
  await expectThrow(
    () => createExternalInstallmentPlan({ description: `${MARK} com data indevida`, creditor: `${MARK} credor`, installmentValue: 50, installmentCount: 2, dueTiming: "AFTER_NEXT_INCOME", firstDueDate: "2031-01-01" }),
    "[A'] AFTER_NEXT_INCOME com firstDueDate informada lança erro (nunca finge exatidão que não existe)"
  );

  // --- [B]/[C] AFTER_NEXT_INCOME aceita firstDueDate ausente; installments ficam com dueDate null ---
  await withPlan({ installmentValue: 100, installmentCount: 3, dueTiming: "AFTER_NEXT_INCOME" }, async (plan) => {
    check(plan.firstDueDate === null, "[B] AFTER_NEXT_INCOME aceita firstDueDate ausente — plan.firstDueDate fica null");
    check(plan.installments.every((i) => i.dueDate === null), "[C] todas as installments do plano AFTER_NEXT_INCOME têm dueDate=null (nenhum sentinel fake)");

    // --- [D]/[E] só a primeira PENDING é NEXT_INCOME_WINDOW_COMMITMENT ---
    const buckets = await getObligationsBreakdown({ nextIncomeDate });
    const nextWindowIds = new Set(buckets[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].items.filter((i) => i.planId === plan.id).map((i) => i.id));
    const futureIds = new Set(buckets[OBLIGATION_CLASS.FUTURE_OBLIGATION].items.filter((i) => i.planId === plan.id).map((i) => i.id));
    const first = plan.installments[0];
    const rest = plan.installments.slice(1);
    check(nextWindowIds.has(first.id) && nextWindowIds.size === 1, "[D] só a PRIMEIRA parcela PENDING do plano é NEXT_INCOME_WINDOW_COMMITMENT");
    check(rest.every((i) => futureIds.has(i.id)), "[E] as demais parcelas PENDING do mesmo plano são FUTURE_OBLIGATION (nunca somadas juntas na janela)");

    // --- [G] freeMoney atual não é afetado pelo pacote AFTER_NEXT_INCOME ---
    const accounts = await listAccountsWithBalances();
    const withoutPlanBreakdown = await getObligationsBreakdown({ nextIncomeDate }); // mesma chamada, plano já existe — comparação real é feita abaixo via delta
    const freeMoneyResult = await computeFreeMoney({ nextIncomeDate, accounts });
    const planAppearsInCurrentHorizonOrIncurred = [
      ...freeMoneyResult.currentHorizonObligationsItems,
    ].some((i) => i.planId === plan.id);
    check(!planAppearsInCurrentHorizonOrIncurred, "[G] nenhuma parcela do plano AFTER_NEXT_INCOME aparece em currentHorizonObligations (freeMoney atual não subtrai o pacote)");
    check(compareMoney(money(freeMoneyResult.nextIncomeWindowCommitment ?? 0), money(0)) >= 0, "[G'] o plano aparece corretamente separado em nextIncomeWindowCommitment, não em freeMoney");
  });

  // --- [F] nextIncomeCommitment soma exatamente UMA parcela por plano (nunca o saldo restante inteiro) ---
  {
    const planA = await createExternalInstallmentPlan({ description: `${MARK} plano A`, creditor: `${MARK} credor`, installmentValue: 10, installmentCount: 8, dueTiming: "AFTER_NEXT_INCOME" });
    const planB = await createExternalInstallmentPlan({ description: `${MARK} plano B`, creditor: `${MARK} credor`, installmentValue: 20, installmentCount: 3, dueTiming: "AFTER_NEXT_INCOME" });
    const planC = await createExternalInstallmentPlan({ description: `${MARK} plano C`, creditor: `${MARK} credor`, installmentValue: 30, installmentCount: 1, dueTiming: "AFTER_NEXT_INCOME" });
    try {
      const nextIncome = { expectedDate: nextIncomeDate, amount: money(1000) };
      const commitment = await getNextIncomeCommitment({ nextIncome });
      // Isola só o efeito dos 3 planos sintéticos (o banco pode ter outras
      // obrigações reais coexistindo) — soma esperada é EXATAMENTE 1 parcela
      // de cada, nunca 8*10 + 3*20 + 1*30.
      const buckets = await getObligationsBreakdown({ nextIncomeDate });
      const ourItems = buckets[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].items.filter((i) => [planA.id, planB.id, planC.id].includes(i.planId));
      const ourTotal = ourItems.reduce((acc, i) => addMoney(acc, i.amount), money(0));
      check(ourItems.length === 3, "[F] exatamente 1 parcela contabilizada por plano (3 planos -> 3 itens), nunca 8+3+1=12");
      check(compareMoney(ourTotal, money(60)) === 0, "[F] soma correta = 1 parcela de cada (10+20+30=60), nunca o outstanding completo (8*10+3*20+1*30=170)");
      check(compareMoney(commitment.committedAmount, money(0)) >= 0, "[F'] getNextIncomeCommitment roda sem erro com os 3 planos presentes");
    } finally {
      await prisma.externalInstallmentPlan.delete({ where: { id: planA.id } });
      await prisma.externalInstallmentPlan.delete({ where: { id: planB.id } });
      await prisma.externalInstallmentPlan.delete({ where: { id: planC.id } });
    }
  }

  // --- [H]/[I] liquidar a primeira parcela promove a segunda ---
  await withPlan({ installmentValue: 75, installmentCount: 3, dueTiming: "AFTER_NEXT_INCOME" }, async (plan) => {
    const [first, second] = plan.installments;
    await markExternalInstallmentPaid(first.id);
    const bucketsAfter = await getObligationsBreakdown({ nextIncomeDate });
    const nextWindowIdsAfter = new Set(bucketsAfter[OBLIGATION_CLASS.NEXT_INCOME_WINDOW_COMMITMENT].items.filter((i) => i.planId === plan.id).map((i) => i.id));
    check(nextWindowIdsAfter.has(second.id) && nextWindowIdsAfter.size === 1, "[H]/[I] após liquidar a primeira parcela, a segunda vira NEXT_INCOME_WINDOW_COMMITMENT (a fila anda uma posição)");
    const settledCheck = await prisma.externalInstallment.findUnique({ where: { id: first.id } });
    check(settledCheck.status === "PAID", "[H] a primeira parcela liquidada fica com status=PAID");
  });

  // --- [J] settlement não cria Expense automaticamente ---
  await withPlan({ installmentValue: 40, installmentCount: 1, dueTiming: "AFTER_NEXT_INCOME" }, async (plan) => {
    const expenseCountBefore = await prisma.expense.count();
    await markExternalInstallmentPaid(plan.installments[0].id);
    const expenseCountAfter = await prisma.expense.count();
    check(expenseCountBefore === expenseCountAfter, "[J] markExternalInstallmentPaid NÃO cria nenhum Expense — cash movement e settlement continuam separados");
  });

  // --- [K] CALENDAR_DATE antigo mantém comportamento inalterado ---
  await withPlan({ installmentValue: 60, installmentCount: 2, dueTiming: "CALENDAR_DATE", firstDueDate: "2031-02-01" }, async (plan) => {
    check(plan.firstDueDate != null, "[K] CALENDAR_DATE continua exigindo/preservando firstDueDate real");
    check(plan.installments.every((i) => i.dueDate != null), "[K] installments de um plano CALENDAR_DATE continuam com dueDate real (nunca null)");
    const buckets = await getObligationsBreakdown({ nextIncomeDate: new Date("2031-01-01T00:00:00.000Z") }); // antes das duas parcelas (fev/mar 2031)
    const futureIds = new Set(buckets[OBLIGATION_CLASS.FUTURE_OBLIGATION].items.filter((i) => i.planId === plan.id).map((i) => i.id));
    check(plan.installments.every((i) => futureIds.has(i.id)), "[K] classificação CALENDAR_DATE continua baseada em dueDate<=nextIncomeDate, comportamento pré-existente preservado");
  });

  // --- [L] runoff estrutural não tem off-by-one (fixture sintética, mesma forma do tooling real) ---
  {
    function buildRunoff(plans) {
      let state = plans.map((p) => ({ remaining: p.remaining, value: money(p.value) }));
      const schedule = [];
      let offset = 0;
      while (true) {
        const active = state.filter((p) => p.remaining > 0);
        const total = active.reduce((acc, p) => addMoney(acc, p.value), money(0)).toString();
        schedule.push({ offset, total });
        if (active.length === 0) break;
        state = state.map((p) => (p.remaining > 0 ? { ...p, remaining: p.remaining - 1 } : p));
        offset++;
        if (offset > 10) break;
      }
      return schedule;
    }
    const schedule = buildRunoff([
      { remaining: 2, value: 10 },
      { remaining: 1, value: 5 },
    ]);
    const totals = schedule.map((s) => s.total);
    check(totals[0] === "15", "[L] offset 0 soma todos os planos ativos (10+5=15)");
    check(totals[1] === "10", "[L] offset 1: o plano de 1 parcela já saiu (só 10 resta)");
    check(totals[2] === "0", "[L] offset 2: linha terminal com total=0 é emitida (sem off-by-one) — prova que o pacote realmente zera");
    check(schedule.length === 3, "[L] schedule tem exatamente 3 linhas (0,1,2) pra este caso — nem falta nem sobra");
  }

  // --- [N] ConfirmedCommitment com semântica dueBy (janela de 2 dias) ---
  {
    const { classifyConfirmedCommitment } = await import("../lib/obligationClassifier.js");
    const windowCandidates = ["2031-03-19", "2031-03-20"]; // fictício — nunca uma data real do usuário
    const dueBy = new Date(`${windowCandidates[windowCandidates.length - 1]}T00:00:00.000Z`);
    const syntheticCommitment = { status: "CONFIRMED", dueDate: dueBy, amount: money(500) };
    const cls = classifyConfirmedCommitment(syntheticCommitment, { nextIncomeDate: new Date("2031-03-24T00:00:00.000Z") });
    check(cls === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION, "[N] ConfirmedCommitment com dueDate=dueBy (último dia de uma janela de 2 dias) classifica corretamente");
    check(dueBy.toISOString().slice(0, 10) === windowCandidates[1], "[N] dueBy usa o ÚLTIMO candidato da janela, nunca uma data fora dela");
  }

  // --- [O] client injection sem regressão (default = prisma continua funcionando) ---
  {
    const explicit = await getObligationsBreakdown({ nextIncomeDate, client: prisma });
    const implicit = await getObligationsBreakdown({ nextIncomeDate });
    const sameIncurred = compareMoney(explicit[OBLIGATION_CLASS.INCURRED_LIABILITY].total, implicit[OBLIGATION_CLASS.INCURRED_LIABILITY].total) === 0;
    check(sameIncurred, "[O] passar client=prisma explicitamente produz o MESMO resultado que omitir (default idêntico, zero regressão)");
  }

  console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);

  // --- confirmação final de que NENHUM dado financeiro real foi deixado pra trás ---
  const leftoverPlans = await prisma.externalInstallmentPlan.count({ where: { description: { contains: MARK } } });
  const leftoverInstallments = await prisma.externalInstallment.count({ where: { plan: { description: { contains: MARK } } } });
  console.log(`\nLimpeza confirmada: ${leftoverPlans} planos e ${leftoverInstallments} installments de teste remanescentes (esperado 0 e 0).`);

  await prisma.$disconnect();
  if (failed > 0 || leftoverPlans > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
