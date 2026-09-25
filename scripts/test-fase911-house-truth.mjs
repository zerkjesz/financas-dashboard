// Fase 9.1.1 — CONTAS DA CASA NA VERDADE FINANCEIRA (comprometido / freeMoney / safeToSpend / simulador /
// projeção / Home / Telegram). Fixtures próprias identificadas por MARK; TODAS as asserções são por DELTA
// (antes × depois) — nunca dependem do estado ambiente do DEV (regras/compromissos legítimos que já existam).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, compareMoney, serializeMoney, subtractMoney } from "../lib/money.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { buildProductFinancialSnapshot } from "../lib/productFinancialSnapshot.js";
import { computeSafeToSpend } from "../lib/freeMoney.js";
import { getHouseBillObligations, payHouseBill, undoHouseBillPayment, listHouseBillInstances } from "../lib/houseBills.js";
import { simulateFinancialScenario } from "../lib/simulation/financialSimulator.js";
import { buildHomeModel } from "../lib/homeModel.js";
import { buildCommitmentsModel } from "../lib/compromissosModel.js";
import { handleReadIntent } from "../lib/telegramReads.js";
import { listUpcomingObligations } from "../lib/upcomingObligations.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { performUndo } from "../lib/compromissosActions.js";
import { DomainError } from "../lib/domainErrors.js";

