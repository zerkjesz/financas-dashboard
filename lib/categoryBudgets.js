import { prisma } from "./prisma.js";
import { money } from "./money.js";

// Fase 3.3 — CategoryBudget: config/intenção por ciclo (não fato reconstruído —
// sem `confidence` de propósito, ver schema.prisma). Nenhuma comparação/analytics
// real vs. orçado ainda (item 9 — fica pra fase futura, quando o ciclo 24→23 for
// aplicado de verdade nas telas).

function toDateOnly(value) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ============================================================================
// READ
// ============================================================================

export async function listCategoryBudgets({ cycleStart } = {}) {
  return prisma.categoryBudget.findMany({
    where: cycleStart ? { cycleStart: toDateOnly(cycleStart) } : undefined,
    orderBy: [{ cycleStart: "desc" }, { category: "asc" }],
  });
}

export async function getCategoryBudget(category, cycleStart) {
  return prisma.categoryBudget.findUnique({
    where: { category_cycleStart: { category, cycleStart: toDateOnly(cycleStart) } },
  });
}

// ============================================================================
// MUTATION
// ============================================================================

// Upsert explícito por (category, cycleStart) — é uma chamada de MUTATION direta
// (o usuário decidindo o orçamento), não um get-or-create escondido atrás de uma
// leitura.
export async function setCategoryBudget({ category, cycleStart, amount }) {
  if (!category) throw new Error("category é obrigatória");
  if (!cycleStart) throw new Error("cycleStart é obrigatório");
  const amountMoney = money(amount);
  if (!amountMoney.gt(0)) throw new Error("amount precisa ser positivo");

  const cycleStartDate = toDateOnly(cycleStart);
  return prisma.categoryBudget.upsert({
    where: { category_cycleStart: { category, cycleStart: cycleStartDate } },
    create: { category, cycleStart: cycleStartDate, amount: amountMoney },
    update: { amount: amountMoney },
  });
}

export async function deleteCategoryBudget(category, cycleStart) {
  return prisma.categoryBudget.delete({
    where: { category_cycleStart: { category, cycleStart: toDateOnly(cycleStart) } },
  });
}
