// Fase 8.0.1 — ConfirmedCommitment.dueDate NULLABLE ("Sem prazo definido").
// Cobre: schema/serviço (create/read/list/sort/edit/limpar prazo/funded/settle), classificação
// (FUNDED sem prazo = obrigação de horizonte atual, dinheiro NÃO é livre), freeMoney,
// próxima renda, projeção, snapshot/dashboard (read-model + helpers de UI), Data Hub,
// Telegram (menu + wizard criar/editar/pagar) e correção do Expense da liquidação.
// Nunca "Invalid Date" / 01/01/1970 / undefined / null. Fixtures sintéticas; deltas.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money, serializeMoney, compareMoney } from "../lib/money.js";
import { createCommitment, updateCommitmentDetails, listCommitments, getCommitment, fundCommitmentFromAccount, settleCommitmentCreatingExpense } from "../lib/commitments.js";
import { commitBotIntent } from "../lib/commitBotIntent.js";
import { classifyConfirmedCommitment, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoney, getObligationsBreakdown, getNextIncomeCommitment } from "../lib/freeMoney.js";
import { listAccountsWithBalances } from "../lib/accounts.js";
import { getNextIncomeInfo } from "../lib/incomeHorizon.js";
import { buildExpectedProjection } from "../lib/financialProjection.js";
import { buildProductFinancialSnapshot } from "../lib/productFinancialSnapshot.js";
import { formatDueDate, NO_DUE_DATE_LABEL } from "../lib/formatMoney.js";
import { obligationItemHasNoDueDate, obligationItemDate } from "../lib/homePresentation.js";
import { applyGuardedCorrection } from "../lib/telegramAi/correctionService.js";
import RAW_SHEETS from "../lib/dataHub/sheets.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { lastSentTextFor } from "../lib/telegramApi.js";

const MARK = "TESTE_COMM8";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const num = (x) => Number(serializeMoney(x));
const eq = (a, b) => compareMoney(money(a), money(b)) === 0;
const BAD = /Invalid Date|01\/01\/1970|1970|undefined|\bnull\b|NaN/;
const norm = (s) => String(s ?? "").replace(/\s/g, " ");

const created = { commitments: [], expenses: [], accounts: [] };
let uid = 770000000;
async function runText(text, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ message: { text, chat: { id: chatId, type: "private" }, from: { id: 1 } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 30000 });
}
async function runCallback(data, chatId) {
  return prisma.$transaction(async (tx) => {
    const claim = await claimTelegramUpdateInTx(tx, uid++, { senderId: "test", chatId });
    const outbox = [];
    await dispatchUpdate({ callback_query: { id: `c${uid}`, data, from: { id: 1 }, message: { message_id: 1, chat: { id: chatId, type: "private" } } } }, chatId, { client: tx, outbox });
    await completeTelegramUpdateInTx(tx, claim.receiptId);
    return outbox;
  }, { timeout: 30000 });
}
const outText = (outbox) => norm(outbox.map((o) => o.args[o.type === "editMessageText" ? 2 : 1]).join("\n"));

async function cleanup() {
  for (const id of created.expenses) await prisma.expense.delete({ where: { id } }).catch(() => {});
  for (const id of created.commitments) await prisma.confirmedCommitment.delete({ where: { id } }).catch(() => {});
  const stray = await prisma.confirmedCommitment.findMany({ where: { description: { contains: MARK } } });
  for (const c of stray) {
    if (c.expenseId) await prisma.expense.delete({ where: { id: c.expenseId } }).catch(() => {});
    await prisma.confirmedCommitment.delete({ where: { id: c.id } }).catch(() => {});
  }
  await prisma.expense.deleteMany({ where: { description: { contains: MARK } } }).catch(() => {});
  for (const id of created.accounts) await prisma.account.delete({ where: { id } }).catch(() => {});
  await prisma.telegramCorrectionAudit.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.botWizardSession.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  await prisma.telegramUpdateReceipt.deleteMany({ where: { chatId: { startsWith: MARK } } }).catch(() => {});
  const leftAudits = await prisma.telegramCorrectionAudit.count({ where: { chatId: { startsWith: MARK } } });
  check("cleanup: zero auditoria de teste restante", leftAudits === 0);
  const left = await Promise.all([prisma.confirmedCommitment.count({ where: { description: { contains: MARK } } }), prisma.expense.count({ where: { description: { contains: MARK } } }), prisma.account.count({ where: { slug: { contains: "teste-comm8" } } })]);
  check("cleanup: zero dado de teste restante", left.every((n) => n === 0), JSON.stringify(left));
}

