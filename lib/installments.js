import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";
import { money, subtractMoney, multiplyMoney, roundMoney } from "./money.js";
import { getCardCycleForDate } from "./cardCycle.js";

// Gera as parcelas de `startingInstallmentNumber` até `installmentCount`, cada uma no
// billMonth correspondente (firstInstallmentMonth = mês da parcela 1, mesmo que ela já
// tenha ficado no passado e não seja gerada por estarmos importando uma compra em andamento).
// A última parcela absorve a sobra de arredondamento.
//
// Decimal-first (Fase 3.1): totalAmount/installmentValue já vêm como Decimal (Purchase
// recém-criada). O ajuste da última parcela (total - installmentValue*(count-1)) roda
// inteiro em Decimal, arredondado só uma vez no fim via roundMoney — evita o erro
// acumulado que Number teria em compras com muitas parcelas.
export async function generateInstallmentSchedule(purchase) {
  const { id: purchaseId, totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber } = purchase;
  const total = money(totalAmount);
  const value = money(installmentValue);

  const rows = [];
  for (let number = startingInstallmentNumber; number <= installmentCount; number++) {
    const isLast = number === installmentCount;
    const amount = isLast ? roundMoney(subtractMoney(total, multiplyMoney(value, installmentCount - 1))) : value;
    rows.push({
      purchaseId,
      number,
      amount,
      billMonth: addMonthKey(firstInstallmentMonth, number - 1),
    });
  }

  await prisma.installment.createMany({ data: rows });
  return rows;
}

export async function listPurchasesWithProgress() {
  const purchases = await prisma.purchase.findMany({
    include: { installments: { orderBy: { number: "asc" } }, card: true },
    orderBy: { purchasedAt: "desc" },
  });

  return purchases.map((purchase) => {
    // Fase 4.0: ciclo real DO CARTÃO desta compra (closingDay-aware) — antes era
    // um "mês calendário de hoje" único aplicado a todas as compras, ignorando
    // que cartões diferentes podem ter ciclos diferentes. Idêntico ao valor antigo
    // enquanto closingDay continuar null.
    const currentMonth = getCardCycleForDate(purchase.card, new Date());
    const paidCount = purchase.installments.filter((i) => i.billMonth < currentMonth).length;
    const remaining = purchase.installments.length - paidCount;
    const lastInstallment = purchase.installments[purchase.installments.length - 1];
    return {
      ...purchase,
      currentInstallmentNumber: Math.min(paidCount + 1, purchase.installmentCount),
      remainingInstallments: Math.max(0, remaining),
      lastInstallmentMonth: lastInstallment?.billMonth ?? null,
    };
  });
}
