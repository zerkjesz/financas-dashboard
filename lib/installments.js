import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";

// Gera as parcelas de `startingInstallmentNumber` até `installmentCount`, cada uma no
// billMonth correspondente (firstInstallmentMonth = mês da parcela 1, mesmo que ela já
// tenha ficado no passado e não seja gerada por estarmos importando uma compra em andamento).
// A última parcela absorve a sobra de arredondamento.
export async function generateInstallmentSchedule(purchase) {
  const { id: purchaseId, totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber } = purchase;

  const rows = [];
  for (let number = startingInstallmentNumber; number <= installmentCount; number++) {
    const isLast = number === installmentCount;
    const amount = isLast
      ? Math.round((totalAmount - installmentValue * (installmentCount - 1)) * 100) / 100
      : installmentValue;
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
    const currentMonth = new Date().toISOString().slice(0, 7);
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