async function main() {
  const now = new Date();
  const account = await prisma.account.create({ data: { slug: "teste-comm8-conta", name: `${MARK} conta`, type: "checking" } });
  created.accounts.push(account.id);

  // ================= [A] schema/serviço
  const undated = await createCommitment({ description: `${MARK} sem prazo`, amount: 1234.56 });
  created.commitments.push(undated.id);
  check("[A] create com dueDate omitido => dueDate NULL no banco", undated.dueDate === null && (await getCommitment(undated.id)).dueDate === null);
  const dated = await createCommitment({ description: `${MARK} com prazo`, amount: 10, dueDate: "2099-01-15" });
  created.commitments.push(dated.id);
  check("[A] create com data continua funcionando", dated.dueDate?.toISOString().slice(0, 10) === "2099-01-15");
  const explicitNull = await createCommitment({ description: `${MARK} null explícito`, amount: 5, dueDate: null });
  created.commitments.push(explicitNull.id);
  check("[A] create com dueDate=null explícito", explicitNull.dueDate === null);
  let threw = null;
  try { await createCommitment({ description: `${MARK} data lixo`, amount: 5, dueDate: "não-é-data" }); } catch (e) { threw = e; }
  check("[A] data informada mas INVÁLIDA continua sendo erro (nunca vira null em silêncio)", threw && /inválida/.test(threw.message));
  threw = null;
  try { await createCommitment({ description: "", amount: 5 }); } catch (e) { threw = e; }
  check("[A] description continua obrigatória", !!threw);
  const viaIntent = await commitBotIntent("create_confirmed_commitment", { description: `${MARK} via intent`, amount: 77.7 }, { source: "manual" });
  created.commitments.push(viaIntent.record.id);
  check("[A] commitBotIntent sem prazo: resposta diz 'sem prazo definido'", /sem prazo definido/.test(viaIntent.reply) && !BAD.test(viaIntent.reply), viaIntent.reply);

  // ================= [B] read / list / sort
  const list = (await listCommitments({})).filter((c) => c.description.includes(MARK));
  const idxDated = list.findIndex((c) => c.id === dated.id);
  const idxUndated = list.findIndex((c) => c.id === undated.id);
  check("[B] list: compromisso com prazo vem antes dos sem prazo", idxDated >= 0 && idxUndated > idxDated, `${idxDated}/${idxUndated}`);
  check("[B] list: todos os sem prazo ficam no fim", list.slice(idxDated + 1).every((c) => c.dueDate === null));

  // ================= [C] classificação pura
  const nd = { status: "CONFIRMED", dueDate: null };
  const nextIncomeDate = new Date(now.getTime() + 5 * 86400000);
  check("[C] CONFIRMED sem prazo => FUTURE_OBLIGATION (nunca inventa vencimento antes da renda)", classifyConfirmedCommitment(nd, { nextIncomeDate }) === OBLIGATION_CLASS.FUTURE_OBLIGATION);
  check("[C] FUNDED sem prazo => CURRENT_HORIZON_OBLIGATION (earmark: dinheiro NÃO é livre)", classifyConfirmedCommitment({ ...nd, status: "FUNDED" }, { nextIncomeDate }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);
  check("[C] SETTLED/CANCELLED sem prazo continuam fora de qualquer obrigação", classifyConfirmedCommitment({ ...nd, status: "SETTLED" }, { nextIncomeDate }) === OBLIGATION_CLASS.SETTLED && classifyConfirmedCommitment({ ...nd, status: "CANCELLED" }, { nextIncomeDate }) === OBLIGATION_CLASS.CANCELLED);
  check("[C] com prazo: regras A/B/C inalteradas", classifyConfirmedCommitment({ status: "CONFIRMED", dueDate: new Date(nextIncomeDate.getTime() - 1000) }, { nextIncomeDate }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION && classifyConfirmedCommitment({ status: "CONFIRMED", dueDate: new Date(nextIncomeDate.getTime() + 86400000) }, { nextIncomeDate }) === OBLIGATION_CLASS.FUTURE_OBLIGATION && classifyConfirmedCommitment({ status: "FUNDED", dueDate: new Date(nextIncomeDate.getTime() + 86400000) }, { nextIncomeDate }) === OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION);

  // ================= [D] freeMoney / próxima renda / projeção / snapshot
  // Isola o efeito: só o compromisso de 1234,56 "sem prazo" (os outros dois de teste ficam CANCELLED).
  await prisma.confirmedCommitment.updateMany({ where: { id: { in: [dated.id, explicitNull.id, viaIntent.record.id] } }, data: { status: "CANCELLED" } });
  const nextIncome = await getNextIncomeInfo({ now });
  const accounts = await listAccountsWithBalances();
  const fmUnfunded = await computeFreeMoney({ now, accounts, nextIncomeDate: nextIncome.expectedDate });
  const bdUnfunded = await getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate });
  const inFuture = bdUnfunded.FUTURE_OBLIGATION.items.some((i) => i.id === undated.id && eq(i.amount, 1234.56));
  const inCurrent = bdUnfunded.CURRENT_HORIZON_OBLIGATION.items.some((i) => i.id === undated.id);
  check("[D] CONFIRMED sem prazo aparece em futureObligations e NÃO em currentHorizon", inFuture && !inCurrent);
  const incomeCommit = await getNextIncomeCommitment({ nextIncome });
  check("[D] getNextIncomeCommitment não quebra com compromisso sem prazo", incomeCommit.committedAmount != null);
  await fundCommitmentFromAccount(undated.id, account.id);
  const fmFunded = await computeFreeMoney({ now, accounts, nextIncomeDate: nextIncome.expectedDate });
  const bdFunded = await getObligationsBreakdown({ now, nextIncomeDate: nextIncome.expectedDate });
  check("[D] FUNDED sem prazo entra em currentHorizon com o valor exato (1234,56)", bdFunded.CURRENT_HORIZON_OBLIGATION.items.some((i) => i.id === undated.id && eq(i.amount, 1234.56) && i.status === "FUNDED"));
  check("[D] FUNDED reduz freeMoney em exatamente 1234,56 (o dinheiro separado NÃO é livre)", Math.abs(num(fmFunded.freeMoney) - num(fmUnfunded.freeMoney) + 1234.56) < 0.005, String(num(fmFunded.freeMoney) - num(fmUnfunded.freeMoney)));
  const { handleReadIntent } = await import("../lib/telegramReads.js");
  const fmText = norm(await handleReadIntent("read_free_money", { now }));
  const cnpjLine = fmText.split("- ").find((l) => l.includes(`${MARK} sem prazo`)) || "";
  check("[D] Telegram: linha do compromisso FUNDED sem prazo diz 'dinheiro separado, sem prazo definido' (não 'até a próxima renda')", /dinheiro separado, sem prazo definido/.test(cnpjLine) && !/até a próxima renda/.test(cnpjLine), cnpjLine);
  check("[D] FUNDED nunca vira Expense/Transfer sozinho", (await prisma.expense.count({ where: { description: { contains: MARK } } })) === 0);
  const proj = await buildExpectedProjection({ now, horizonDays: 90 });
  const projJson = JSON.stringify(proj, (k, v) => (v && v.constructor?.name === "Decimal" ? v.toString() : v));
  check("[D] projeção (90d) roda sem quebrar e não emite data inválida", projJson.length > 10 && !/Invalid Date|1970-01-01/.test(projJson));
  const snap = await buildProductFinancialSnapshot({ now });
  const snapItem = [...(snap.currentObligations?.breakdown ?? [])].find((i) => i.id === undated.id);
  check("[D] snapshot/dashboard: item sem prazo presente no breakdown com dueDate null", !!snapItem && snapItem.dueDate == null);
  check("[D] helper de UI: obligationItemHasNoDueDate = true e obligationItemDate = null", snapItem && obligationItemHasNoDueDate(snapItem) && obligationItemDate(snapItem) === null);
  check("[D] snapshot serializa sem valores inválidos", !/Invalid Date|1970-01-01/.test(JSON.stringify(snap, (k, v) => (v && v.constructor?.name === "Decimal" ? v.toString() : v))));

  // ================= [E] formatação
  check("[E] formatDueDate(null/undefined/''/lixo) = 'Sem prazo definido'", [null, undefined, "", "lixo"].every((v) => formatDueDate(v) === NO_DUE_DATE_LABEL) && NO_DUE_DATE_LABEL === "Sem prazo definido");
  check("[E] formatDueDate(data) = data pt-BR", formatDueDate(new Date("2026-11-05T00:00:00Z")) === "05/11/2026");

  // ================= [F] Data Hub
  const sheet = RAW_SHEETS.find((s) => s.key === "confirmedCommitments");
  const exportedAll = await sheet.fetch({});
  const exportedPeriod = await sheet.fetch({ period: { gte: new Date("2099-01-01"), lt: new Date("2099-12-31") } });
  check("[F] Data Hub export (sem período) inclui o sem prazo com dueDate null", exportedAll.some((r) => r.id === undated.id && r.dueDate === null));
  check("[F] Data Hub export (com período) inclui os sem prazo (não têm data pra ficar de fora)", exportedPeriod.some((r) => r.id === undated.id));

  // ================= [G] edição: definir prazo, limpar prazo, editar valor sem tocar no prazo
  const withDate = await updateCommitmentDetails(undated.id, { dueDate: "2099-06-01" });
  check("[G] editar: definir prazo", withDate.dueDate?.toISOString().slice(0, 10) === "2099-06-01");
  const amountOnly = await updateCommitmentDetails(undated.id, { amount: 2000 });
  check("[G] editar só o valor NÃO mexe no prazo (undefined = sem mudança)", amountOnly.dueDate?.toISOString().slice(0, 10) === "2099-06-01" && eq(amountOnly.amount, 2000));
  const cleared = await updateCommitmentDetails(undated.id, { dueDate: null });
  check("[G] editar: dueDate=null LIMPA o prazo", cleared.dueDate === null);
  threw = null;
  try { await updateCommitmentDetails(undated.id, { dueDate: "lixo" }); } catch (e) { threw = e; }
  check("[G] editar com data inválida = erro", threw && /inválida/.test(threw.message));
  await updateCommitmentDetails(undated.id, { amount: 1234.56 });
  check("[G] funding é preservado pela edição (continua FUNDED)", (await getCommitment(undated.id)).status === "FUNDED");

  // ================= [H] Telegram — leitura
  const chatR = `${MARK}_read`;
  const readOut = outText(await runCallback("r:compromissos_ativos", chatR));
  check("[H] Telegram 'ver compromissos' mostra 'sem prazo definido' e nada inválido", /sem prazo definido/.test(readOut) && !BAD.test(readOut.replace(/2099|TESTE_COMM8/g, "")), readOut.slice(0, 400));

  // ================= [I] Telegram — wizard CRIAR sem prazo
  const chatC = `${MARK}_create`;
  await runCallback("w:compromisso", chatC);
  await runText(`${MARK} criado pelo wizard`, chatC);
  await runText("R$ 1.335,00", chatC);
  const askText = norm(lastSentTextFor(chatC));
  check("[I] wizard pergunta o prazo e oferece 'Sem prazo definido'", /Vence quando/.test(askText) && /nunca inventa uma data/.test(askText), askText);
  await runCallback("skip:duedate", chatC);
  const preview = norm(lastSentTextFor(chatC));
  check("[I] preview mostra 'Prazo: Sem prazo definido' (sem data inventada)", /Prazo: Sem prazo definido/.test(preview) && !BAD.test(preview.replace(/TESTE_COMM8/g, "")), preview);
  const confirmOut = outText(await runCallback("confirm:yes", chatC));
  const wizCommit = await prisma.confirmedCommitment.findFirst({ where: { description: `${MARK} criado pelo wizard` } });
  if (wizCommit) created.commitments.push(wizCommit.id);
  check("[I] confirmar cria o compromisso com dueDate NULL, CONFIRMED, R$ 1.335,00", wizCommit && wizCommit.dueDate === null && wizCommit.status === "CONFIRMED" && eq(wizCommit.amount, 1335), JSON.stringify(wizCommit));
  check("[I] resposta final diz 'sem prazo definido'", /sem prazo definido/.test(confirmOut) && !BAD.test(confirmOut), confirmOut);
  check("[I] nenhum Expense/Transfer criado por cadastrar compromisso", (await prisma.expense.count({ where: { description: { contains: `${MARK} criado` } } })) === 0);

  // ================= [J] Telegram — wizard EDITAR (data → sem prazo; valor não mexe no prazo)
  const chatE = `${MARK}_edit`;
  await runCallback("w:compromisso_editar", chatE);
  await runCallback(`cedit:${wizCommit.id}`, chatE);
  await runCallback("cfield:dueDate", chatE);
  await runText("12/12", chatE);
  const prevSet = norm(lastSentTextFor(chatE));
  check("[J] editar → nova data: preview 'Sem prazo definido -> data'", /Vencimento: Sem prazo definido -> 12\/12\/20\d\d/.test(prevSet), prevSet);
  await runCallback("confirm:yes", chatE);
  check("[J] editar: prazo definido no banco", (await getCommitment(wizCommit.id)).dueDate?.toISOString().slice(5, 10) === "12-12");
  await runCallback("w:compromisso_editar", chatE);
  await runCallback(`cedit:${wizCommit.id}`, chatE);
  await runCallback("cfield:dueDate", chatE);
  await runCallback("skip:duedate", chatE);
  const prevClear = norm(lastSentTextFor(chatE));
  check("[J] editar → 'Sem prazo definido': preview 'data -> Sem prazo definido'", /Vencimento: 12\/12\/20\d\d -> Sem prazo definido/.test(prevClear), prevClear);
  await runCallback("confirm:yes", chatE);
  check("[J] editar: prazo LIMPO no banco (null)", (await getCommitment(wizCommit.id)).dueDate === null);
  await runCallback("w:compromisso_editar", chatE);
  await runCallback(`cedit:${wizCommit.id}`, chatE);
  await runCallback("cfield:amount", chatE);
  await runText("1.400,00", chatE);
  await runCallback("confirm:yes", chatE);
  const afterAmount = await getCommitment(wizCommit.id);
  check("[J] editar só o valor: prazo continua null e valor = 1.400,00", afterAmount.dueDate === null && eq(afterAmount.amount, 1400));

  // ================= [K] Telegram — pagar (liquidar) compromisso sem prazo
  const chatP = `${MARK}_pay`;
  await runCallback("w:compromisso_pagar", chatP);
  await runCallback(`cpay:${wizCommit.id}`, chatP);
  await runCallback(`acct:${account.id}`, chatP);
  const payPrev = norm(lastSentTextFor(chatP));
  check("[K] pagar: preview sem dado inválido", !BAD.test(payPrev.replace(/TESTE_COMM8/g, "")), payPrev);
  await runCallback("confirm:yes", chatP);
  const settled = await getCommitment(wizCommit.id);
  if (settled?.expenseId) created.expenses.push(settled.expenseId);
  check("[K] liquidar: SETTLED, Expense vinculado do valor do compromisso, na conta escolhida", settled.status === "SETTLED" && !!settled.expenseId, JSON.stringify(settled));
  const settleExp = await prisma.expense.findUnique({ where: { id: settled.expenseId } });
  check("[K] Expense da liquidação: 1.400,00 na conta de teste", settleExp && eq(settleExp.amount, 1400) && settleExp.accountId === account.id);

  // ================= [L] correção do Expense da liquidação (onde aplicável)
  const corrected = await applyGuardedCorrection({ model: "expense", id: settleExp.id, fieldChanges: { amount: 1399 }, expectedUpdatedAt: settleExp.updatedAt.toISOString(), chatId: `${MARK}_corr` }, {});
  check("[L] correção do Expense da liquidação funciona e o compromisso continua SETTLED", corrected && (await getCommitment(wizCommit.id)).status === "SETTLED" && eq((await prisma.expense.findUnique({ where: { id: settleExp.id } })).amount, 1399));
  await prisma.confirmedCommitment.updateMany({ where: { id: { in: [dated.id, explicitNull.id, viaIntent.record.id] } }, data: { status: "CONFIRMED" } }); // não deixa resto
  // liquidação direta por serviço também funciona sem prazo
  const direct = await createCommitment({ description: `${MARK} direto`, amount: 9.99 });
  created.commitments.push(direct.id);
  const res = await settleCommitmentCreatingExpense(direct.id, { accountId: account.id, description: `${MARK} direto`, occurredAt: now });
  created.expenses.push(res.expense.id);
  check("[L] settleCommitmentCreatingExpense funciona com dueDate null", res.commitment.status === "SETTLED" && res.commitment.dueDate === null);
}

main()
  .catch((e) => { fail++; console.log(`❌ exceção: ${e.stack || e}`); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  });
