import { prisma } from "./prisma.js";
import { money, multiplyMoney } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Fase 3.3 — parcelas que NÃO pertencem ao cartão pessoal (dívida com outra
// pessoa/credor direto — MacBook, TV, Casa Ubatuba etc). Diferente de
// lib/installments.js (Purchase/Installment, sempre presa a um Card).

function addMonths(date, count) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1); // evita overflow de mês em dias como 31 (mesmo cuidado do resto do app)
  d.setUTCMonth(d.getUTCMonth() + count);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

// ============================================================================
// READ
// ============================================================================

// Todas as parcelas deste plano têm o MESMO valor (installmentValue) — diferente
// de Purchase/Installment, não existe ajuste de arredondamento na última parcela
// aqui, então totalAmount é sempre derivável por multiplicação simples. Nunca
// armazenado em campo próprio (evitaria uma segunda fonte de verdade).
export function computePlanTotal(plan) {
  return multiplyMoney(plan.installmentValue, plan.installmentCount);
}

// Puramente derivado das ExternalInstallment — nunca um campo/status separado (é
// exatamente o anti-padrão que este model foi desenhado pra evitar, ver schema.prisma).
export function computePlanProgress(installments) {
  const paidCount = installments.filter((i) => i.status === "PAID").length;
  return { paidCount, totalCount: installments.length, isFullyPaid: installments.length > 0 && paidCount === installments.length };
}

export async function listExternalInstallmentPlans({ status } = {}) {
  const plans = await prisma.externalInstallmentPlan.findMany({
    where: status ? { status } : undefined,
    include: { installments: { orderBy: { number: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return plans.map((plan) => ({
    ...plan,
    totalAmount: computePlanTotal(plan),
    progress: computePlanProgress(plan.installments),
  }));
}

// ============================================================================
// MUTATION
// ============================================================================

// Transacional: cria o Plan e todas as N parcelas (number 1..N, cada uma com o
// mesmo installmentValue) numa única prisma.$transaction — nunca fica um Plan
// sem parcelas se algo falhar no meio. NUNCA cria um Card falso pra representar
// isso.
//
// Fase 5.2B — `dueTiming` decide a estratégia temporal (fonte única no Plan,
// nunca duplicada nas installments — ver schema.prisma). Validação de domínio
// EXPLÍCITA aqui, não só um comentário/constraint de banco (item 4 do pedido):
//   CALENDAR_DATE       -> firstDueDate obrigatória; cada installment recebe
//                          uma dueDate real, espaçada em meses.
//   AFTER_NEXT_INCOME   -> firstDueDate deve ficar AUSENTE (rejeitado se
//                          informada — evita a ilusão de uma data exata que
//                          não existe); cada installment fica com dueDate=null,
//                          NUNCA um sentinel fake (1970-01-01/2099-01-01/data
//                          do salário/hoje) — ver lib/obligationClassifier.js
//                          pra como isso é classificado sem data.
export async function createExternalInstallmentPlan({
  description,
  creditor,
  installmentValue,
  installmentCount,
  firstDueDate,
  dueTiming = "CALENDAR_DATE",
  confidence,
  notes,
}) {
  if (!description) throw new Error("description é obrigatória");
  if (!creditor) throw new Error("creditor é obrigatório");
  const valueMoney = money(installmentValue);
  if (!valueMoney.gt(0)) throw new Error("installmentValue precisa ser positivo");
  if (!Number.isInteger(installmentCount) || installmentCount <= 0) {
    throw new Error("installmentCount precisa ser um inteiro positivo");
  }
  if (dueTiming !== "CALENDAR_DATE" && dueTiming !== "AFTER_NEXT_INCOME") {
    throw new Error(`dueTiming inválido: "${dueTiming}" — precisa ser CALENDAR_DATE ou AFTER_NEXT_INCOME`);
  }
  if (dueTiming === "CALENDAR_DATE" && !firstDueDate) {
    throw new Error("firstDueDate é obrigatória quando dueTiming=CALENDAR_DATE");
  }
  if (dueTiming === "AFTER_NEXT_INCOME" && firstDueDate) {
    throw new Error("firstDueDate deve ficar ausente quando dueTiming=AFTER_NEXT_INCOME — não inventar uma data de calendário pra um plano cujo timing é relativo à próxima renda");
  }

  const resolvedConfidence = resolveConfidence(confidence);
  const resolvedFirstDueDate = dueTiming === "CALENDAR_DATE" ? new Date(firstDueDate) : null;

  return prisma.$transaction(async (tx) => {
    const plan = await tx.externalInstallmentPlan.create({
      data: {
        description,
        creditor,
        installmentValue: valueMoney,
        installmentCount,
        firstDueDate: resolvedFirstDueDate,
        dueTiming,
        confidence: resolvedConfidence,
        notes: notes || null,
      },
    });

    const rows = Array.from({ length: installmentCount }, (_, i) => ({
      planId: plan.id,
      number: i + 1,
      amount: valueMoney,
      dueDate: dueTiming === "CALENDAR_DATE" ? addMonths(plan.firstDueDate, i) : null,
    }));
    await tx.externalInstallment.createMany({ data: rows });

    const installments = await tx.externalInstallment.findMany({ where: { planId: plan.id }, orderBy: { number: "asc" } });
    return { ...plan, installments };
  });
}

export async function cancelExternalInstallmentPlan(planId) {
  return prisma.externalInstallmentPlan.update({ where: { id: planId }, data: { status: "CANCELLED" } });
}

// Marca UMA parcela como paga. `expenseId` é opcional (ver comentário no schema —
// parcela paga antes do início do histórico operacional pode não ter Expense
// operacional correspondente). Rejeita pagamento duplicado explicitamente (não
// silencioso) — nunca marca a MESMA parcela paga duas vezes, e o `@unique` em
// ExternalInstallment.expenseId garante no banco que o mesmo Expense nunca é
// vinculado a duas parcelas diferentes.
export async function markExternalInstallmentPaid(installmentId, { expenseId, paidAt } = {}) {
  const installment = await prisma.externalInstallment.findUnique({ where: { id: installmentId } });
  if (!installment) throw new Error("Parcela não encontrada");
  if (installment.status === "PAID") {
    throw new Error(`Parcela ${installment.number} já está marcada como paga (rejeitado — pagamento duplicado)`);
  }

  return prisma.externalInstallment.update({
    where: { id: installmentId },
    data: { status: "PAID", paidAt: paidAt || new Date(), expenseId: expenseId || null },
  });
}