const MARK = "TESTE_F911";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const n = (x) => Number(serializeMoney(money(x)));
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.005;
async function code(fn) { try { await fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${String(e.message).split("\n").pop().slice(0, 80)}`; } }

const NOW = new Date("2026-09-25T15:00:00.000Z");
const MONTH = "2026-09";
const created = { accounts: [], rules: [] };
const START = new Date();

async function mkAccount(slug, type, balance) {
  const a = await prisma.account.create({ data: { slug: `teste-f911-${slug}`, name: `${MARK} ${slug}`, type } });
  created.accounts.push(a.id);
  await prisma.balanceAdjustment.create({ data: { accountId: a.id, newBalance: balance, note: MARK, source: "manual", occurredAt: new Date("2026-01-01T00:00:00Z") } });
  return a;
}
async function mkRule(data) {
  const r = await prisma.recurringRule.create({ data: { kind: "expense", isActive: true, category: "Moradia", ...data, name: `${MARK} ${data.name}` } });
  created.rules.push(r.id);
  return r;
}
async function truth() {
  const e = await buildFinancialEngineSummary({ now: NOW });
  return {
    e,
    free: n(e.freeMoney),
    safe: n(e.safeToSpend),
    horizon: n(e.obligations.currentHorizon),
    cash: n(e.balances.unrestrictedCash),
    known: n(e.obligations.houseBills.pendingKnownAmount),
    mineKnown: e.obligations.currentHorizonItems.filter((i) => i.houseBill && i.description.startsWith(MARK)).map((i) => n(i.amount)),
    unpricedMine: e.obligations.houseBills.unpricedPendingBills.filter((b) => b.name.startsWith(MARK)),
    unpricedTotal: e.obligations.houseBills.unpricedPendingBillsCount,
  };
}

async function cleanup() {
  const bills = await prisma.bill.findMany({ where: { recurringRuleId: { in: created.rules } }, select: { id: true } });
  await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: { in: bills.map((b) => b.id) } } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { model: "bill", rawMessage: "web", createdAt: { gte: START } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { OR: [{ description: { contains: MARK } }, { accountId: { in: created.accounts } }] } }).catch(() => {});
  await prisma.bill.deleteMany({ where: { recurringRuleId: { in: created.rules } } }).catch(() => {});
  await prisma.recurringRule.deleteMany({ where: { id: { in: created.rules } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: created.accounts } } }).catch(() => {});
  const left = await Promise.all([prisma.account.count({ where: { slug: { contains: "teste-f911" } } }), prisma.recurringRule.count({ where: { name: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } }), prisma.bill.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((c) => c === 0), JSON.stringify(left));
}

async function main() {
  const itau = await mkAccount("itau", "checking", 5000);
  const t0 = await truth();

  // ============ [1] Bill PENDING fixa reduz freeMoney / entra em comprometido
  const aluguel = await mkRule({ name: "Aluguel", amount: 1000, dayOfMonth: 28, amountKind: "FIXED" });
  const t1 = await truth();
  check("[1] aluguel pendente R$1.000: comprometido (currentHorizon) +1000", near(t1.horizon - t0.horizon, 1000), String(t1.horizon - t0.horizon));
  check("[1] aluguel pendente: freeMoney −1000 e caixa inalterado (nada pago)", near(t1.free - t0.free, -1000) && near(t1.cash, t0.cash));
  const st = computeSafeToSpend(money(t1.free), t1.e.safetyMarginPercent);
  check("[1] safeToSpend continua derivado do freeMoney (regra do motor, margem de AppSettings)", near(st.safeToSpend, t1.safe));
  check("[1] o item entra no breakdown como Bill de conta da casa (1 vez só)", t1.mineKnown.length === 1 && near(t1.mineKnown[0], 1000));

  // ============ [2] pagamento cria Expense e remove a obrigação SEM double count
  const pay = await payHouseBill({ ruleId: aluguel.id, cycleMonth: MONTH, accountId: itau.id, when: "hoje", now: NOW });
  const t2 = await truth();
  check("[2] pago: obrigação pendente sai (comprometido volta ao nível inicial)", near(t2.horizon, t0.horizon) && t2.mineKnown.length === 0);
  check("[2] pago: caixa −1000 (Expense real) e freeMoney IGUAL ao de antes do pagamento (zero double count)", near(t2.cash - t1.cash, -1000) && near(t2.free, t1.free), `free ${t2.free} vs ${t1.free}`);
  check("[2] Bill PAID nunca é obrigação: não aparece no breakdown", !t2.e.obligations.currentHorizonItems.some((i) => i.houseBill && i.description === `${MARK} Aluguel`));
  const expRows = await prisma.expense.findMany({ where: { billId: pay.bill.id } });
  check("[2] exatamente 1 Expense vinculada ao pagamento", expRows.length === 1 && near(expRows[0].amount, 1000));
  await undoHouseBillPayment(pay.bill.id, { expectedUpdatedAt: pay.bill.updatedAt.toISOString() });
  const t2b = await truth();
  check("[2] desfazer: volta a pendente (freeMoney −1000 de novo, sem sobras)", near(t2b.free, t1.free) && near(t2b.horizon, t1.horizon) && near(t2b.cash, t0.cash));

  // ============ [3] energia: aguardando valor -> nunca zero fictício; depois de informar
  const energia = await mkRule({ name: "Energia", amountKind: "VARIABLE", referenceMin: 400, referenceMax: 450 });
  const t3 = await truth();
  check("[3] energia aguardando valor: exposta em unpricedPendingBills (Home/API podem avisar)", t3.unpricedMine.length === 1 && t3.unpricedTotal === t2b.unpricedTotal + 1, JSON.stringify(t3.unpricedMine.map((b) => b.name)));
  check("[3] energia aguardando valor NÃO reduz freeMoney nem entra em comprometido (nenhum valor inventado)", near(t3.free, t2b.free) && near(t3.horizon, t2b.horizon) && !t3.mineKnown.some((v) => v === 0));
  check("[3] sem Expense/Bill fabricada para a energia", (await prisma.bill.count({ where: { recurringRuleId: energia.id } })) === 0 && (await prisma.expense.count({ where: { description: { contains: `${MARK} Energia` } } })) === 0);
  check("[3] pagar energia sem valor → INVALID", (await code(() => payHouseBill({ ruleId: energia.id, cycleMonth: MONTH, accountId: itau.id, now: NOW }))) === "INVALID");
  const pEn = await payHouseBill({ ruleId: energia.id, cycleMonth: MONTH, accountId: itau.id, amount: 431.2, now: NOW });
  const t3b = await truth();
  check("[3] energia paga com valor real R$431,20: deixa de estar 'sem valor'", t3b.unpricedMine.length === 0 && t3b.unpricedTotal === t2b.unpricedTotal);
  check("[3] energia paga: caixa −431,20 (valor real, não estimativa) e freeMoney −431,20", near(t3b.cash - t3.cash, -431.2) && near(t3b.free - t3.free, -431.2));
  await undoHouseBillPayment(pEn.bill.id, { expectedUpdatedAt: pEn.bill.updatedAt.toISOString() });

  // ============ [4] faxina 0/2, 1/2, 2/2
  const faxina = await mkRule({ name: "Faxina", amount: 260, partsPerCycle: 2, cadence: "BIWEEKLY", amountKind: "FIXED" });
  const f0 = await truth();
  check("[4] faxina 0/2: R$260 pendentes (2 x R$130), cada visita uma obrigação", near(f0.mineKnown.reduce((a, b) => a + b, 0) - t2b.mineKnown.reduce((a, b) => a + b, 0), 260) && f0.mineKnown.filter((v) => near(v, 130)).length === 2, JSON.stringify(f0.mineKnown));
  const v1 = await payHouseBill({ ruleId: faxina.id, cycleMonth: MONTH, part: 1, accountId: itau.id, now: NOW });
  const f1 = await truth();
  check("[4] faxina 1/2: R$130 pendentes; freeMoney inalterado pelo pagamento em si (sai da obrigação, entra no caixa)", near(f0.horizon - f1.horizon, 130) && near(f1.free, f0.free) && f1.mineKnown.filter((v) => near(v, 130)).length === 1, `${f1.free} vs ${f0.free}`);
  const v2 = await payHouseBill({ ruleId: faxina.id, cycleMonth: MONTH, part: 2, accountId: itau.id, now: NOW });
  const f2 = await truth();
  check("[4] faxina 2/2: R$0 pendente da faxina", near(f0.horizon - f2.horizon, 260) && near(f2.free, f0.free) && !f2.e.obligations.currentHorizonItems.some((i) => i.houseBill && /Faxina/.test(i.description) && i.description.startsWith(MARK)));

  // ============ [5] reabrir / desfazer uma visita (serviço de domínio + stale guard)
  const model = await buildCommitmentsModel({ now: NOW });
  const fx = model.items.find((i) => i.name === `${MARK} Faxina`);
  check("[5] modelo expõe token de reabrir por visita paga (paidParts com undo)", fx.casa.paidParts.length === 2 && fx.casa.paidParts.every((p) => p.undo && p.undo.kind === "house" && p.undo.expectedUpdatedAt), JSON.stringify(fx.casa.paidParts.map((p) => [p.part, !!p.undo])));
  const part1 = fx.casa.paidParts.find((p) => p.part === 1);
  const cashBeforeReopen = n(await computeAccountBalance(itau.id));
  await performUndo(part1.undo);
  const f3 = await truth();
  const after = (await listHouseBillInstances({ cycleMonth: MONTH, now: NOW })).filter((i) => i.name === `${MARK} Faxina`);
  check("[5] reabrir visita 1: volta PENDING, visita 2 segue paga", after.find((i) => i.part === 1).status === "PENDING" && after.find((i) => i.part === 2).status === "PAID");
  check("[5] reabrir: Expense removida (saldo +130) e obrigação R$130 volta ao comprometido", near(n(await computeAccountBalance(itau.id)) - cashBeforeReopen, 130) && near(f3.horizon - f2.horizon, 130) && near(f3.free, f2.free));
  const cnt0 = await prisma.expense.count({ where: { description: { contains: MARK } } });
  check("[5] reabrir a mesma visita de novo (já reaberta) → NOT_FOUND/NOT_PAID e zero escrita", ["NOT_FOUND", "NOT_PAID"].includes(await code(() => performUndo(part1.undo))) && (await prisma.expense.count({ where: { description: { contains: MARK } } })) === cnt0);
  const part2 = (await buildCommitmentsModel({ now: NOW })).items.find((i) => i.name === `${MARK} Faxina`).casa.paidParts.find((p) => p.part === 2);
  check("[5] token com updatedAt errado → STALE e visita 2 continua paga", (await code(() => performUndo({ ...part2.undo, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))) === "STALE" && (await prisma.bill.findUnique({ where: { id: part2.undo.id } })).status === "paid");
  await performUndo(part2.undo);

  // ============ [6] só a competência CORRENTE entra (nada de competência futura projetada)
  const rent2 = await mkRule({ name: "Aluguel do mês seguinte", amount: 700, dayOfMonth: 5, amountKind: "FIXED" });
  const hOct = await getHouseBillObligations({ now: NOW, horizonEnd: new Date("2026-10-24T00:00:00.000Z") });
  const mine = (h) => h.items.filter((i) => i.description === `${MARK} Aluguel do mês seguinte`).map((i) => i.cycleMonth).sort();
  check("[6] mesmo com horizonte até 24/10: só a competência corrente (2026-09) entra; o aluguel de 05/10 fica para quando outubro virar", mine(hOct).join() === "2026-09", mine(hOct).join());
  check("[6] quando a competência vira (now em outubro), a de outubro passa a ser a corrente", (await getHouseBillObligations({ now: new Date("2026-10-02T15:00:00.000Z") })).items.filter((i) => i.description === `${MARK} Aluguel do mês seguinte`).map((i) => i.cycleMonth).join() === "2026-10");
  await prisma.recurringRule.update({ where: { id: rent2.id }, data: { isActive: false } });

  // ============ [7] simulador considera as contas da casa (mesma verdade do produto)
  const sim0 = await simulateFinancialScenario({ now: NOW, scenario: { type: "CASH_EXPENSE_NOW", amount: 100 } });
  check("[7] simulador: baseline.currentHorizonObligations inclui as contas da casa pendentes (= motor)", near(sim0.baseline.currentHorizonObligations, (await truth()).horizon) && sim0.houseBills.includedPendingKnownCount >= 1);
  check("[7] simulador: conta variável sem valor NÃO é assumida — resultado avisa que a simulação não a inclui", sim0.houseBills.unpricedPendingBillsCount >= 0 && (sim0.houseBills.unpricedPendingBillsCount === 0 || /não inclui/.test(sim0.houseBills.note)));
  const energia2 = await mkRule({ name: "Energia B", amountKind: "VARIABLE" });
  const sim1 = await simulateFinancialScenario({ now: NOW, scenario: { type: "CASH_EXPENSE_NOW", amount: 100 } });
  check("[7] simulador: com energia sem valor, nota explícita e freeMoney base idêntico", sim1.houseBills.unpricedPendingBillsCount === sim0.houseBills.unpricedPendingBillsCount + 1 && /não inclui/.test(sim1.houseBills.note) && near(sim1.baseline.freeMoney, sim0.baseline.freeMoney), sim1.houseBills.note);
  check("[7] simulador: gastar R$100 reduz o freeMoney simulado em R$100 sobre a base COM contas da casa", near(subtractMoney(sim1.simulated.freeMoney, sim1.baseline.freeMoney), -100));

  // ============ [8] Home / snapshot / Telegram expõem a conta sem valor
  const snap = await buildProductFinancialSnapshot({ now: NOW });
  check("[8] snapshot.houseBills expõe unpricedPendingBillsCount/unpricedPendingBills", snap.houseBills.unpricedPendingBillsCount >= 1 && snap.houseBills.unpricedPendingBills.some((b) => b.name === `${MARK} Energia B`));
  const home = await buildHomeModel({ now: NOW });
  check("[8] Home: hero.unpricedBills.count >= 1 com texto 'sem N conta(s) ainda sem valor'", home.hero.unpricedBills.count >= 1 && /ainda sem valor/.test(home.hero.unpricedBills.text) && home.hero.unpricedBills.names.includes(`${MARK} Energia B`));
  const casaPart = home.hero.committedParts.find((p) => p.kind === "casa");
  check("[8] Home: 'Contas da casa' aparece UMA vez em comprometido (agrupada), e cash − comprometido − protegido = livre", !!casaPart && home.hero.committedParts.filter((p) => p.kind === "casa").length === 1 && Math.abs(home.hero.cash - home.hero.committed - home.hero.protectedMoney - home.hero.free) < 0.02);
  const tg = await handleReadIntent("read_free_money", { now: NOW });
  check("[8] Telegram: lista as contas da casa e avisa 'calculado sem N conta(s) ainda sem valor'", /calculado sem/.test(tg) && /Aluguel/.test(tg), tg.split("\n").slice(-2).join(" | "));

  // ============ [9] sem double count com Bill persistida pendente da mesma competência
  const t9before = await truth();
  await prisma.bill.create({ data: { description: `${MARK} Aluguel`, amount: 1000, category: "Moradia", accountId: itau.id, dueDate: new Date("2026-09-28T00:00:00Z"), recurringRuleId: aluguel.id, cycleMonth: MONTH, part: 1, status: "pending", source: "manual", confidence: "CONFIRMED" } });
  const t9 = await truth();
  check("[9] Bill pendente persistida da mesma competência conta UMA vez (chave regra:competência:parte)", t9.mineKnown.filter((v) => near(v, 1000)).length === 1 && near(t9.horizon, t9before.horizon) && near(t9.free, t9before.free), JSON.stringify(t9.mineKnown));
  const up = await listUpcomingObligations({ now: NOW });
  check("[9] 'Próximas obrigações': aluguel da competência aparece 1x (sem duplicar Bill persistida + projetada)", up.filter((i) => i.kind === "bill" && i.name === `${MARK} Aluguel` && +i.date === +new Date("2026-09-28T00:00:00Z")).length === 1);

  // ============ [10] projeção de caixa inclui a conta com vencimento conhecido (delta por checkpoint)
  await prisma.bill.deleteMany({ where: { recurringRuleId: aluguel.id, status: "pending" } }); // fixture do [9]: sai antes da comparação de projeção
  const p1 = (await truth()).e.projections.base.checkpoints;
  await prisma.recurringRule.update({ where: { id: aluguel.id }, data: { isActive: false } });
  const p0 = (await truth()).e.projections.base.checkpoints;
  check("[10] projeção BASE: a conta pendente (28/09) reduz o caixa projetado em 30 dias em R$1.000 vs. sem ela", near(n(p0.day30.projectedCash) - n(p1.day30.projectedCash), 1000), `${n(p0.day30.projectedCash)} vs ${n(p1.day30.projectedCash)}`);

  // ============ [11] GET/leitura continua sem escrever
  const c0 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.recurringRule.count(), prisma.telegramCorrectionAudit.count()]);
  await truth(); await buildHomeModel({ now: NOW }); await buildCommitmentsModel({ now: NOW }); await listUpcomingObligations({ now: NOW }); await handleReadIntent("read_summary", { now: NOW });
  const c1 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.recurringRule.count(), prisma.telegramCorrectionAudit.count()]);
  check("[11] motor + Home + Compromissos + Próximas + Telegram: contagens IDÊNTICAS (zero escrita em leitura)", JSON.stringify(c0) === JSON.stringify(c1), JSON.stringify([c0, c1]));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
