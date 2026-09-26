// ============================================================================
// Fase 9.1 — CONTAS DA CASA (aluguel, energia, internet, água, telefone, faxina...).
//
// Modelo (reaproveita o que já existia, sem estrutura paralela):
//   RecurringRule (kind "expense")  = a regra: nome, valor (fixo / aproximado / variável), dia
//                                     de vencimento (pode ser desconhecido), partes por
//                                     competência (faxina quinzenal = 2 x R$130).
//   Bill                            = a competência PAGA (uma por regra + mês + parte), ligada à
//                                     Expense do pagamento por billId.
//
// LEITURA NUNCA ESCREVE: a lista da competência é PERSISTIDA + PROJETADA (mesmo padrão de
// listCardBillsView) — uma conta ainda não paga existe só em memória, nunca vira Bill pendente no
// banco por causa de um GET (o antigo ensureUpcomingRecurringBills() escrevia em todo GET).
// A Bill só nasce no momento do pagamento, atômica com a Expense; desfazer remove essa Bill
// (volta a ser projetada). Assim o motor financeiro nunca enxerga Bill pendente fabricada.
//
// Valor variável (energia): sem valor conhecido a competência fica "aguardando valor"; o valor
// real é informado NO pagamento. Não cria Expense até pagar; a faixa "normal" (referenceMin/Max)
// é só contexto, nunca cobrança.
// ============================================================================
import { prisma } from "./prisma.js";
import { money, roundMoney, divideMoney, serializeMoney } from "./money.js";
import { getAppTimezone, localCalendarDateAsUtcMidnight } from "./appTimezone.js";
import { serializeRecord } from "./telegramAi/correctionService.js";
import { DomainError } from "./domainErrors.js";
import { assertPayableAccount } from "./installmentPayments.js";
import { currentMonthKey, resolvePaymentInstant } from "./paymentDates.js";

export const AMOUNT_KIND = Object.freeze({ FIXED: "FIXED", APPROXIMATE: "APPROXIMATE", VARIABLE: "VARIABLE" });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function dueDateFor(rule, cycleMonth) {
  if (rule.dayOfMonth == null) return null; // vencimento desconhecido: nunca inventado
  const [y, m] = cycleMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(rule.dayOfMonth, last)));
}

function partAmountFor(rule) {
  if (rule.amountKind === AMOUNT_KIND.VARIABLE || rule.amount == null) return null;
  return rule.partsPerCycle > 1 ? roundMoney(divideMoney(money(rule.amount), rule.partsPerCycle)) : money(rule.amount);
}

function partDescription(rule, part) {
  return rule.partsPerCycle > 1 ? `${rule.name} — visita ${part}/${rule.partsPerCycle}` : rule.name;
}

export async function listHouseBillInstances({ cycleMonth, now = new Date(), client = prisma } = {}) {
  const month = cycleMonth ?? currentMonthKey(now);
  if (!MONTH_RE.test(month)) throw new DomainError("INVALID", "Competência inválida (use AAAA-MM).");
  const rules = await client.recurringRule.findMany({ where: { kind: "expense", isActive: true }, orderBy: { createdAt: "asc" } });
  if (rules.length === 0) return [];
  const bills = await client.bill.findMany({ where: { recurringRuleId: { in: rules.map((r) => r.id) }, cycleMonth: month, status: { not: "cancelled" } }, include: { expense: { include: { account: true } } } });
  const byKey = new Map(bills.map((b) => [`${b.recurringRuleId}:${b.part}`, b]));
  const today = localCalendarDateAsUtcMidnight(now, getAppTimezone());
  const out = [];
  for (const rule of rules) {
    for (let part = 1; part <= rule.partsPerCycle; part++) {
      const bill = byKey.get(`${rule.id}:${part}`) ?? null;
      const paid = bill?.status === "paid";
      // Bill pendente de regra VARIÁVEL com valor 0 (resíduo antigo) NÃO é "R$ 0": segue aguardando valor.
      const zeroVariablePending = !!bill && !paid && rule.amountKind === AMOUNT_KIND.VARIABLE && !money(bill.amount).gt(0);
      const partAmount = bill && !zeroVariablePending ? money(bill.amount) : partAmountFor(rule);
      const dueDate = bill?.dueDate ?? dueDateFor(rule, month);
      out.push({
        key: `${rule.id}:${month}:${part}`,
        ruleId: rule.id,
        name: rule.name,
        category: rule.category ?? "Moradia",
        defaultAccountId: rule.accountId,
        cycleMonth: month,
        part,
        partsTotal: rule.partsPerCycle,
        cadence: rule.cadence,
        amountKind: rule.amountKind,
        ruleAmount: rule.amount == null ? null : money(rule.amount),
        partAmount,
        referenceMin: rule.referenceMin == null ? null : money(rule.referenceMin),
        referenceMax: rule.referenceMax == null ? null : money(rule.referenceMax),
        dueDay: rule.dayOfMonth,
        dueDate,
        billId: bill?.id ?? null,
        billUpdatedAt: bill?.updatedAt ?? null,
        status: paid ? "PAID" : "PENDING",
        paidAt: paid ? bill.paidAt : null,
        expenseId: bill?.expense?.id ?? null,
        paidAccountName: bill?.expense?.account?.name ?? null,
        paidWithoutExpense: paid && !bill?.expense,
        overdue: !paid && dueDate != null && dueDate < today,
        awaitingValue: !paid && partAmount == null,
        notes: rule.notes,
      });
    }
  }
  return out;
}

