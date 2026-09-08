import { prisma } from "./prisma.js";
import { listBills, ensureUpcomingRecurringBills } from "./bills.js";
import { nextOccurrence } from "./recurringCycles.js";
import { money, subtractMoney, multiplyMoney, maxMoney, ZERO } from "./money.js";

// Painel "Próximas Obrigações": Bill (pendente/atrasada) + fatura de cartão + próximas receitas
// recorrentes (salário, VA), tudo num único array ordenado por data.
// Decimal-first (Fase 3.1): `amount` de cada item é Decimal — serializeMoney() só na
// borda da API (a rota que consome isso).
//
// Fase 5.3B, item 10 — `productSnapshot` opcional (o retorno de
// buildProductFinancialSnapshot, já calculado uma vez pelo dashboard route) é
// a fonte dos dois tipos de obrigação que faltavam aqui: os ConfirmedCommitment
// reais e as 9 parcelas externas da PRÓXIMA janela de renda — NUNCA as 38
// inteiras (as 29 seguintes são FUTURE_OBLIGATION, de propósito fora deste
// painel de "próximas"). Ambos já vêm CLASSIFICADOS pelo obligationClassifier
// (currentObligations.breakdown / externalInstallments.nextWindowItems) — esta
// função só formata pra exibição, nunca reclassifica nem soma de novo (sem
// double count: cada item aparece exatamente uma vez, na sua própria fonte).
export async function listUpcomingObligations({ withinDays = 45, cards: cardsIn, productSnapshot } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const [, bills, cards, incomeRules] = await Promise.all([
    ensureUpcomingRecurringBills(),
    listBills({ status: ["pending", "overdue"], withinDays }),
    cardsIn || prisma.card.findMany(),
    prisma.recurringRule.findMany({ where: { isActive: true, kind: "income" } }),
  ]);

  const cardBillsByCard = await Promise.all(
    cards.map((card) =>
      prisma.cardBill.findMany({ where: { cardId: card.id, dueAt: { gte: now, lte: horizon }, status: { in: ["open", "closed", "partially_paid", "paid"] } } })
    )
  );

  const items = [];
  for (const bill of bills) {
    items.push({
      name: bill.description,
      amount: multiplyMoney(bill.amount, -1),
      date: bill.dueDate,
      status: bill.status === "overdue" ? "atrasada" : "pendente",
      kind: "bill",
    });
  }

  cards.forEach((card, i) => {
    for (const bill of cardBillsByCard[i]) {
      const remaining = maxMoney(ZERO, subtractMoney(bill.totalAmount, money(bill.paidAmount)));
      const status = bill.status === "paid" ? "paga" : bill.status === "partially_paid" ? "parcial" : "pendente";
      items.push({
        name: `Fatura ${card.name}`,
        amount: bill.status === "paid" ? ZERO : multiplyMoney(remaining, -1),
        date: bill.dueAt,
        status,
        kind: "card_bill",
      });
    }
  });

  for (const rule of incomeRules) {
    if (rule.amount == null) continue;
    const date = nextOccurrence(rule.dayOfMonth, now);
    if (date > horizon) continue;
    items.push({ name: rule.name, amount: money(rule.amount), date, status: "prevista", kind: "income" });
  }

  if (productSnapshot) {
    // ConfirmedCommitment dentro do horizonte atual — `dueDate` já é o
    // limite (due-by) documentado em confirmedCommitment.js, nunca uma data
    // exata inventada. Filtra pelo mesmo `horizon` desta função (não pelo
    // horizonte interno, potencialmente diferente, do engine).
    for (const item of productSnapshot.currentObligations.breakdown) {
      if (item.type !== "ConfirmedCommitment") continue;
      if (item.dueDate == null || item.dueDate > horizon) continue;
      items.push({ name: item.description, amount: multiplyMoney(item.amount, -1), date: item.dueDate, status: "até a data", kind: "confirmed_commitment" });
    }

    // As 9 parcelas externas da PRÓXIMA janela de renda — nunca as 38
    // inteiras. Sem dueDate exata (dueTiming=AFTER_NEXT_INCOME) — posicionadas
    // na data da próxima renda só pra ordenação; o status deixa claro que não
    // é uma data de vencimento exata.
    const nextIncomeDate = productSnapshot.nextIncome.expectedDate;
    if (nextIncomeDate <= horizon) {
      for (const item of productSnapshot.externalInstallments.nextWindowItems) {
        items.push({
          name: `${item.planDescription} (${item.number})`,
          amount: multiplyMoney(item.amount, -1),
          date: nextIncomeDate,
          status: "no próximo salário",
          kind: "external_installment",
        });
      }
    }
  }

  items.sort((a, b) => a.date - b.date);
  return items;
}
