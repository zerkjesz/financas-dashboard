// Fase 9.1.2 — HORIZONTE FINANCEIRO != COMPETÊNCIA. A regra canônica: uma obrigação reduz o dinheiro
// disponível AGORA quando vence ATÉ a próxima renda (dueDate <= nextIncomeDate), mesmo que esteja em
// outra competência. Cenário obrigatório: hoje 25/09/2026, próxima renda 24/10/2026, aluguel R$1.000 com
// vencimento 05/10/2026. Fixtures MARK; asserções por DELTA (independem do estado ambiente do DEV).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney } from "../lib/money.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { computeSafeToSpend, getObligationsBreakdown } from "../lib/freeMoney.js";
import { getHouseBillObligations, payHouseBill, undoHouseBillPayment } from "../lib/houseBills.js";
import { simulateFinancialScenario } from "../lib/simulation/financialSimulator.js";
import { buildHomeModel } from "../lib/homeModel.js";
import { buildCommitmentsModel } from "../lib/compromissosModel.js";
import { handleReadIntent } from "../lib/telegramReads.js";
import { listUpcomingObligations } from "../lib/upcomingObligations.js";
import { sectionsFor } from "../app/components/v4/compromissosView.js";
import { realizeSeptemberSalary } from "./lib/horizonFixture.js";

const MARK = "TESTE_F912";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const n = (x) => Number(serializeMoney(money(x)));
const near = (a, b) => Math.abs(n(a) - n(b)) < 0.005;
const NOW = new Date("2026-09-25T15:00:00.000Z");
const NEXT = new Date("2026-10-24T00:00:00.000Z");
const created = { accounts: [], rules: [] };
const START = new Date();
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function mkRule(data) {
  const r = await prisma.recurringRule.create({ data: { kind: "expense", isActive: true, category: "Moradia", ...data, name: `${MARK} ${data.name}` } });
  created.rules.push(r.id);
  return r;
}
async function truth() {
  const e = await buildFinancialEngineSummary({ now: NOW });
  const mine = e.obligations.currentHorizonItems.filter((i) => i.houseBill && i.description.startsWith(MARK));
  return { e, free: n(e.freeMoney), safe: n(e.safeToSpend), horizon: n(e.obligations.currentHorizon), cash: n(e.balances.unrestrictedCash), mine, unpriced: e.obligations.houseBills.unpricedPendingBills.filter((b) => b.name.startsWith(MARK)) };
}

async function cleanup() {
  const bills = await prisma.bill.findMany({ where: { recurringRuleId: { in: created.rules } }, select: { id: true } });
  await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: { in: bills.map((b) => b.id) } } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { model: "bill", rawMessage: "web", createdAt: { gte: START } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { OR: [{ description: { contains: MARK } }, { accountId: { in: created.accounts } }] } }).catch(() => {});
  await prisma.bill.deleteMany({ where: { recurringRuleId: { in: created.rules } } }).catch(() => {});
  await prisma.recurringRule.deleteMany({ where: { id: { in: created.rules } } }).catch(() => {});
  await prisma.income.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: created.accounts } } }).catch(() => {});
  const left = await Promise.all([prisma.account.count({ where: { slug: { contains: "teste-f912" } } }), prisma.recurringRule.count({ where: { name: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } }), prisma.bill.count({ where: { description: { contains: MARK } } }), prisma.income.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((c) => c === 0), JSON.stringify(left));
}

