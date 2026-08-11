import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Valores reais confirmados com o usuário em 2026-08-11.
const SEED = {
  itauBalance: 749.56,
  dinheiroBalance: 0,
  vaBalance: 0,
  cardTotalLimit: 4027,
  cardUsedLimit: 2262.95,
  cardDueDay: 11,
  vaRechargeAmount: 1300,
  vaRechargeDay: 24,
};

async function main() {
  const existing = await prisma.account.findFirst();
  if (existing) {
    console.log("Já existem Accounts no banco — script já foi rodado antes. Abortando pra não duplicar.");
    return;
  }

  const legacyRows = await prisma.legacyTransaction.findMany({ orderBy: { occurredAt: "asc" } });
  console.log(`Lidas ${legacyRows.length} linhas de transaction_legacy.`);

  await prisma.$transaction(async (tx) => {
    const itau = await tx.account.create({
      data: { slug: "itau", name: "Itaú", type: "checking" },
    });
    const dinheiro = await tx.account.create({
      data: { slug: "dinheiro", name: "Dinheiro", type: "cash" },
    });
    const va = await tx.account.create({
      data: { slug: "vale-alimentacao", name: "Vale Alimentação", type: "food_voucher" },
    });
    const card = await tx.card.create({
      data: {
        slug: "itau-card",
        name: "Itaú",
        accountId: itau.id,
        totalLimit: SEED.cardTotalLimit,
        closingDay: null,
        dueDay: SEED.cardDueDay,
      },
    });

    await tx.balanceAdjustment.create({
      data: { accountId: itau.id, newBalance: SEED.itauBalance, source: "migration", note: "Saldo inicial informado pelo usuário" },
    });
    await tx.balanceAdjustment.create({
      data: { accountId: dinheiro.id, newBalance: SEED.dinheiroBalance, source: "migration", note: "Conta não usada até o momento da migração" },
    });
    await tx.balanceAdjustment.create({
      data: { accountId: va.id, newBalance: SEED.vaBalance, source: "migration", note: "Saldo inicial informado pelo usuário" },
    });
    await tx.cardLimitUpdate.create({
      data: {
        cardId: card.id,
        newTotalLimit: SEED.cardTotalLimit,
        newUsedLimit: SEED.cardUsedLimit,
        reportedAvailable: SEED.cardTotalLimit - SEED.cardUsedLimit,
        source: "migration",
        note: "Limite inicial informado pelo usuário",
      },
    });
    await tx.recurringRule.create({
      data: {
        name: "Vale Alimentação - Recarga",
        kind: "income",
        amount: SEED.vaRechargeAmount,
        dayOfMonth: SEED.vaRechargeDay,
        accountId: va.id,
        category: "Trabalho",
      },
    });

    const accountForPaymentMethod = (paymentMethod) => {
      if (paymentMethod === "food_voucher") return va.id;
      return itau.id; // pix, null, ou qualquer outro caem na conta Itaú (única conta real)
    };

    let incomeCount = 0;
    let expenseCount = 0;
    let expenseOnCardCount = 0;
    let installmentTaggedCount = 0;

    for (const row of legacyRows) {
      if (row.installmentCurrent != null || row.installmentTotal != null) {
        installmentTaggedCount++;
      }

      if (row.type === "income") {
        await tx.income.create({
          data: {
            amount: row.amount,
            description: row.description,
            category: row.category,
            accountId: accountForPaymentMethod(row.paymentMethod),
            isRecurring: row.isRecurring,
            source: "migration",
            rawMessage: row.rawMessage,
            legacyTransactionId: row.id,
            occurredAt: row.occurredAt,
          },
        });
        incomeCount++;
      } else {
        const isCard = row.paymentMethod === "credit_card";
        await tx.expense.create({
          data: {
            amount: row.amount,
            description: row.description,
            category: row.category,
            accountId: isCard ? null : accountForPaymentMethod(row.paymentMethod),
            cardId: isCard ? card.id : null,
            isRecurring: row.isRecurring,
            source: "migration",
            rawMessage: row.rawMessage,
            legacyTransactionId: row.id,
            occurredAt: row.occurredAt,
          },
        });
        expenseCount++;
        if (isCard) expenseOnCardCount++;
      }
    }

    console.log("Contas criadas:", { itau: itau.id, dinheiro: dinheiro.id, va: va.id });
    console.log("Cartão criado:", card.id);
    console.log(`Income criados: ${incomeCount}`);
    console.log(`Expense criados: ${expenseCount} (${expenseOnCardCount} no cartão)`);
    console.log(`Linhas com installmentCurrent/installmentTotal preservadas na descrição: ${installmentTaggedCount} (migradas como Expense normal — não viraram Purchase/Installment, pois só temos 1 parcela isolada de cada compra, não o total/cronograma completo)`);
  });

  const legacySum = legacyRows.reduce(
    (acc, r) => {
      acc[r.type] = (acc[r.type] || 0) + r.amount;
      return acc;
    },
    {}
  );
  const newIncomeSum = await prisma.income.aggregate({ where: { source: "migration" }, _sum: { amount: true }, _count: true });
  const newExpenseSum = await prisma.expense.aggregate({ where: { source: "migration" }, _sum: { amount: true }, _count: true });

  console.log("\n--- Verificação ---");
  console.log("Legado income:", legacySum.income, "| Novo Income:", newIncomeSum._sum.amount, `(${newIncomeSum._count} linhas)`);
  console.log("Legado expense:", legacySum.expense, "| Novo Expense:", newExpenseSum._sum.amount, `(${newExpenseSum._count} linhas)`);

  const incomeMatch = Math.abs((legacySum.income || 0) - (newIncomeSum._sum.amount || 0)) < 0.01;
  const expenseMatch = Math.abs((legacySum.expense || 0) - (newExpenseSum._sum.amount || 0)) < 0.01;
  const countMatch = newIncomeSum._count + newExpenseSum._count === legacyRows.length;

  if (incomeMatch && expenseMatch && countMatch) {
    console.log("\n✅ Migração conferida: somas e contagens batem com o histórico.");
  } else {
    console.log("\n⚠️  DIVERGÊNCIA — conferir manualmente antes de seguir em frente.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
