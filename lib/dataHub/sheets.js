import { prisma } from "../prisma.js";
import { money, serializeMoney } from "../money.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — CATÁLOGO DE SHEETS do Data Hub.
//
// Fonte única de verdade sobre "o que existe pra exportar/importar" —
// export.js e a UI de /dados leem DAQUI, nunca reimplementam a lista.
// Auditado diretamente contra prisma/schema.prisma (nenhuma sheet pra model
// inexistente, nenhum campo inventado).
//
// GRUPOS:
//   raw      — registro econômico bruto, 1 linha = 1 row real do banco.
//   config   — configuração do usuário (não é fato financeiro reconstruído).
//   derived  — calculado pelo engine canônico no momento da exportação
//              (lib/productFinancialSnapshot.js e afins) — NUNCA a mesma
//              coisa que um registro de origem (item 27 do pedido: nunca
//              misturar RAW com DERIVED na mesma sheet).
//   meta     — manifesto/dicionário, sobre a própria exportação.
//
// NUNCA exportado (item 28 do pedido): PendingBotMessage, BotWizardSession,
// TelegramUpdateReceipt, LoginRateLimit, DataOperation, ImportBatch — infra
// de segurança/sistema/bot, não dado financeiro. Nenhuma dessas tabelas
// aparece neste arquivo, de propósito.
//
// IMPORTABLE: só datasets com adapter real em lib/dataHub/adapters/*.js
// (ver import/plan.js). Um dataset RAW sem `importable:true` é
// exclusivamente de leitura no Data Hub — a UI precisa refletir isso
// (item 38 do pedido: nunca oferecer um modo que não existe de verdade).
// ============================================================================

const PERIODS = {
  ALL: "all",
  LAST_12_MONTHS: "last12months",
  THIS_YEAR: "thisyear",
};

function periodRange(period, now = new Date()) {
  if (period === PERIODS.LAST_12_MONTHS) {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 12);
    return { gte: start };
  }
  if (period === PERIODS.THIS_YEAR) {
    return { gte: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)) };
  }
  return null; // "Todo o histórico" — sem filtro.
}

function m(v) {
  return v == null ? null : serializeMoney(money(v));
}

