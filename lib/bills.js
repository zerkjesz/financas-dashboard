import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";

export async function createBill({ description, amount, category, accountId, dueDate, recurringRuleId, cycleMonth, notes, source, rawMessage }) {
  return prisma.bill.create({
    data: {
      description,
      amount,
      category: category || "Outros",
      accountId: accountId || null,
      dueDate,
      recurringRuleId: recurringRuleId || null,
      cycleMonth: cycleMonth || null,
      notes: notes || null,
      source: source || "manual",
      rawMessage: rawMessage || null,
    },
  });
}

export async function markBillPaid(billId, { accountId, occurredAt, description } = {}) {
  const bill = await prisma.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new Error("Conta a pagar não encontrada");
  if (bill.status === "paid") throw new Error("Conta já está paga");

  const resolvedAccountId = accountId || bill.accountId;
  if (!resolvedAccountId) throw new Error("Informe a conta usada pra pagar");

  return prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        amount: bill.amount,
        description: description || bill.description,
        category: bill.category || "Outros",
        accountId: resolvedAccountId,
        billId: bill.id,
        source: bill.source === "telegram" ? "telegram" : "manual",
        occurredAt: occurredAt || new Date(),
      },
    });
    const updated = await tx.bill.update({
      where: { id: bill.id },
      data: { status: "paid", paidAt: occurredAt || new Date() },
    });
    return { expense, bill: updated };
  });
}

export async function cancelBill(billId) {
  return prisma.bill.update({ where: { id: billId }, data: { status: "cancelled" } });
}

export async function syncOverdueStatuses() {
  const now = new Date();
  await prisma.bill.updateMany({
    where: { status: "pending", dueDate: { lt: now } },
    data: { status: "overdue" },
  });
}

export async function listBills({ status, withinDays } = {}) {
  await syncOverdueStatuses();
  const where = {};
  if (status) where.status = Array.isArray(status) ? { in: status } : status;
  if (withinDays != null) {
    const horizon = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
    where.dueDate = { lte: horizon };
  }
  return prisma.bill.findMany({ where, include: { account: true, recurringRule: true }, orderBy: { dueDate: "asc" } });
}

// Materializa (se ainda não existir) a próxima Bill de uma RecurringRule de despesa pro ciclo dado.
export async function getOrCreateBillForRule(rule, cycleMonth) {
  const existing = await prisma.bill.findUnique({
    where: { recurringRuleId_cycleMonth: { recurringRuleId: rule.id, cycleMonth } },
  });
  if (existing) return existing;

  const [year, month] = cycleMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dueDate = new Date(Date.UTC(year, month - 1, Math.min(rule.dayOfMonth, lastDay)));

  return prisma.bill.create({
    data: {
      description: rule.name,
      amount: rule.amount || 0,
      category: rule.category || "Outros",
      accountId: rule.accountId,
      dueDate,
      recurringRuleId: rule.id,
      cycleMonth,
      source: "manual",
    },
  });
}

// Garante que toda RecurringRule de despesa ativa tem a próxima parcela materializada como Bill.
export async function ensureUpcomingRecurringBills() {
  const rules = await prisma.recurringRule.findMany({ where: { isActive: true, kind: "expense" } });
  const now = new Date();
  const currentCycle = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const nextCycle = addMonthKey(currentCycle, 1);

  for (const rule of rules) {
    await getOrCreateBillForRule(rule, currentCycle);
    await getOrCreateBillForRule(rule, nextCycle);
  }
}
