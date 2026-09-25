// ============================================================================
// Fase 9.1 — READ-MODEL da página Compromissos (e do resumo da Home). SOMENTE LEITURA.
// Tudo vem do domínio real: planos externos (progresso REAL, incluindo o histórico anterior ao
// Norte), contas da casa (regras + competência persistida/projetada), compromissos confirmados/
// separados. Nenhum número é hardcoded; "este mês" = competência corrente no fuso do app.
// ============================================================================
import { prisma } from "./prisma.js";
import { money, sumMoney, serializeMoney, ZERO } from "./money.js";
import { listExternalInstallmentPlans } from "./externalInstallments.js";
import { listHouseBillInstances, AMOUNT_KIND } from "./houseBills.js";
import { listAccountsWithBalances } from "./accounts.js";
import { computeReliefTimeline } from "./relief.js";
import { currentMonthKey, monthBounds, monthLongName } from "./paymentDates.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";

const num = (x) => (x == null ? null : Number(serializeMoney(x)));

function whenLabel(date, today) {
  if (!date) return "";
  const d = new Date(date);
  const diff = Math.round((today.getTime() - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function cleanCreditor(plan) {
  const c = (plan.creditor ?? "").trim();
  return c && c !== "—" && c.toLowerCase() !== plan.description.trim().toLowerCase() ? c : null;
}

export async function buildCommitmentsModel({ now = new Date(), client = prisma } = {}) {
  const monthKey = currentMonthKey(now);
  const { start: monthStart, end: monthEnd } = monthBounds(monthKey);
  const today = localCalendarDateAsUtcMidnight(now, getAppTimezone());

  const [plans, houseInstances, commitments, accountRows] = await Promise.all([
    listExternalInstallmentPlans({ status: "ACTIVE", client }),
    listHouseBillInstances({ cycleMonth: monthKey, now, client }),
    client.confirmedCommitment.findMany({ where: { status: { in: ["CONFIRMED", "FUNDED", "SETTLED"] } }, orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] }),
    listAccountsWithBalances({ client }),
  ]);

  // paid-by-installment expense accounts (nome da conta de origem)
  const paidExpenseIds = plans.flatMap((p) => p.installments.filter((i) => i.status === "PAID" && i.expenseId).map((i) => i.expenseId));
  const paidExpenses = paidExpenseIds.length ? await client.expense.findMany({ where: { id: { in: paidExpenseIds } }, include: { account: true } }) : [];
  const expenseById = new Map(paidExpenses.map((e) => [e.id, e]));

  const items = [];

  // ---------------------------------------------------------------- parcelamentos
  // ordem estável de cadastro (mais antigo primeiro), como no protótipo
  for (const plan of [...plans].sort((a, b) => a.createdAt - b.createdAt)) {
    const value = money(plan.installmentValue);
    const pendingRows = plan.installments.filter((i) => i.status === "PENDING");
    const paidThisMonth = plan.installments.filter((i) => i.status === "PAID" && i.paidAt && i.paidAt >= monthStart && i.paidAt < monthEnd).sort((a, b) => b.number - a.number)[0] ?? null;
    if (pendingRows.length === 0 && !paidThisMonth) continue; // quitado em mês anterior
    const total = plan.installmentCount;
    const paidCount = Math.max(0, total - pendingRows.length);
    const nextPending = pendingRows.sort((a, b) => a.number - b.number)[0] ?? null;
    const done = !!paidThisMonth;
    const shown = done ? paidThisMonth : nextPending;
    const expense = paidThisMonth?.expenseId ? expenseById.get(paidThisMonth.expenseId) : null;
    items.push({
      id: `parc:${plan.id}`,
      kind: "parcela",
      kindLabel: "Parcelamento",
      name: plan.description,
      to: cleanCreditor(plan),
      note: plan.notes && !/^prior explicit/i.test(plan.notes) ? plan.notes : null,
      state: done ? "done" : "pending",
      awaitingValue: false,
      overdue: false,
      value: num(value),
      parcela: {
        planId: plan.id,
        installmentId: shown.id,
        current: shown.number,
        total,
        paidCount,
        remainingCount: pendingRows.length,
        remainingAmount: num(value.times(pendingRows.length)),
        isLast: !done && nextPending?.number === total,
      },
      pay: done ? null : { kind: "installment", installmentId: nextPending.id },
      undo: done ? { kind: "installment", id: paidThisMonth.id, expectedUpdatedAt: paidThisMonth.updatedAt.toISOString() } : null,
      done: done
        ? { paidAt: paidThisMonth.paidAt.toISOString(), when: whenLabel(paidThisMonth.paidAt, today), sourceName: expense?.account?.name ?? null, withoutExpense: !paidThisMonth.expenseId, value: num(value), line: `Parcela ${paidThisMonth.number}/${total} paga` }
        : null,
    });
  }

  // ---------------------------------------------------------------- contas da casa
  const lastPaidByRule = new Map();
  const variableRuleIds = [...new Set(houseInstances.filter((i) => i.amountKind === AMOUNT_KIND.VARIABLE).map((i) => i.ruleId))];
  for (const ruleId of variableRuleIds) {
    const last = await client.bill.findFirst({ where: { recurringRuleId: ruleId, status: "paid" }, orderBy: { paidAt: "desc" } });
    if (last) lastPaidByRule.set(ruleId, { amount: num(last.amount), cycleMonth: last.cycleMonth });
  }
  const byRule = new Map();
  for (const inst of houseInstances) (byRule.get(inst.ruleId) ?? byRule.set(inst.ruleId, []).get(inst.ruleId)).push(inst);
  for (const [ruleId, parts] of byRule) {
    parts.sort((a, b) => a.part - b.part);
    const first = parts[0];
    const paidParts = parts.filter((p) => p.status === "PAID");
    const pendingParts = parts.filter((p) => p.status === "PENDING");
    const done = pendingParts.length === 0;
    const nextPart = pendingParts[0] ?? null;
    const lastPaidPart = paidParts.sort((a, b) => b.part - a.part)[0] ?? null;
    const partAmount = nextPart ? nextPart.partAmount : lastPaidPart?.partAmount ?? first.partAmount;
    const totalMonthly = parts.reduce((acc, p) => (p.partAmount ? acc.plus(p.partAmount) : acc), ZERO);
    const paidValue = paidParts.reduce((acc, p) => (p.partAmount ? acc.plus(p.partAmount) : acc), ZERO);
    const lastPaid = paidParts.map((p) => p.paidAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
    items.push({
      id: `casa:${ruleId}`,
      kind: "casa",
      kindLabel: "Conta da casa",
      name: first.name,
      to: null,
      note: null,
      state: done ? "done" : "pending",
      awaitingValue: !done && !!nextPart?.awaitingValue,
      overdue: !done && !!nextPart?.overdue,
      value: num(partAmount),
      casa: {
        ruleId,
        cycleMonth: first.cycleMonth,
        part: (nextPart ?? lastPaidPart ?? first).part,
        partsTotal: first.partsTotal,
        partsPaid: paidParts.length,
        amountKind: first.amountKind,
        cadence: first.cadence,
        defaultAccountId: first.defaultAccountId,
        dueDay: first.dueDay,
        dueDate: (nextPart?.dueDate ?? first.dueDate)?.toISOString() ?? null,
        referenceMin: num(first.referenceMin),
        referenceMax: num(first.referenceMax),
        monthlyTotal: num(totalMonthly),
        remainingAmount: num(pendingParts.reduce((acc, p) => (p.partAmount ? acc.plus(p.partAmount) : acc), ZERO)),
        lastPaid: lastPaidByRule.get(ruleId) ?? null,
      },
      pay: done ? null : { kind: "house", ruleId, cycleMonth: first.cycleMonth, part: nextPart.part },
      undo: done && lastPaidPart?.billId ? { kind: "house", id: lastPaidPart.billId, expectedUpdatedAt: lastPaidPart.billUpdatedAt.toISOString() } : null,
      done: done
        ? { paidAt: lastPaid?.toISOString() ?? null, when: whenLabel(lastPaid, today), sourceName: lastPaidPart?.paidAccountName ?? null, withoutExpense: paidParts.every((p) => p.paidWithoutExpense), value: num(paidValue), line: first.partsTotal > 1 ? `${first.partsTotal} de ${first.partsTotal} visitas pagas` : "Conta da casa paga" }
        : null,
    });
  }

  // ---------------------------------------------------------------- compromissos confirmados
  // Só entram em "Concluídos" os compromissos liquidados PELA UI/serviço (Expense/Transfer com a marca
  // "settle-commitment:") — um compromisso antigo liquidado por outro caminho (ex.: Tattoo, Fase 8) não
  // vira "1 resolvido" do mês nem soma em "Já pago".
  const settledIds = commitments.filter((c) => c.status === "SETTLED" && c.expenseId).map((c) => c.expenseId);
  const settledExp = settledIds.length ? await client.expense.findMany({ where: { id: { in: settledIds } }, select: { id: true, rawMessage: true } }) : [];
  const viaUi = new Set(settledExp.filter((e) => (e.rawMessage ?? "").startsWith("settle-commitment:")).map((e) => e.id));
  const settledViaUi = (c) => c.status === "SETTLED" && (c.settledTransferId || (c.expenseId && viaUi.has(c.expenseId)));
  const funded = [];
  for (const c of commitments) {
    const base = { id: c.id, description: c.description, amount: num(c.amount), dueDate: c.dueDate?.toISOString() ?? null, shortLabel: c.shortLabel, settlementMode: c.settlementMode, updatedAt: c.updatedAt.toISOString() };
    if (c.status === "FUNDED") funded.push({ ...base, pay: { kind: "commitment", commitmentId: c.id }, ctaLabel: c.settlementMode === "EXTERNAL_TRANSFER" ? "Marcar como devolvido" : "Marcar como paga" });
    if (c.status === "CONFIRMED") {
      items.push({ id: `comp:${c.id}`, kind: "compromisso", kindLabel: "Compromisso", name: c.description, to: null, note: null, state: "pending", awaitingValue: false, overdue: !!c.dueDate && c.dueDate < today, value: num(c.amount), compromisso: { commitmentId: c.id, dueDate: base.dueDate }, pay: { kind: "commitment", commitmentId: c.id }, undo: null, done: null });
    }
    if (settledViaUi(c) && c.settledAt && c.settledAt >= monthStart && c.settledAt < monthEnd && c.settlementMode !== "EXTERNAL_TRANSFER") {
      items.push({ id: `comp:${c.id}`, kind: "compromisso", kindLabel: "Compromisso", name: c.description, to: null, note: null, state: "done", awaitingValue: false, overdue: false, value: num(c.amount), compromisso: { commitmentId: c.id, dueDate: base.dueDate }, pay: null, undo: { kind: "commitment", id: c.id, expectedUpdatedAt: base.updatedAt }, done: { paidAt: c.settledAt.toISOString(), when: whenLabel(c.settledAt, today), sourceName: null, withoutExpense: false, value: num(c.amount), line: "Compromisso pago" } });
    }
  }
  // devolução liquidada este mês continua visível em "Concluídos" (com opção de desfazer)
  for (const c of commitments) {
    if (settledViaUi(c) && c.settlementMode === "EXTERNAL_TRANSFER" && c.settledAt && c.settledAt >= monthStart && c.settledAt < monthEnd) {
      items.push({ id: `comp:${c.id}`, kind: "compromisso", kindLabel: "Compromisso", name: c.description, to: null, note: null, state: "done", awaitingValue: false, overdue: false, value: num(c.amount), compromisso: { commitmentId: c.id, dueDate: c.dueDate?.toISOString() ?? null }, pay: null, undo: { kind: "commitment", id: c.id, expectedUpdatedAt: c.updatedAt.toISOString() }, done: { paidAt: c.settledAt.toISOString(), when: whenLabel(c.settledAt, today), sourceName: null, withoutExpense: false, value: num(c.amount), line: "Devolvido" } });
    }
  }

  // ---------------------------------------------------------------- resumo
  const doneItems = items.filter((i) => i.state === "done");
  const pendingItems = items.filter((i) => i.state === "pending");
  const paidSum = doneItems.reduce((a, i) => a + (i.done.value ?? 0), 0) + pendingItems.filter((i) => i.kind === "casa" && i.casa.partsPaid > 0).reduce((a, i) => a + (i.casa.monthlyTotal - i.casa.remainingAmount), 0);
  const pendSum = pendingItems.reduce((a, i) => a + (i.kind === "casa" ? i.casa.remainingAmount : i.value ?? 0), 0);
  const awaitingCount = pendingItems.filter((i) => i.awaitingValue).length;
  const fundedTotal = funded.reduce((a, f) => a + f.amount, 0);

  const relief = computeReliefTimeline(plans, { monthKey, monthStart, monthEnd });
  const casaItems = items.filter((i) => i.kind === "casa");
  const parcItems = items.filter((i) => i.kind === "parcela");

  return {
    monthKey,
    monthLong: monthLongName(monthKey),
    generatedAt: now.toISOString(),
    summary: {
      total: items.length,
      resolved: doneItems.length,
      pending: pendingItems.length,
      paidAmount: Math.round(paidSum * 100) / 100,
      pendingAmount: Math.round(pendSum * 100) / 100,
      awaitingValueCount: awaitingCount,
      fundedAmount: Math.round(fundedTotal * 100) / 100,
      parcelCount: parcItems.length,
      parcelRemainingTotal: Math.round(parcItems.reduce((a, i) => a + i.parcela.remainingAmount, 0) * 100) / 100,
      casaCount: casaItems.length,
      casaResolved: casaItems.filter((i) => i.state === "done").length,
      casaMonthly: Math.round(casaItems.reduce((a, i) => a + (i.casa.monthlyTotal ?? 0), 0) * 100) / 100,
    },
    // contas elegíveis como ORIGEM de pagamento (VA é restrito a comida, nunca aparece aqui)
    accounts: accountRows.filter((a) => a.type !== "food_voucher").map((a) => ({ id: a.id, name: a.name, type: a.type, balance: num(a.balance) })),
    items,
    funded,
    relief,
  };
}