// --------------------------------------------------------------------------
// RAW — um sheet por model financeiro real.
// --------------------------------------------------------------------------
const RAW_SHEETS = [
  {
    key: "accounts",
    sheetName: "Contas",
    description: "contas reais (corrente, dinheiro, vale-alimentação)",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "slug", header: "Slug", type: "string" },
      { key: "name", header: "Nome", type: "string" },
      { key: "type", header: "Tipo", type: "string" },
      { key: "createdAt", header: "Criado em", type: "datetime" },
      { key: "updatedAt", header: "Atualizado em", type: "datetime" },
    ],
    async fetch() {
      const rows = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, type: r.type, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    },
  },
  {
    key: "cards",
    sheetName: "Cartões",
    description: "limites e configuração de ciclo",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "name", header: "Nome", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "totalLimit", header: "Limite total", type: "money" },
      { key: "closingDay", header: "Dia de fechamento", type: "int" },
      { key: "dueDay", header: "Dia de vencimento", type: "int" },
      { key: "createdAt", header: "Criado em", type: "datetime" },
    ],
    async fetch() {
      const rows = await prisma.card.findMany({ include: { account: true }, orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, name: r.name, accountName: r.account?.name ?? null, totalLimit: m(r.totalLimit), closingDay: r.closingDay, dueDay: r.dueDay, createdAt: r.createdAt }));
    },
  },
  {
    key: "incomes",
    sheetName: "Receitas",
    description: "toda entrada de dinheiro registrada",
    importable: true,
    modes: ["add", "update"],
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "isRecurring", header: "Recorrente", type: "boolean" },
      { key: "source", header: "Origem", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
      { key: "createdAt", header: "Criado em", type: "datetime" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.income.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { account: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, amount: m(r.amount), description: r.description, category: r.category, accountName: r.account?.name ?? null, isRecurring: r.isRecurring, source: r.source, confidence: r.confidence, occurredAt: r.occurredAt, createdAt: r.createdAt }));
    },
  },
  {
    key: "expenses",
    sheetName: "Despesas",
    description: "toda saída de dinheiro registrada",
    importable: true,
    modes: ["add", "update"],
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "cardName", header: "Cartão", type: "string" },
      { key: "isRecurring", header: "Recorrente", type: "boolean" },
      { key: "source", header: "Origem", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
      { key: "createdAt", header: "Criado em", type: "datetime" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.expense.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { account: true, card: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, amount: m(r.amount), description: r.description, category: r.category, accountName: r.account?.name ?? null, cardName: r.card?.name ?? null, isRecurring: r.isRecurring, source: r.source, confidence: r.confidence, occurredAt: r.occurredAt, createdAt: r.createdAt }));
    },
  },
  {
    key: "transfers",
    sheetName: "Transferências",
    description: "movimentos entre contas/cartões",
    importable: true,
    modes: ["add"],
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "fromAccountName", header: "Conta origem", type: "string" },
      { key: "toAccountName", header: "Conta destino", type: "string" },
      { key: "toCardName", header: "Cartão destino", type: "string" },
      { key: "kind", header: "Tipo", type: "string" },
      { key: "source", header: "Origem", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.transfer.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { fromAccount: true, toAccount: true, toCard: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, amount: m(r.amount), description: r.description, fromAccountName: r.fromAccount?.name ?? null, toAccountName: r.toAccount?.name ?? null, toCardName: r.toCard?.name ?? null, kind: r.kind, source: r.source, occurredAt: r.occurredAt }));
    },
  },
  {
    key: "balanceAdjustments",
    sheetName: "Ajustes de saldo",
    description: "âncoras de saldo de conta",
    importable: true,
    modes: ["add"],
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "newBalance", header: "Novo saldo", type: "money" },
      { key: "note", header: "Nota", type: "string" },
      { key: "source", header: "Origem", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.balanceAdjustment.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { account: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, accountName: r.account?.name ?? null, newBalance: m(r.newBalance), note: r.note, source: r.source, confidence: r.confidence, occurredAt: r.occurredAt }));
    },
  },
  {
    key: "cardLimitUpdates",
    sheetName: "Atualizações de limite",
    description: "âncoras de limite de cartão",
    importable: false,
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "cardName", header: "Cartão", type: "string" },
      { key: "newTotalLimit", header: "Novo limite total", type: "money" },
      { key: "newUsedLimit", header: "Novo limite usado", type: "money" },
      { key: "reportedAvailable", header: "Disponível informado", type: "money" },
      { key: "note", header: "Nota", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.cardLimitUpdate.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { card: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, cardName: r.card?.name ?? null, newTotalLimit: m(r.newTotalLimit), newUsedLimit: m(r.newUsedLimit), reportedAvailable: m(r.reportedAvailable), note: r.note, occurredAt: r.occurredAt }));
    },
  },
  {
    key: "purchases",
    sheetName: "Compras",
    description: "compras parceladas no cartão",
    importable: false,
    dateField: "purchasedAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "totalAmount", header: "Valor total", type: "money" },
      { key: "installmentCount", header: "Nº de parcelas", type: "int" },
      { key: "installmentValue", header: "Valor da parcela", type: "money" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "cardName", header: "Cartão", type: "string" },
      { key: "firstInstallmentMonth", header: "Mês da 1ª parcela", type: "string" },
      { key: "purchasedAt", header: "Data da compra", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.purchase.findMany({ where: periodRange(period) ? { purchasedAt: periodRange(period) } : undefined, include: { card: true }, orderBy: { purchasedAt: "desc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, totalAmount: m(r.totalAmount), installmentCount: r.installmentCount, installmentValue: m(r.installmentValue), category: r.category, cardName: r.card?.name ?? null, firstInstallmentMonth: r.firstInstallmentMonth, purchasedAt: r.purchasedAt }));
    },
  },
  {
    key: "installments",
    sheetName: "Parcelas",
    description: "parcelas individuais de compras no cartão",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "purchaseDescription", header: "Compra", type: "string" },
      { key: "number", header: "Nº", type: "int" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "billMonth", header: "Mês da fatura", type: "string" },
    ],
    async fetch() {
      const rows = await prisma.installment.findMany({ include: { purchase: true }, orderBy: [{ billMonth: "asc" }, { number: "asc" }] });
      return rows.map((r) => ({ id: r.id, purchaseDescription: r.purchase?.description ?? null, number: r.number, amount: m(r.amount), billMonth: r.billMonth }));
    },
  },
  {
    key: "cardBills",
    sheetName: "Faturas",
    description: "faturas de cartão, fechadas e abertas",
    importable: false,
    dateField: "dueAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "cardName", header: "Cartão", type: "string" },
      { key: "cycleMonth", header: "Ciclo", type: "string" },
      { key: "closesAt", header: "Fecha em", type: "date" },
      { key: "dueAt", header: "Vence em", type: "date" },
      { key: "totalAmount", header: "Valor total", type: "money" },
      { key: "status", header: "Status", type: "string" },
      { key: "paidAmount", header: "Valor pago", type: "money" },
      { key: "paidAt", header: "Pago em", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.cardBill.findMany({ where: periodRange(period) ? { dueAt: periodRange(period) } : undefined, include: { card: true }, orderBy: { dueAt: "desc" } });
      return rows.map((r) => ({ id: r.id, cardName: r.card?.name ?? null, cycleMonth: r.cycleMonth, closesAt: r.closesAt, dueAt: r.dueAt, totalAmount: m(r.totalAmount), status: r.status, paidAmount: m(r.paidAmount), paidAt: r.paidAt }));
    },
  },
  {
    key: "recurringRules",
    sheetName: "Regras recorrentes",
    description: "receitas e despesas que se repetem todo mês",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "name", header: "Nome", type: "string" },
      { key: "kind", header: "Tipo", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "dayOfMonth", header: "Dia do mês", type: "int" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "isActive", header: "Ativa", type: "boolean" },
    ],
    async fetch() {
      const rows = await prisma.recurringRule.findMany({ include: { account: true }, orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, amount: m(r.amount), dayOfMonth: r.dayOfMonth, accountName: r.account?.name ?? null, category: r.category, isActive: r.isActive }));
    },
  },
  {
    key: "bills",
    sheetName: "Contas a pagar",
    description: "contas avulsas, pendentes ou pagas",
    importable: true,
    modes: ["add", "update"],
    dateField: "dueDate",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "dueDate", header: "Vencimento", type: "date" },
      { key: "status", header: "Status", type: "string" },
      { key: "source", header: "Origem", type: "string" },
      { key: "paidAt", header: "Pago em", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.bill.findMany({ where: periodRange(period) ? { dueDate: periodRange(period) } : undefined, include: { account: true }, orderBy: { dueDate: "desc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, amount: m(r.amount), category: r.category, accountName: r.account?.name ?? null, dueDate: r.dueDate, status: r.status, source: r.source, paidAt: r.paidAt }));
    },
  },
  {
    key: "goals",
    sheetName: "Metas",
    description: "progresso e prazos",
    importable: true,
    modes: ["add", "update"],
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "name", header: "Nome", type: "string" },
      { key: "targetAmount", header: "Valor alvo", type: "money" },
      { key: "savedAmount", header: "Valor guardado", type: "money" },
      { key: "targetDate", header: "Data alvo", type: "date" },
      { key: "notes", header: "Notas", type: "string" },
      { key: "isActive", header: "Ativa", type: "boolean" },
    ],
    async fetch() {
      const rows = await prisma.goal.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, name: r.name, targetAmount: m(r.targetAmount), savedAmount: m(r.savedAmount), targetDate: r.targetDate, notes: r.notes, isActive: r.isActive }));
    },
  },
  {
    key: "reserves",
    sheetName: "Reservas",
    description: "dinheiro protegido dentro de uma conta",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "name", header: "Nome", type: "string" },
      { key: "accountName", header: "Conta", type: "string" },
      { key: "targetAmount", header: "Valor alvo", type: "money" },
      { key: "isActive", header: "Ativa", type: "boolean" },
    ],
    async fetch() {
      const rows = await prisma.reserve.findMany({ include: { account: true }, orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, name: r.name, accountName: r.account?.name ?? null, targetAmount: m(r.targetAmount), isActive: r.isActive }));
    },
  },
  {
    key: "reserveMovements",
    sheetName: "Movimentos de reserva",
    description: "entradas e saídas de cada reserva",
    importable: false,
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "reserveName", header: "Reserva", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "kind", header: "Tipo", type: "string" },
      { key: "note", header: "Nota", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.reserveMovement.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { reserve: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, reserveName: r.reserve?.name ?? null, amount: m(r.amount), kind: r.kind, note: r.note, occurredAt: r.occurredAt }));
    },
  },
  {
    key: "externalInstallmentPlans",
    sheetName: "Planos de parcela externa",
    description: "dívidas fora do cartão (com pessoas/lojas)",
    importable: false,
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "creditor", header: "Credor", type: "string" },
      { key: "installmentValue", header: "Valor da parcela", type: "money" },
      { key: "installmentCount", header: "Nº de parcelas", type: "int" },
      { key: "firstDueDate", header: "1º vencimento", type: "date" },
      { key: "dueTiming", header: "Timing", type: "string" },
      { key: "status", header: "Status", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
    ],
    async fetch() {
      const rows = await prisma.externalInstallmentPlan.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, creditor: r.creditor, installmentValue: m(r.installmentValue), installmentCount: r.installmentCount, firstDueDate: r.firstDueDate, dueTiming: r.dueTiming, status: r.status, confidence: r.confidence }));
    },
  },
  {
    key: "externalInstallments",
    sheetName: "Parcelas externas",
    description: "parcelas individuais dos planos externos",
    importable: false,
    dateField: "dueDate",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "planDescription", header: "Plano", type: "string" },
      { key: "number", header: "Nº", type: "int" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "dueDate", header: "Vencimento", type: "date" },
      { key: "status", header: "Status", type: "string" },
      { key: "paidAt", header: "Pago em", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.externalInstallment.findMany({ where: periodRange(period) ? { dueDate: periodRange(period) } : undefined, include: { plan: true }, orderBy: [{ planId: "asc" }, { number: "asc" }] });
      return rows.map((r) => ({ id: r.id, planDescription: r.plan?.description ?? null, number: r.number, amount: m(r.amount), dueDate: r.dueDate, status: r.status, paidAt: r.paidAt }));
    },
  },
  {
    key: "confirmedCommitments",
    sheetName: "Compromissos confirmados",
    description: "obrigações reais sem origem de pagamento definida",
    importable: true,
    modes: ["add", "update"],
    dateField: "dueDate",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "dueDate", header: "Vencimento", type: "date" },
      { key: "status", header: "Status", type: "string" },
      { key: "notes", header: "Notas", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.confirmedCommitment.findMany({ where: periodRange(period) ? { dueDate: periodRange(period) } : undefined, orderBy: { dueDate: "desc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, amount: m(r.amount), dueDate: r.dueDate, status: r.status, notes: r.notes, confidence: r.confidence }));
    },
  },
  {
    key: "contingencies",
    sheetName: "Contingências",
    description: "risco/possível gasto futuro — nunca entra em dinheiro livre",
    importable: true,
    modes: ["add", "update"],
    dateField: null,
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "expectedAmount", header: "Valor esperado", type: "money" },
      { key: "maxAmount", header: "Valor máximo", type: "money" },
      { key: "expectedDate", header: "Data esperada", type: "date" },
      { key: "status", header: "Status", type: "string" },
      { key: "notes", header: "Notas", type: "string" },
      { key: "confidence", header: "Confiança", type: "string" },
    ],
    async fetch() {
      const rows = await prisma.contingency.findMany({ orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, expectedAmount: m(r.expectedAmount), maxAmount: m(r.maxAmount), expectedDate: r.expectedDate, status: r.status, notes: r.notes, confidence: r.confidence }));
    },
  },
  {
    key: "receivables",
    sheetName: "Valores a receber",
    description: "dinheiro a receber — nunca contado como recebido só pela data",
    importable: true,
    modes: ["add", "update"],
    dateField: "expectedDate",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "counterparty", header: "De quem", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "expectedDate", header: "Data esperada", type: "date" },
      { key: "status", header: "Status", type: "string" },
      { key: "notes", header: "Notas", type: "string" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.receivable.findMany({ where: periodRange(period) ? { expectedDate: periodRange(period) } : undefined, orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ id: r.id, description: r.description, counterparty: r.counterparty, amount: m(r.amount), expectedDate: r.expectedDate, status: r.status, notes: r.notes }));
    },
  },
  {
    key: "categoryBudgets",
    sheetName: "Orçamento por categoria",
    description: "intenção de gasto por ciclo e categoria",
    importable: true,
    modes: ["add", "update"],
    dateField: "cycleStart",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "cycleStart", header: "Início do ciclo", type: "date" },
      { key: "amount", header: "Valor orçado", type: "money" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.categoryBudget.findMany({ where: periodRange(period) ? { cycleStart: periodRange(period) } : undefined, orderBy: { cycleStart: "desc" } });
      return rows.map((r) => ({ id: r.id, category: r.category, cycleStart: r.cycleStart, amount: m(r.amount) }));
    },
  },
  {
    key: "cardCreditMovements",
    sheetName: "Movimentos de crédito do cartão",
    description: "saldo credor do cartão (não da fatura)",
    importable: false,
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "cardName", header: "Cartão", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "kind", header: "Tipo", type: "string" },
      { key: "note", header: "Nota", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.cardCreditMovement.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, include: { card: true }, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, cardName: r.card?.name ?? null, amount: m(r.amount), kind: r.kind, note: r.note, occurredAt: r.occurredAt }));
    },
  },
  {
    key: "appSettings",
    sheetName: "Configurações",
    description: "ciclo financeiro e margens — só campos não-sensíveis",
    importable: false,
    dateField: null,
    columns: [
      { key: "cycleStartDay", header: "Início do ciclo (dia)", type: "int" },
      { key: "safetyMarginPercent", header: "Margem de segurança (%)", type: "int" },
      { key: "operationalHistoryStart", header: "Início do histórico operacional", type: "date" },
      { key: "vaHistoryStart", header: "Início do histórico de VA", type: "date" },
    ],
    async fetch() {
      const r = await prisma.appSettings.findUnique({ where: { id: "default" } });
      if (!r) return [];
      // Item 28 do pedido — nenhum campo de secret/senha existe neste model,
      // mas listamos explicitamente os 4 campos exportáveis em vez de um
      // spread, pra nunca vazar um campo novo por acidente se o schema
      // crescer no futuro.
      return [{ cycleStartDay: r.cycleStartDay, safetyMarginPercent: r.safetyMarginPercent, operationalHistoryStart: r.operationalHistoryStart, vaHistoryStart: r.vaHistoryStart }];
    },
  },
  {
    key: "legacyTransactions",
    sheetName: "Histórico legado",
    description: "arquivo congelado, migrado — a app não escreve mais aqui",
    importable: false,
    dateField: "occurredAt",
    columns: [
      { key: "id", header: "ID", type: "string" },
      { key: "type", header: "Tipo", type: "string" },
      { key: "amount", header: "Valor", type: "money" },
      { key: "category", header: "Categoria", type: "string" },
      { key: "paymentMethod", header: "Forma de pagamento", type: "string" },
      { key: "description", header: "Descrição", type: "string" },
      { key: "occurredAt", header: "Data", type: "date" },
    ],
    async fetch({ period } = {}) {
      const rows = await prisma.legacyTransaction.findMany({ where: periodRange(period) ? { occurredAt: periodRange(period) } : undefined, orderBy: { occurredAt: "desc" } });
      return rows.map((r) => ({ id: r.id, type: r.type, amount: r.amount, category: r.category, paymentMethod: r.paymentMethod, description: r.description, occurredAt: r.occurredAt }));
    },
  },
];

export { PERIODS, periodRange };
export default RAW_SHEETS;
