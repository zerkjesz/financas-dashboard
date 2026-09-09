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
// Fase 5.3E — extraído em função PURA (sem banco) pra ser reutilizável pelo
// simulador (lib/simulation/financialSimulator.js) sem duplicar a conta de
// arredondamento — a MESMA lógica usada pra parcelas reais. Recebe os campos
// já resolvidos (não um `purchase` persistido) e devolve as rows SEM
// persistir nada — quem grava (generateInstallmentSchedule abaixo) chama
// isto e só então faz o createMany.
export function computeInstallmentScheduleRows({ totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber = 1 }) {
  const total = money(totalAmount);
  const value = money(installmentValue);

  const rows = [];
  for (let number = startingInstallmentNumber; number <= installmentCount; number++) {
    const isLast = number === installmentCount;
    const amount = isLast ? roundMoney(subtractMoney(total, multiplyMoney(value, installmentCount - 1))) : value;
    rows.push({
      number,
      amount,
      billMonth: addMonthKey(firstInstallmentMonth, number - 1),
    });
  }
  return rows;
}

// Decimal-first (Fase 3.1): totalAmount/installmentValue já vêm como Decimal (Purchase
// recém-criada). O ajuste da última parcela (total - installmentValue*(count-1)) roda
// inteiro em Decimal, arredondado só uma vez no fim via roundMoney — evita o erro
// acumulado que Number teria em compras com muitas parcelas.
// Fase 5.3C.2 — `client` opcional (default: `prisma`), mesmo padrão aditivo
// já usado no resto do projeto.
export async function generateInstallmentSchedule(purchase, { client = prisma } = {}) {
  const { id: purchaseId, totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber } = purchase;
  const rows = computeInstallmentScheduleRows({ totalAmount, installmentCount, installmentValue, firstInstallmentMonth, startingInstallmentNumber }).map((row) => ({
    ...row,
    purchaseId,
  }));

  await client.installment.createMany({ data: rows });
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
