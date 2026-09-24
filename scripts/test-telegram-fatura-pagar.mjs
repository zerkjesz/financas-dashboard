// Fase 7D.1 (item 13/14-C) — "Pagar fatura" de ponta a ponta pelo menu:
// Transfer kind card_bill_payment + CardBill.paidAmount/status, NUNCA Expense;
// pagamento maior que o restante é recusado com zero escrita. Roda dentro de
// uma transação revertida no fim (zero resíduo no DEV).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { lastSentTextFor } from "../lib/telegramApi.js";
import { dispatchUpdate } from "../lib/telegramUpdateHandler.js";
import { getCardCycleForDate, getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";

class Rollback extends Error {}
const CHAT = "TESTE_TG_FATURAPAGAR";
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const textOf = (outbox) => outbox.map((o) => o.args[o.type === "editMessageText" ? 2 : 1]).join("\n");

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const step = async (update) => {
        const outbox = [];
        await dispatchUpdate(update, CHAT, { client: tx, outbox });
        return outbox;
      };
      const click = (data) => step({ callback_query: { id: "fp", data, from: { id: 1 }, message: { message_id: 1, chat: { id: CHAT, type: "private" } } } });
      const say = (t) => step({ message: { text: t, chat: { id: CHAT, type: "private" }, from: { id: 1 } } });
      const snapshot = async () => ({
        expenses: await tx.expense.count(),
        transfers: await tx.transfer.count(),
        payments: await tx.transfer.count({ where: { kind: "card_bill_payment" } }),
      });

      const card = await tx.card.findFirst({ orderBy: { createdAt: "asc" } });
      const account = await tx.account.findFirst({ where: { type: "checking" }, orderBy: { createdAt: "asc" } });
      check("fixture: existe cartão e conta corrente no DEV", !!card && !!account);

      // Materializa a fatura corrente e fixa um total conhecido (revertido no fim).
      const cycleMonth = getCardCycleForDate(card, new Date());
      let bill = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth } } });
      if (!bill) bill = await tx.cardBill.create({ data: { cardId: card.id, cycleMonth, closesAt: getCardBillClosesAt(card, cycleMonth), dueAt: getCardBillDueDate(card, cycleMonth), totalAmount: 500, status: "open" } });
      check("fixture: fatura corrente materializada", !!bill);
      await tx.cardBill.update({ where: { id: bill.id }, data: { totalAmount: 500, paidAmount: 0, status: "open" } });

      // ---- Happy path: pagamento parcial de R$ 200 ----
      const before = await snapshot();
      await tx.botWizardSession.deleteMany({ where: { chatId: CHAT } });
      await click("w:fatura_pagar");
      const cards = await tx.card.count();
      let s = await tx.botWizardSession.findUnique({ where: { chatId: CHAT } });
      if (cards > 1) await click(`card:${card.id}`);
      s = await tx.botWizardSession.findUnique({ where: { chatId: CHAT } });
      check("menu abre o fluxo no passo do valor", s?.flow === "fatura_pagar" && s.step === "valor", JSON.stringify(s && { f: s.flow, s: s.step }));
      await say("200");
      await click(`acct:${account.id}`);
      await click("date:hoje");
      const preview = lastSentTextFor(CHAT) || "";
      check("mostra preview com valor e conta antes de gravar", /200/.test(preview) && /Pagamento de fatura/.test(preview) && preview.includes(account.name), preview);
      const mid = await snapshot();
      check("ZERO escrita antes de confirmar", mid.transfers === before.transfers && mid.expenses === before.expenses);
      const done = await click("confirm:yes");
      const after = await snapshot();
      check("cria exatamente 1 Transfer kind card_bill_payment", after.payments === before.payments + 1 && after.transfers === before.transfers + 1);
      check("NÃO cria Expense", after.expenses === before.expenses);
      const paid = await tx.cardBill.findUnique({ where: { id: bill.id } });
      check("CardBill.paidAmount = 200", Number(paid.paidAmount) === 200, String(paid.paidAmount));
      check("status = partially_paid (não 'paid')", paid.status === "partially_paid", paid.status);
      check("resposta final confirma o pagamento", /200/.test(textOf(done)), textOf(done));
      const t = await tx.transfer.findFirst({ where: { kind: "card_bill_payment" }, orderBy: { createdAt: "desc" } });
      check("Transfer debita a conta escolhida", t.fromAccountId === account.id, String(t.fromAccountId));

      // ---- Pagamento acima do restante: recusado, zero escrita, wizard encerrado ----
      const b2 = await snapshot();
      await tx.botWizardSession.deleteMany({ where: { chatId: CHAT } });
      await click("w:fatura_pagar");
      if (cards > 1) await click(`card:${card.id}`);
      await say("999");
      await click(`acct:${account.id}`);
      await click("date:hoje");
      const over = await click("confirm:yes");
      const a2 = await snapshot();
      check("pagamento > restante NÃO grava nada", a2.transfers === b2.transfers && a2.payments === b2.payments && a2.expenses === b2.expenses);
      check("responde com aviso claro (sem stack/SQL)", /Não consegui|Nada foi gravado/.test(textOf(over)) && !/prisma|constraint/i.test(textOf(over)), textOf(over));
      const stillPaid = await tx.cardBill.findUnique({ where: { id: bill.id } });
      check("fatura intacta depois da recusa", Number(stillPaid.paidAmount) === 200 && stillPaid.status === "partially_paid");
      check("sessão encerrada após a recusa", !(await tx.botWizardSession.findUnique({ where: { chatId: CHAT } })));

      // ---- Quitação: paga o restante (300) => paid ----
      await click("w:fatura_pagar");
      if (cards > 1) await click(`card:${card.id}`);
      await say("300");
      await click(`acct:${account.id}`);
      await click("date:hoje");
      await click("confirm:yes");
      const settled = await tx.cardBill.findUnique({ where: { id: bill.id } });
      check("pagar o restante quita a fatura (status paid, paidAmount 500)", settled.status === "paid" && Number(settled.paidAmount) === 500, `${settled.status} ${settled.paidAmount}`);
      const finalCounts = await snapshot();
      check("nenhuma Expense criada em todo o fluxo", finalCounts.expenses === before.expenses);

      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) { fail++; console.log(`❌ exceção: ${e.stack || e}`); }
  }
  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main();
