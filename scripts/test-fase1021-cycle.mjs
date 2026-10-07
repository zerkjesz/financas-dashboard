// Fase 10.2 (escopo reduzido) — conta de OUTUBRO paga em SETEMBRO não pode reaparecer pendente.
// Ciclo financeiro 24→23; competência continua sendo o mês da conta; identidade = regra + competência + parte.
// Fixtures MARK; relógios controlados; asserções por subconjunto MARK (independem do estado ambiente do DEV).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney } from "../lib/money.js";
import { resolveCurrentCycle } from "../lib/financialCycle.js";
import { buildFinancialEngineSummary } from "../lib/financialEngine.js";
import { buildCommitmentsModel } from "../lib/compromissosModel.js";
import { buildHomeModel } from "../lib/homeModel.js";
import { payHouseBill, listHouseBillInstances, getHouseBillObligations, moveHouseBillCompetence } from "../lib/houseBills.js";
import { DomainError } from "../lib/domainErrors.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { realizeSeptemberSalary } from "./lib/horizonFixture.js";

const MARK = "TESTE_F1021";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const n = (x) => Number(serializeMoney(money(x)));
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function code(fn) { try { await fn(); return null; } catch (e) { return e instanceof DomainError ? e.code : `RAW:${String(e.message).split("\n").pop().slice(0, 80)}`; } }
const T = (s) => new Date(`${s}T15:00:00.000Z`); // 12:00 no Brasil
const N27 = T("2026-09-27"), N30 = T("2026-09-30"), N01 = T("2026-10-01"), N23 = T("2026-10-23"), N24 = T("2026-10-24"), N28O = T("2026-10-28"), NOV01 = T("2026-11-01");
const created = { accounts: [], rules: [] };
const START = new Date();
const mine = (items) => items.filter((i) => i.name.startsWith(MARK));