export async function payHouseBill({ ruleId, cycleMonth, part = 1, accountId, when = "hoje", paidAt, amount, recordExpense = true, now = new Date() } = {}, { client = prisma } = {}) {
  const month = cycleMonth ?? currentMonthKey(now);
  if (!MONTH_RE.test(month)) throw new DomainError("INVALID", "Competência inválida (use AAAA-MM).");
  const run = async (tx) => {
    const rule = await tx.recurringRule.findUnique({ where: { id: ruleId } });
    if (!rule || rule.kind !== "expense") throw new DomainError("NOT_FOUND", "Conta da casa não encontrada.");
    if (!rule.isActive) throw new DomainError("INVALID", "Esta conta está desativada.");
    if (!Number.isInteger(part) || part < 1 || part > rule.partsPerCycle) throw new DomainError("INVALID", "Parte inválida para esta conta.");
    const existing = await tx.bill.findFirst({ where: { recurringRuleId: rule.id, cycleMonth: month, part } });
    if (existing?.status === "paid") throw new DomainError("ALREADY_PAID", `${partDescription(rule, part)} já está paga em ${month}.`);

    // Valor: variável => informado no pagamento; aproximado => pode ser ajustado; fixo => o da regra.
    let value;
    const informed = amount == null ? null : money(amount);
    if (rule.amountKind === AMOUNT_KIND.VARIABLE || rule.amount == null) {
      if (!informed || !informed.gt(0)) throw new DomainError("INVALID", "Informe o valor desta conta para pagar.");
      value = informed;
    } else if (rule.amountKind === AMOUNT_KIND.APPROXIMATE && informed && informed.gt(0)) {
      value = informed;
    } else {
      value = partAmountFor(rule);
    }

    const occurredAt = paidAt ? new Date(paidAt) : resolvePaymentInstant(when, now);
    if (recordExpense) await assertPayableAccount(tx, accountId, value);
    const description = partDescription(rule, part);
    const billData = { description, amount: value, category: rule.category ?? "Moradia", accountId: recordExpense ? accountId : rule.accountId, dueDate: existing?.dueDate ?? dueDateFor(rule, month), recurringRuleId: rule.id, cycleMonth: month, part, status: "paid", paidAt: occurredAt, source: "manual", confidence: "CONFIRMED" };
    const bill = existing ? await tx.bill.update({ where: { id: existing.id }, data: billData }) : await tx.bill.create({ data: billData });
    let expense = null;
    if (recordExpense) {
      expense = await tx.expense.create({ data: { amount: value, description, category: rule.category ?? "Moradia", accountId, billId: bill.id, source: "manual", confidence: "CONFIRMED", rawMessage: `pay-house-bill:${rule.id}:${month}:${part}`, occurredAt } });
    }
    await tx.telegramCorrectionAudit.create({
      data: { model: "bill", recordId: bill.id, action: "pay_house_bill", preimage: existing ? serializeRecord(existing) : {}, fieldChanges: { ruleId: rule.id, cycleMonth: month, part, amount: serializeMoney(value).toString(), expenseId: expense?.id ?? null, recordExpense }, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: "web" },
    });
    return { bill, expense, rule };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}

export async function undoHouseBillPayment(billId, { expectedUpdatedAt } = {}, { client = prisma } = {}) {
  const run = async (tx) => {
    const bill = await tx.bill.findUnique({ where: { id: billId }, include: { expense: true } });
    if (!bill) throw new DomainError("NOT_FOUND", "Conta não encontrada.");
    if (bill.status !== "paid") throw new DomainError("NOT_PAID", "Esta conta não está paga — nada a desfazer.");
    if (expectedUpdatedAt && bill.updatedAt.toISOString() !== expectedUpdatedAt) throw new DomainError("STALE", "Esta conta mudou desde que você a viu. Atualize a página e confira antes de desfazer.");
    const expensePreimage = bill.expense ? serializeRecord(bill.expense) : null;
    if (bill.expense) await tx.expense.delete({ where: { id: bill.expense.id } });
    let result = null;
    if (bill.recurringRuleId) await tx.bill.delete({ where: { id: bill.id } }); // volta a ser só projetada (nunca fica Bill pendente fabricada)
    else result = await tx.bill.update({ where: { id: bill.id }, data: { status: "pending", paidAt: null } });
    await tx.telegramCorrectionAudit.create({
      data: { model: "bill", recordId: bill.id, action: "undo_pay_house_bill", preimage: serializeRecord({ ...bill, expense: undefined }), fieldChanges: { removedExpense: expensePreimage }, chatId: null, telegramUpdateId: null, undoesAuditId: null, rawMessage: "web" },
    });
    return { bill: result, ruleId: bill.recurringRuleId, cycleMonth: bill.cycleMonth, part: bill.part };
  };
  return client === prisma ? prisma.$transaction(run, { timeout: 20000 }) : run(client);
}

// ============================================================================
// Fase 9.1.2 — CONTAS DA CASA NO HORIZONTE FINANCEIRO (committed / freeMoney / safeToSpend / simulador /
// projeção / "antes da próxima renda"). Só LEITURA.
//
// COMPETÊNCIA != HORIZONTE.
//   * COMPETÊNCIA (cycleMonth) organiza: abas, histórico, agrupamento mensal.
//   * HORIZONTE FINANCEIRO decide se a obrigação reduz o dinheiro disponível AGORA:
//         dueDate <= próxima renda relevante  =>  obrigação do horizonte atual,
//     esteja ela na competência corrente ou em outra (aluguel de 05/10 conta em 25/09 se a próxima
//     renda é 24/10). Sem vencimento CONHECIDO só a competência corrente entra (o mês em curso precisa
//     ser coberto); nunca se inventa data para competências futuras.
//
// Demais regras:
//   * PENDING + valor conhecido  -> obrigação REAL (entra em "comprometido", reduz freeMoney);
//   * PAID                       -> nunca é obrigação (a Expense do pagamento já moveu o saldo);
//   * variável SEM valor         -> NÃO vira zero: sai em `unpriced` (a UI diz "aguardando valor");
//   * cada visita da faxina é uma obrigação própria (0/2 => R$260, 1/2 => R$130, 2/2 => R$0);
//   * `handled` = chaves regra:competência:parte (identidade semântica da ocorrência) já representadas
//     aqui — o caminho legado de Bill pendente as ignora (sem double count).
// ============================================================================
export function houseBillDescription(inst) {
  return inst.partsTotal > 1 ? `${inst.name} — visita ${inst.part}/${inst.partsTotal}` : inst.name;
}

export function monthKeyOfDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ["2026-09","2026-10",...] de startKey até endKey (inclusive), no máximo `cap` competências.
export function monthKeysBetween(startKey, endKey, cap = 5) {
  const out = [];
  let [y, m] = startKey.split("-").map(Number);
  while (out.length < cap) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > endKey) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out.length ? out : [startKey];
}