async function main() {
  const acc = await prisma.account.create({ data: { slug: "teste-f912-itau", name: `${MARK} itau`, type: "checking" } });
  created.accounts.push(acc.id);
  await prisma.balanceAdjustment.create({ data: { accountId: acc.id, newBalance: 5000, note: MARK, source: "manual", occurredAt: new Date("2026-01-01T00:00:00Z") } });
  const fx = await realizeSeptemberSalary(prisma, { mark: MARK, accountId: acc.id, now: NOW });
  check("[0] cenário: hoje 25/09/2026, próxima renda 24/10/2026 (salário de setembro realizado por fixture)", fx.applied && iso(fx.next.expectedDate) === "2026-10-24" && fx.next.status !== "OVERDUE", JSON.stringify([fx.applied, fx.next?.expectedDate, fx.next?.status]));

  const b0 = await truth();
  const sim0 = await simulateFinancialScenario({ now: NOW, scenario: { type: "CASH_EXPENSE_NOW", amount: 100 } });
  const comp0 = await buildCommitmentsModel({ now: NOW });

  // aluguel R$1.000, vence dia 05; o de SETEMBRO já foi pago antes do Norte (sem Expense) — só o de OUTUBRO está em jogo
  const aluguel = await mkRule({ name: "Aluguel", amount: 1000, dayOfMonth: 5, amountKind: "FIXED" });
  await payHouseBill({ ruleId: aluguel.id, cycleMonth: "2026-09", accountId: acc.id, recordExpense: false, when: "hoje", now: NOW });
  const t1 = await truth();
  const oct = t1.mine.filter((i) => i.cycleMonth === "2026-10");

  // ============ A. committed inclui R$1.000 do aluguel de 05/10
  check("[A] comprometido (horizonte atual) inclui +R$1.000 do aluguel de 05/10 — mesmo com a competência corrente sendo setembro", near(t1.horizon - b0.horizon, 1000), String(t1.horizon - b0.horizon));
  check("[A] o item é o aluguel de OUTUBRO, vencimento 05/10, marcado como 'antes da próxima renda'", oct.length === 1 && iso(oct[0].dueDate) === "2026-10-05" && oct[0].beforeNextIncome === true && near(oct[0].amount, 1000) && t1.mine.length === 1);
  // ============ B. freeMoney reduz R$1.000
  check("[B] freeMoney atual reduz R$1.000 (caixa inalterado: nada foi pago ainda)", near(t1.free - b0.free, -1000) && near(t1.cash, b0.cash), `${b0.free} → ${t1.free}`);
  // ============ C. safeToSpend pela regra existente
  const expectedSafe = computeSafeToSpend(money(t1.free), t1.e.safetyMarginPercent).safeToSpend;
  check("[C] safeToSpend = regra do motor sobre o freeMoney reduzido", near(t1.safe, expectedSafe));
  const expectedSafeBefore = computeSafeToSpend(money(b0.free), b0.e.safetyMarginPercent).safeToSpend;
  check("[C] variação do seguro = variação prevista pela mesma regra (margem de AppSettings)", near(t1.safe - b0.safe, n(expectedSafe) - n(expectedSafeBefore)));
  // ============ D. simulador usa o MESMO baseline
  const sim1 = await simulateFinancialScenario({ now: NOW, scenario: { type: "CASH_EXPENSE_NOW", amount: 100 } });
  check("[D] simulador: baseline.currentHorizonObligations = comprometido do motor (inclui o aluguel de 05/10)", near(sim1.baseline.currentHorizonObligations, t1.horizon) && near(sim1.baseline.currentHorizonObligations - sim0.baseline.currentHorizonObligations, 1000));
  check("[D] simulador: baseline.freeMoney reduz R$1.000 e o cenário de −R$100 parte dessa base", near(n(sim1.baseline.freeMoney) - n(sim0.baseline.freeMoney), -1000) && near(n(sim1.simulated.freeMoney) - n(sim1.baseline.freeMoney), -100));
  // ============ E. before-next-income
  const comp1 = await buildCommitmentsModel({ now: NOW });
  const bi = comp1.beforeNextIncome;
  const rentBi = bi.items.find((i) => i.name === `${MARK} Aluguel`);
  check("[E] 'antes da próxima renda': o aluguel de 05/10 está listado, R$1.000, próxima renda 24/10", !!rentBi && rentBi.value === 1000 && iso(rentBi.casa.dueDate) === "2026-10-05" && bi.nextIncomeLabel === "24/10" && iso(bi.nextIncomeDate) === "2026-10-24", JSON.stringify(bi.items.map((i) => i.name)));
  check("[E] a lista 'antes da renda' do modelo bate com o que o motor comprometeu (mesma identidade regra:competência:parte)", t1.mine.every((m) => bi.items.some((i) => i.casa.ruleId === m.ruleId && i.casa.cycleMonth === m.cycleMonth && i.casa.part === m.part)));
  // ============ F. Compromissos expõe na seção apropriada
  const tabs = ["mes", "casa", "todos"].map((t) => sectionsFor(t, comp1));
  const sec = tabs[0].find((s) => s.id === "before");
  const card = sec?.items.find((c) => c.name === `${MARK} Aluguel`);
  check("[F] aba 'Este mês' tem a seção 'Antes da próxima renda' com o aluguel (Vence 05/10, R$1.000, chip 'Antes da renda')", !!card && sec.title === "Antes da próxima renda" && card.detail === "Vence 05/10" && card.chip === "Antes da renda" && /24\/10/.test(card.sub) && /1\.000,00/.test(card.valueTxt), JSON.stringify(card && [card.detail, card.chip, card.sub, card.valueTxt]));
  check("[F] a seção mostra o subtítulo 'Vencem até 24/10' com o total conhecido da seção (todas as contas antes da renda, inclusive as reais do DEV)", /Vencem até 24\/10/.test(sec.sub) && comp1.beforeNextIncome.knownTotal >= 1000 && sec.sub.includes(`R$ ${comp1.beforeNextIncome.knownTotal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`.replace(/\u00a0/g, " ")), sec.sub);
  check("[F] aba 'Contas da casa' e aba 'Todos' também expõem o item", tabs[1].some((s) => s.id === "before") && tabs[2][0].groups.some((g) => g.title === "Antes da próxima renda" && g.rows.some((r) => r.name === `${MARK} Aluguel`)));
  check("[F] o item é pagável pela mesma folha (payload de casa com competência 2026-10)", card.item.pay.kind === "house" && card.item.pay.cycleMonth === "2026-10" && card.item.pay.ruleId === aluguel.id);
  check("[F] o resumo do mês (competência) NÃO conta o aluguel de outubro (organização ≠ horizonte; só a regra de setembro entra no mês)", comp1.summary.total === comp0.summary.total + 1 && !comp1.items.some((i) => i.beforeNextIncome));
  // ============ Home: rastreabilidade
  const home = await buildHomeModel({ now: NOW });
  const parts = home.hero.committedParts;
  const rentPart = parts.find((p) => p.beforeNextIncome && /Aluguel/.test(p.label));
  check("[HOME] o aluguel de 05/10 aparece como linha PRÓPRIA do comprometido ('vence 05/10'), não escondido em 'outros'", !!rentPart && /05\/10/.test(rentPart.label) && rentPart.amount === 1000);
  check("[HOME] a soma das linhas explica 100% do comprometido (nenhum 'outros' oculto)", Math.abs(parts.reduce((a, p) => a + p.amount, 0) - home.hero.committed) < 0.02, `${parts.reduce((a, p) => a + p.amount, 0)} vs ${home.hero.committed}`);
  check("[HOME] cash − comprometido − protegido = livre; seguro reduzido junto", Math.abs(home.hero.cash - home.hero.committed - home.hero.protectedMoney - home.hero.free) < 0.02);
  const tg = await handleReadIntent("read_free_money", { now: NOW });
  check("[TELEGRAM] 'por que' lista o aluguel de outubro (até a próxima renda)", /Aluguel: R\$\s1\.000,00 \(até a próxima renda\)/.test(tg.replace(new RegExp(MARK + " ", "g"), "")), tg.split("\n").filter((l) => /Aluguel/.test(l)).join(" | "));
  const up = await listUpcomingObligations({ now: NOW });
  check("[UPCOMING] 'próximas obrigações' inclui o aluguel de 05/10 com a data real", up.some((i) => i.name === `${MARK} Aluguel` && iso(i.date) === "2026-10-05"));

  // ============ projeção: data real, sem antecipar
  const timeline = t1.e.projections.base.timeline.filter((e) => e.label === `${MARK} Aluguel`);
  check("[PROJEÇÃO] saída do aluguel aparece em 05/10 (data real) — e todas as saídas são futuras: nada antecipado para hoje", timeline.some((e) => iso(e.date) === "2026-10-05") && timeline.every((e) => new Date(e.date) > NOW), JSON.stringify(timeline.map((e) => iso(e.date))));
  const pWith = t1.e.projections.base.checkpoints;
  await prisma.recurringRule.update({ where: { id: aluguel.id }, data: { isActive: false } });
  const tOff = await truth();
  const pWithout = tOff.e.projections.base.checkpoints;
  check("[PROJEÇÃO] caixa projetado de HOJE não muda (nada antecipado); em 30 dias cai R$1.000 (timing de caixa ≠ disponibilidade, sem double count)", near(n(pWith.today.projectedCash), n(pWithout.today.projectedCash)) && near(n(pWithout.day30.projectedCash) - n(pWith.day30.projectedCash), 1000));
  await prisma.recurringRule.update({ where: { id: aluguel.id }, data: { isActive: true } });

  // ============ G. rent PAID => zero obrigação pendente
  const cashBefore = t1.cash;
  const pay = await payHouseBill({ ruleId: aluguel.id, cycleMonth: "2026-10", accountId: acc.id, when: "hoje", now: NOW });
  const t2 = await truth();
  const comp2 = await buildCommitmentsModel({ now: NOW });
  check("[G] aluguel de outubro PAGO: zero obrigação pendente dele (comprometido volta ao nível inicial)", t2.mine.length === 0 && near(t2.horizon, b0.horizon));
  check("[G] pago: caixa −1000 (Expense real) e freeMoney igual ao de antes do pagamento — sem double count", near(t2.cash - cashBefore, -1000) && near(t2.free, t1.free));
  check("[G] pago: some da seção 'Antes da próxima renda'", !comp2.beforeNextIncome.items.some((i) => i.name === `${MARK} Aluguel`));
  await undoHouseBillPayment(pay.bill.id, { expectedUpdatedAt: pay.bill.updatedAt.toISOString() });
  const t2b = await truth();
  check("[G] desfazer: volta a pendente (−1000 no livre de novo)", near(t2b.free, t1.free) && t2b.mine.length === 1);

  // ============ H. próxima renda ANTERIOR ao vencimento => não entra
  const bdBefore = await getObligationsBreakdown({ now: NOW, nextIncomeDate: new Date("2026-10-04T00:00:00.000Z") });
  const bdOn = await getObligationsBreakdown({ now: NOW, nextIncomeDate: new Date("2026-10-05T00:00:00.000Z") });
  const hasOct = (bd) => bd.CURRENT_HORIZON_OBLIGATION.items.some((i) => i.houseBill && i.description === `${MARK} Aluguel` && i.cycleMonth === "2026-10");
  check("[H] próxima renda em 04/10 (antes do vencimento de 05/10): o aluguel NÃO entra no horizonte atual", !hasOct(bdBefore));
  check("[H] próxima renda em 05/10 (mesmo dia): entra (dueDate <= próxima renda, inclusivo)", hasOct(bdOn));
  check("[H] o aluguel de 05/10 fora do horizonte não vira obrigação futura duplicada (nenhum item de casa em FUTURE_OBLIGATION)", !bdBefore.FUTURE_OBLIGATION.items.some((i) => i.houseBill));

  // ============ I. energia variável sem valor antes da renda
  const energia = await mkRule({ name: "Energia", amountKind: "VARIABLE", dayOfMonth: 10, referenceMin: 400, referenceMax: 450 });
  const t3 = await truth();
  const enOct = t3.unpriced.find((b) => b.cycleMonth === "2026-10");
  check("[I] energia sem valor com vencimento 10/10 (antes da renda): aparece em unpricedPendingBills (competência de outubro)", !!enOct && iso(enOct.dueDate) === "2026-10-10" && enOct.beforeNextIncome === true, JSON.stringify(t3.unpriced.map((b) => [b.cycleMonth, b.beforeNextIncome])));
  check("[I] NÃO vira R$0 artificial: comprometido/livre/seguro inalterados pela energia", near(t3.horizon, t2b.horizon) && near(t3.free, t2b.free) && near(t3.safe, t2b.safe) && !t3.mine.some((i) => /Energia/.test(i.description)));
  check("[I] nenhum valor fake: sem Bill/Expense criada para a energia", (await prisma.bill.count({ where: { recurringRuleId: energia.id } })) === 0 && (await prisma.expense.count({ where: { description: { contains: `${MARK} Energia` } } })) === 0);
  const home3 = await buildHomeModel({ now: NOW });
  check("[I] Home avisa: 'Seguro calculado sem N conta(s) ainda sem valor' com o nome da conta", home3.hero.unpricedBills.count >= 1 && /Seguro calculado sem/.test(home3.hero.unpricedBills.text) && home3.hero.unpricedBills.names.includes(`${MARK} Energia`));
  const comp3 = await buildCommitmentsModel({ now: NOW });
  const enBi = comp3.beforeNextIncome.items.find((i) => i.name === `${MARK} Energia`);
  check("[I] a energia de outubro fica localizável em 'Antes da próxima renda' como 'Aguardando valor'", !!enBi && enBi.awaitingValue === true && enBi.value == null && comp3.beforeNextIncome.unpricedCount >= 1);
  const sim3 = await simulateFinancialScenario({ now: NOW, scenario: { type: "CASH_EXPENSE_NOW", amount: 100 } });
  check("[I] simulador avisa que não inclui a conta sem valor e mantém o baseline", /não inclui/.test(sim3.houseBills.note) && near(sim3.baseline.freeMoney, sim1.baseline.freeMoney));

  // ============ dedupe por identidade semântica
  await prisma.bill.create({ data: { description: `${MARK} Aluguel`, amount: 1000, category: "Moradia", accountId: acc.id, dueDate: new Date("2026-10-05T00:00:00Z"), recurringRuleId: aluguel.id, cycleMonth: "2026-10", part: 1, status: "pending", source: "manual", confidence: "CONFIRMED" } });
  const t4 = await truth();
  check("[DEDUP] Bill persistida pendente + ocorrência projetada da MESMA regra/competência/parte contam UMA vez", t4.mine.filter((i) => i.cycleMonth === "2026-10").length === 1 && near(t4.horizon, t3.horizon) && near(t4.free, t3.free));
  const bill = await prisma.bill.findFirst({ where: { recurringRuleId: aluguel.id, cycleMonth: "2026-10", part: 1 } });
  await prisma.bill.delete({ where: { id: bill.id } });

  // ============ leitura nunca escreve
  const c0 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.recurringRule.count(), prisma.telegramCorrectionAudit.count()]);
  await truth(); await buildHomeModel({ now: NOW }); await buildCommitmentsModel({ now: NOW }); await listUpcomingObligations({ now: NOW }); await getHouseBillObligations({ now: NOW, horizonEnd: NEXT });
  const c1 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.recurringRule.count(), prisma.telegramCorrectionAudit.count()]);
  check("[READ-ONLY] motor + Home + Compromissos + Próximas: contagens IDÊNTICAS", JSON.stringify(c0) === JSON.stringify(c1), JSON.stringify([c0, c1]));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