async function mkRule(data) {
  const r = await prisma.recurringRule.create({ data: { kind: "expense", isActive: true, category: "Moradia", ...data, name: `${MARK} ${data.name}` } });
  created.rules.push(r.id);
  return r;
}
const billCount = (ruleId) => prisma.bill.count({ where: { recurringRuleId: ruleId } });
async function engine(now) {
  const e = await buildFinancialEngineSummary({ now });
  return { free: n(e.freeMoney), cash: n(e.balances.unrestrictedCash), horizon: n(e.obligations.currentHorizon), mine: e.obligations.currentHorizonItems.filter((i) => i.houseBill && i.description.startsWith(MARK)).map((i) => `${i.description}:${n(i.amount)}:${i.cycleMonth}`).sort() };
}
async function cleanup() {
  const bills = await prisma.bill.findMany({ where: { recurringRuleId: { in: created.rules } }, select: { id: true } });
  await prisma.telegramCorrectionAudit.deleteMany({ where: { recordId: { in: bills.map((b) => b.id) } } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { model: "bill", createdAt: { gte: START }, rawMessage: { in: ["web", "fase-10.2"] } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { OR: [{ description: { contains: MARK } }, { accountId: { in: created.accounts } }] } }).catch(() => {});
  await prisma.bill.deleteMany({ where: { recurringRuleId: { in: created.rules } } }).catch(() => {});
  await prisma.recurringRule.deleteMany({ where: { id: { in: created.rules } } }).catch(() => {});
  await prisma.income.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  await prisma.balanceAdjustment.deleteMany({ where: { accountId: { in: created.accounts } } }).catch(() => {});
  await prisma.account.deleteMany({ where: { id: { in: created.accounts } } }).catch(() => {});
  const left = await Promise.all([prisma.account.count({ where: { slug: { contains: "teste-f1021" } } }), prisma.recurringRule.count({ where: { name: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } }), prisma.income.count({ where: { description: { contains: MARK } } })]);
  check("cleanup: zero dado de teste restante", left.every((c) => c === 0), JSON.stringify(left));
}

async function main() {
  // ================= ciclo 24→23 (puro) =================
  const S = { cycleStartDay: 24 };
  const cy = (d) => resolveCurrentCycle({ now: new Date(d), settings: S });
  check("[E] ciclo atual em 26/09: 24/09→23/10, competência principal 2026-10", cy("2026-09-26T15:00:00Z").label === "24 set → 23 out" && cy("2026-09-26T15:00:00Z").competence === "2026-10" && cy("2026-09-26T15:00:00Z").key === "2026-09-24");
  check("[F] 30/09 e 01/10 estão no MESMO ciclo (a virada do mês civil não muda nada)", cy("2026-09-30T15:00:00Z").key === cy("2026-10-01T15:00:00Z").key && cy("2026-10-01T15:00:00Z").competence === "2026-10");
  check("[G] 23/10 ainda é o mesmo ciclo", cy("2026-10-23T15:00:00Z").key === "2026-09-24");
  check("[H] 24/10 inicia o ciclo novo 24/10→23/11 (competência 2026-11)", cy("2026-10-24T15:00:00Z").label === "24 out → 23 nov" && cy("2026-10-24T15:00:00Z").competence === "2026-11");
  check("[FUSO] 24/10 02:30Z = 23/10 23:30 no Brasil: ainda ciclo antigo (dia LOCAL)", cy("2026-10-24T02:30:00Z").key === "2026-09-24" && cy("2026-10-24T03:30:00Z").key === "2026-10-24");
  check("[VIRADA DE ANO] 25/12 → ciclo 24/12→23/01, competência 2027-01", cy("2026-12-25T15:00:00Z").competence === "2027-01" && cy("2026-12-25T15:00:00Z").label === "24 dez → 23 jan");

  // ================= com banco =================
  const acc = await prisma.account.create({ data: { slug: "teste-f1021-itau", name: `${MARK} itau`, type: "checking" } });
  created.accounts.push(acc.id);
  await prisma.balanceAdjustment.create({ data: { accountId: acc.id, newBalance: 8000, note: MARK, source: "manual", occurredAt: new Date("2026-01-01T00:00:00Z") } });
  const fx = await realizeSeptemberSalary(prisma, { mark: MARK, accountId: acc.id, now: N27 }); // salário de 24/09 realizado => próxima renda 24/10
  check("[0] cenário: salário recebido em 24/09, próxima renda 24/10", fx.applied && fx.next.expectedDate.toISOString().slice(0, 10) === "2026-10-24", JSON.stringify(fx.next?.expectedDate));

  const aluguel = await mkRule({ name: "Aluguel", amount: 1000, dayOfMonth: 5, amountKind: "FIXED" });
  const internet = await mkRule({ name: "Internet", amount: 100, amountKind: "FIXED" });
  const faxina = await mkRule({ name: "Faxina", amount: 260, partsPerCycle: 2, cadence: "BIWEEKLY", amountKind: "FIXED" });

  const m27 = await buildCommitmentsModel({ now: N27 });
  check("[LISTA] em 27/09 a lista principal já é a do CICLO: competência 2026-10, cabeçalho '24 set → 23 out'", m27.monthKey === "2026-10" && m27.cycle.label === "24 set → 23 out" && mine(m27.items).length === 3 && mine(m27.items).every((i) => i.state === "pending" && i.casa.cycleMonth === "2026-10"));
  check("[LISTA] aluguel de outubro vence 05/10 (data real, competência preservada)", mine(m27.items).find((i) => /Aluguel/.test(i.name)).casa.dueDate.startsWith("2026-10-05"));

  // pagamento ANTECIPADO (27/09) da conta de OUTUBRO
  const payRent = await payHouseBill({ ruleId: aluguel.id, cycleMonth: m27.monthKey, accountId: acc.id, when: "hoje", now: N27 });
  const payFax1 = await payHouseBill({ ruleId: faxina.id, cycleMonth: m27.monthKey, part: 1, accountId: acc.id, when: "hoje", now: N27 });
  check("[A] Bill de outubro paga em 27/09: competência 2026-10, vencimento 05/10, status paid, paidAt em setembro", payRent.bill.cycleMonth === "2026-10" && payRent.bill.dueDate.toISOString().slice(0, 10) === "2026-10-05" && payRent.bill.status === "paid" && payRent.bill.paidAt.toISOString().slice(0, 7) === "2026-09" && !!payRent.expense);
  check("[K] faxina visita 1 paga em setembro preserva competência 2026-10 e parte 1", payFax1.bill.cycleMonth === "2026-10" && payFax1.bill.part === 1);

  const e30 = await engine(N30);
  const m30 = await buildCommitmentsModel({ now: N30 });
  const bills30 = await Promise.all(created.rules.map(billCount));
  // ====== virada do dia 01 ======
  const e01 = await engine(N01);
  const m01 = await buildCommitmentsModel({ now: N01 });
  const bills01 = await Promise.all(created.rules.map(billCount));
  const rent01 = mine(m01.items).find((i) => /Aluguel/.test(i.name));
  check("[A] em 01/10 a conta de outubro continua PAID (não reabre)", rent01.state === "done" && rent01.undo && (await listHouseBillInstances({ cycleMonth: "2026-10", now: N01 })).find((i) => i.ruleId === aluguel.id).status === "PAID");
  check("[B] 01/10 não gera nova Bill (contagens por regra idênticas; leitura não escreve)", JSON.stringify(bills30) === JSON.stringify(bills01) && bills01.join() === "1,0,1");
  const sum = (m) => ({ done: mine(m.items).filter((i) => i.state === "done").length, pend: mine(m.items).filter((i) => i.state === "pending").length });
  check("[F] progresso do ciclo idêntico em 30/09 e 01/10 (nada zera): aluguel resolvido, internet e faxina pendentes", JSON.stringify(sum(m30)) === JSON.stringify(sum(m01)) && sum(m01).done === 1 && sum(m01).pend === 2, JSON.stringify([sum(m30), sum(m01)]));
  check("[C] committed não inclui a conta paga em nenhum dos dois dias; só as pendentes (Internet 100, Faxina visita 2 = 130)", JSON.stringify(e30.mine) === JSON.stringify(e01.mine) && e01.mine.length === 2 && e01.mine.some((s) => /Internet:100/.test(s)) && e01.mine.some((s) => /visita 2\/2:130/.test(s)) && !e01.mine.some((s) => /Aluguel/.test(s)), JSON.stringify(e01.mine));
  check("[D] freeMoney igual em 30/09 e 01/10 (a Expense já baixou o caixa; sem dupla contagem na virada)", near(e30.free, e01.free) && near(e30.cash, e01.cash) && near(e30.horizon, e01.horizon), `${e30.free} vs ${e01.free}`);
  const h01 = await buildHomeModel({ now: N01 });
  check("[HOME] a Home mostra o ciclo (24 set → 23 out) e não zera os resolvidos na virada", h01.compromissos.cycleLabel === "24 set → 23 out" && h01.compromissos.resolved === m01.summary.resolved);

  // comparação com a contagem de obrigações: sem o pagamento, o aluguel entraria (prova de que o teste discrimina)
  const obl = await getHouseBillObligations({ now: N01, horizonEnd: new Date("2026-10-24T00:00:00Z") });
  check("[C] getHouseBillObligations (motor): aluguel de outubro PAID não é obrigação; Internet entra", !obl.items.some((i) => i.ruleId === aluguel.id) && obl.items.some((i) => i.ruleId === internet.id));

  // identidade
  check("[IDENTIDADE] pagar de novo a mesma regra+competência+parte → ALREADY_PAID e continua 1 Bill", (await code(() => payHouseBill({ ruleId: aluguel.id, cycleMonth: "2026-10", accountId: acc.id, now: N01 }))) === "ALREADY_PAID" && (await billCount(aluguel.id)) === 1);
  check("[IDENTIDADE] a visita 2 da faxina é outra ocorrência (parte 2) e continua pendente", (await listHouseBillInstances({ cycleMonth: "2026-10", now: N01 })).filter((i) => i.ruleId === faxina.id).map((i) => `${i.part}:${i.status}`).join() === "1:PAID,2:PENDING");

  // 23/10 e 24/10
  const m23 = await buildCommitmentsModel({ now: N23 });
  check("[G] 23/10 continua no mesmo ciclo, aluguel de outubro ainda concluído", m23.cycle.label === "24 set → 23 out" && mine(m23.items).find((i) => /Aluguel/.test(i.name)).state === "done");
  const m24 = await buildCommitmentsModel({ now: N24 });
  const rent24 = mine(m24.items).find((i) => /Aluguel/.test(i.name));
  check("[H][I] 24/10 inicia o ciclo 24/10→23/11: competência 2026-11, aluguel de novembro vence 05/11, pendente", m24.cycle.label === "24 out → 23 nov" && m24.monthKey === "2026-11" && rent24.state === "pending" && rent24.casa.cycleMonth === "2026-11" && rent24.casa.dueDate.startsWith("2026-11-05"));

  // [J] pagamento antecipado de NOVEMBRO em 28/10 continua PAID em 01/11
  await payHouseBill({ ruleId: aluguel.id, cycleMonth: m24.monthKey, accountId: acc.id, when: "hoje", now: N28O });
  const mNov = await buildCommitmentsModel({ now: NOV01 });
  const rentNov = mine(mNov.items).find((i) => /Aluguel/.test(i.name));
  check("[J] aluguel de novembro pago em 28/10 continua PAID em 01/11 (mesmo ciclo, competência 2026-11)", mNov.cycle.label === "24 out → 23 nov" && rentNov.state === "done" && rentNov.casa.cycleMonth === "2026-11" && (await billCount(aluguel.id)) === 2);

  // correção de competência (reconciliação de contas pagas em setembro como "setembro")
  const wrong = await mkRule({ name: "Água", amount: 59.27, dayOfMonth: 10, amountKind: "FIXED" });
  const wrongPay = await payHouseBill({ ruleId: wrong.id, cycleMonth: "2026-09", accountId: acc.id, when: "hoje", now: N27 });
  const expBefore = await prisma.expense.findUnique({ where: { billId: wrongPay.bill.id } });
  const moved = await moveHouseBillCompetence(wrongPay.bill.id, { toMonth: "2026-10", expectedUpdatedAt: wrongPay.bill.updatedAt.toISOString() });
  const expAfter = await prisma.expense.findUnique({ where: { billId: wrongPay.bill.id } });
  check("[MOVE] conta paga como setembro vira competência outubro (vencimento recalculado 10/10), continua PAID, Expense intacta (saldo não muda)", moved.cycleMonth === "2026-10" && moved.status === "paid" && moved.dueDate.toISOString().slice(0, 10) === "2026-10-10" && expBefore.id === expAfter.id && near(expBefore.amount, expAfter.amount) && +expBefore.occurredAt === +expAfter.occurredAt);
  check("[MOVE] auditada (move_house_bill_competence) e idempotente: mover de novo → INVALID; destino ocupado → ALREADY_PAID", (await prisma.telegramCorrectionAudit.count({ where: { recordId: wrongPay.bill.id, action: "move_house_bill_competence" } })) === 1 && (await code(() => moveHouseBillCompetence(wrongPay.bill.id, { toMonth: "2026-10" }))) === "INVALID");
  const sep = await payHouseBill({ ruleId: wrong.id, cycleMonth: "2026-09", accountId: acc.id, when: "hoje", now: N27 });
  check("[MOVE] mover para competência que já tem a mesma parte → ALREADY_PAID e nada muda", (await code(() => moveHouseBillCompetence(sep.bill.id, { toMonth: "2026-10" }))) === "ALREADY_PAID" && (await prisma.bill.findUnique({ where: { id: sep.bill.id } })).cycleMonth === "2026-09");
  check("[MOVE] STALE com updatedAt velho e rejeição de mês inválido", (await code(() => moveHouseBillCompetence(sep.bill.id, { toMonth: "2026-12", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))) === "STALE" && (await code(() => moveHouseBillCompetence(sep.bill.id, { toMonth: "2026-13" }))) === "INVALID");

  // ============ cenário de PROD: 6 contas pagas em 26/09 como "setembro" -> reconciliar para outubro ============
  const R = {};
  R.alu = await mkRule({ name: "R-Aluguel", amount: 1000, dayOfMonth: 5, amountKind: "FIXED" });
  R.net = await mkRule({ name: "R-Internet", amount: 114.9, amountKind: "FIXED" });
  R.tel = await mkRule({ name: "R-Telefone", amount: 60, amountKind: "APPROXIMATE" });
  R.fax = await mkRule({ name: "R-Faxina", amount: 260, partsPerCycle: 2, cadence: "BIWEEKLY", amountKind: "FIXED" });
  R.agu = await mkRule({ name: "R-Água", amount: 59.27, amountKind: "FIXED" });
  R.ene = await mkRule({ name: "R-Energia", amountKind: "VARIABLE", referenceMin: 400, referenceMax: 450 });
  const wrongBills = [];
  for (const [r, part] of [[R.alu, 1], [R.net, 1], [R.tel, 1], [R.fax, 1], [R.fax, 2], [R.agu, 1]]) wrongBills.push((await payHouseBill({ ruleId: r.id, cycleMonth: "2026-09", part, accountId: acc.id, when: "hoje", now: N27 })).bill);
  const rec = async (now) => {
    const m = await buildCommitmentsModel({ now });
    const items = m.items.filter((i) => i.kind === "casa" && i.name.startsWith(`${MARK} R-`));
    return { done: items.filter((i) => i.state === "done").map((i) => i.name.replace(`${MARK} R-`, "")).sort(), pend: items.filter((i) => i.state === "pending").map((i) => i.name.replace(`${MARK} R-`, "")).sort(), e: await engine(now), bal: n(await computeAccountBalance(acc.id)) };
  };
  const pre = await rec(N01);
  check("[RECONCILIAÇÃO] antes: pagas como setembro, as 6 contas de outubro aparecem PENDENTES no ciclo e reduzem o livre de novo (o bug)", pre.pend.length === 6 && pre.done.length === 0 && pre.e.mine.filter((x) => /R-/.test(x)).length >= 5, JSON.stringify([pre.pend, pre.e.mine]));
  for (const b of wrongBills) await moveHouseBillCompetence(b.id, { toMonth: "2026-10", expectedUpdatedAt: (await prisma.bill.findUnique({ where: { id: b.id } })).updatedAt.toISOString() });
  const post = await rec(N01);
  const post30 = await rec(N30);
  check("[RECONCILIAÇÃO] depois: Aluguel, Internet, Telefone, Faxina (2/2), Água concluídos; só a Energia pendente", post.done.join() === "Aluguel,Faxina,Internet,Telefone,Água" && post.pend.join() === "Energia", JSON.stringify([post.done, post.pend]));
  check("[RECONCILIAÇÃO] nenhum segundo aluguel de outubro pendente; zero obrigação das contas pagas no committed", !post.e.mine.some((x) => /R-Aluguel|R-Internet|R-Telefone|R-Faxina|R-Água/.test(x)) && (await billCount(R.alu.id)) === 1);
  check("[RECONCILIAÇÃO] saldo bancário inalterado pela mudança de competência (Expenses intactas)", near(pre.bal, post.bal) && near(pre.e.cash, post.e.cash), `${pre.bal} vs ${post.bal}`);
  check("[RECONCILIAÇÃO] committed cai exatamente o valor das contas movidas (1.000+114,90+60+260+59,27); livre sobe o mesmo", near(pre.e.horizon - post.e.horizon, 1494.17) && near(post.e.free - pre.e.free, 1494.17), `${pre.e.horizon - post.e.horizon}`);
  check("[RECONCILIAÇÃO] mesmo resultado em 30/09 e 01/10 (virada sem efeito)", JSON.stringify([post.done, post.pend]) === JSON.stringify([post30.done, post30.pend]) && near(post.e.free, post30.e.free));

  // leitura nunca escreve
  const c0 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.telegramCorrectionAudit.count()]);
  await buildCommitmentsModel({ now: N01 }); await buildHomeModel({ now: N01 }); await engine(N01);
  const c1 = await Promise.all([prisma.bill.count(), prisma.expense.count(), prisma.telegramCorrectionAudit.count()]);
  check("[READ-ONLY] Compromissos + Home + motor na virada: contagens idênticas", JSON.stringify(c0) === JSON.stringify(c1));
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
