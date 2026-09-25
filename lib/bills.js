import { prisma } from "./prisma.js";
import { addMonthKey } from "./formatMoney.js";
import { money } from "./money.js";
import { resolveConfidence } from "./dataConfidence.js";

// Decimal-first (Fase 3.1): `amount` convertido via money() na entrada — aceita
// number puro (vindo de rota de API/form) ou já um Decimal (vindo de commitBotIntent.js).
// Fase 3.2: `confidence` opcional — omitido/undefined vira CONFIRMED (resolveConfidence).
// Fase 5.3C.2 — `client` opcional (default: `prisma`): permite compor dentro
// de uma transação externa (ex: lib/telegramUpdateHandler.js). Aditivo,
// nenhum call-site existente muda de comportamento.
export async function createBill({ description, amount, category, accountId, dueDate, recurringRuleId, cycleMonth, notes, source, confidence, rawMessage }, { client = prisma } = {}) {
  return client.bill.create({
    data: {
      description,
      amount: money(amount),
      category: category || "Outros",
      accountId: accountId || null,
      dueDate,
      recurringRuleId: recurringRuleId || null,
      cycleMonth: cycleMonth || null,
      notes: notes || null,
      source: source || "manual",
      confidence: resolveConfidence(confidence),
      rawMessage: rawMessage || null,
    },
  });
}

// Fase 5.3C.2 — `client` opcional. Padrão "própria transação OU participa de
// uma externa": se `client` continua sendo o `prisma` global (comportamento
// padrão, todo call-site pré-existente), esta função abre sua PRÓPRIA
// `prisma.$transaction` como sempre fez. Se `client` já é um transaction
// client (`tx`) passado de fora, usa ELE diretamente — nunca aninha
// `$transaction` dentro de outra (o Prisma não suporta isso), o que permite
// esta função compor atomicamente dentro de uma transação maior (o caminho
// do Telegram, que precisa que o claim do update + esta mutação + o receipt
// completo sejam tudo-ou-nada).
export async function markBillPaid(billId, { accountId, occurredAt, description, confidence } = {}, { client = prisma } = {}) {
  if (client === prisma) {
    return prisma.$transaction((tx) => markBillPaidTx(tx, billId, { accountId, occurredAt, description, confidence }));
  }
  return markBillPaidTx(client, billId, { accountId, occurredAt, description, confidence });
}

async function markBillPaidTx(tx, billId, { accountId, occurredAt, description, confidence }) {
  const bill = await tx.bill.findUnique({ where: { id: billId } });
  if (!bill) throw new Error("Conta a pagar não encontrada");
  if (bill.status === "paid") throw new Error("Conta já está paga");

  const resolvedAccountId = accountId || bill.accountId;
  if (!resolvedAccountId) throw new Error("Informe a conta usada pra pagar");

  const expense = await tx.expense.create({
    data: {
      amount: bill.amount,
      description: description || bill.description,
      category: bill.category || "Outros",
      accountId: resolvedAccountId,
      billId: bill.id,
      source: bill.source === "telegram" ? "telegram" : "manual",
      // O Expense que nasce do pagamento de uma Bill herda a confidence explícita
      // do pagamento se houver uma; senão cai no default (CONFIRMED) — não herda
      // silenciosamente a confidence da própria Bill (são fatos distintos: "a
      // conta existe" vs "ela foi paga agora, por este valor").
      confidence: resolveConfidence(confidence),
      occurredAt: occurredAt || new Date(),
    },
  });
  const updated = await tx.bill.update({
    where: { id: bill.id },
    data: { status: "paid", paidAt: occurredAt || new Date() },
  });
  return { expense, bill: updated };
}

export async function cancelBill(billId) {
  return prisma.bill.update({ where: { id: billId }, data: { status: "cancelled" } });
}

// Fase 9.1 — LEITURA NUNCA ESCREVE. Antes, listBills() rodava um UPDATE (pending -> overdue) em
// todo GET. Agora "atrasada" é derivada em memória (mesmo resultado pra quem lê); esta função
// continua existindo só pra quem quiser persistir explicitamente, e nenhum caminho de leitura a chama.
export async function syncOverdueStatuses() {
  const now = new Date();
  await prisma.bill.updateMany({
    where: { status: "pending", dueDate: { lt: now } },
    data: { status: "overdue" },
  });
}

export async function listBills({ status, withinDays } = {}) {
  const now = new Date();
  const derive = (b) => (b.status === "pending" && b.dueDate && b.dueDate < now ? { ...b, status: "overdue" } : b);
  const wanted = status ? (Array.isArray(status) ? status : [status]) : null;
  const where = {};
  if (wanted) {
    // "overdue" é derivado: uma Bill pending com vencimento passado também é "overdue".
    const statuses = new Set(wanted);
    if (statuses.has("overdue")) statuses.add("pending");
    where.status = { in: [...statuses] };
  }
  if (withinDays != null) {
    const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
    where.OR = [{ dueDate: { lte: horizon } }, { dueDate: null }];
  }
  const rows = await prisma.bill.findMany({ where, include: { account: true, recurringRule: true }, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] });
  const derived = rows.map(derive);
  return wanted ? derived.filter((b) => wanted.includes(b.status)) : derived;
}

// Materializa (se ainda não existir) a próxima Bill de uma RecurringRule de despesa pro ciclo dado.
export async function getOrCreateBillForRule(rule, cycleMonth) {
  const existing = await prisma.bill.findFirst({
    where: { recurringRuleId: rule.id, cycleMonth },
  });
  if (existing) return existing;

  const [year, month] = cycleMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Fase 9.1 — dia desconhecido (null) => vencimento desconhecido (null), nunca inventado.
  const dueDate = rule.dayOfMonth == null ? null : new Date(Date.UTC(year, month - 1, Math.min(rule.dayOfMonth, lastDay)));

  return prisma.bill.create({
    data: {
      description: rule.name,
      amount: money(rule.amount),
      category: rule.category || "Outros",
      accountId: rule.accountId,
      dueDate,
      recurringRuleId: rule.id,
      cycleMonth,
      source: "manual",
      // Sem heurística automática nesta fase (Fase 3.2, item 6) — mesmo default
      // CONFIRMED de toda criação normal. Nota: quando rule.amount é null (valor
      // variável), isso materializa com amount 0 — achado P1-9 da auditoria,
      // marcar como estimativa de verdade é trabalho de uma fase futura
      // (CategoryBudget/isEstimated), não desta.
      confidence: resolveConfidence(undefined),
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