const toUnpriced = (inst, current) => ({
  key: inst.key,
  ruleId: inst.ruleId,
  name: houseBillDescription(inst),
  cycleMonth: inst.cycleMonth,
  part: inst.part,
  dueDate: inst.dueDate,
  beforeNextIncome: inst.cycleMonth !== current,
  referenceMin: inst.referenceMin,
  referenceMax: inst.referenceMax,
});

const toObligation = (inst, current) => ({
  type: "Bill",
  houseBill: true,
  id: inst.billId ?? inst.key,
  key: inst.key,
  ruleId: inst.ruleId,
  description: houseBillDescription(inst),
  amount: inst.partAmount,
  dueDate: inst.dueDate,
  cycleMonth: inst.cycleMonth,
  part: inst.part,
  partsTotal: inst.partsTotal,
  approximate: inst.amountKind === AMOUNT_KIND.APPROXIMATE,
  overdue: inst.overdue,
  // fora da competência corrente, mas vence antes da próxima renda (é isso que a UI rotula)
  beforeNextIncome: inst.cycleMonth !== current,
});

// Obrigações de contas da casa que SEQUESTRAM caixa até `horizonEnd` (a próxima renda efetiva).
// Sem `horizonEnd`: só a competência corrente (compatibilidade).
export async function getHouseBillObligations({ now = new Date(), horizonEnd, client = prisma } = {}) {
  const current = currentMonthKey(now);
  const endKey = horizonEnd ? monthKeyOfDate(horizonEnd) : current;
  const months = monthKeysBetween(current, endKey < current ? current : endKey);
  const instances = [];
  for (const cycleMonth of months) for (const inst of await listHouseBillInstances({ cycleMonth, now, client })) instances.push(inst);
  const handled = new Set(instances.map((i) => i.key));
  const items = [];
  const unpriced = [];
  for (const inst of instances) {
    if (inst.status !== "PENDING") continue; // PAID nunca é obrigação
    const inHorizon = horizonEnd == null
      ? inst.cycleMonth === current
      : inst.dueDate != null
        ? inst.dueDate <= horizonEnd // dueDate <= próxima renda => horizonte atual, em qualquer competência
        : inst.cycleMonth === current; // sem vencimento conhecido: só o mês em curso (nunca inventa data)
    if (!inHorizon) continue;
    if (inst.awaitingValue || inst.partAmount == null) unpriced.push(toUnpriced(inst, current));
    else items.push(toObligation(inst, current));
  }
  return { items, unpriced, handled, months, currentMonth: current };
}

// Chave de deduplicação de uma Bill persistida (mesma forma de `instance.key`).
export function billHouseKey(bill) {
  return bill?.recurringRuleId && bill.cycleMonth ? `${bill.recurringRuleId}:${bill.cycleMonth}:${bill.part ?? 1}` : null;
}
