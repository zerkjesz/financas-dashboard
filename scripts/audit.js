// ============================================================================
// scripts/audit.js — READ-ONLY, do início ao fim. Regra oficial (Norte v2):
//
// Este script NUNCA pode chamar uma função com semântica de getOrCreate/create/
// update/delete/upsert, nem qualquer mutation de qualquer tipo — nem sequer uma
// escrita idempotente (mesmo valor regravado). Só SELECT/aggregate/count.
//
// Motivo: este script é seguro por design pra rodar até contra produção (não
// precisa de assertTestEnvironment() — ver docs/dev-environment.md). Essa
// garantia só existe se ele for, de fato, 100% leitura. Se algum dia precisar
// adicionar uma checagem nova, ela tem que usar só find/aggregate/count — se a
// lógica que você precisa checar estiver hoje acoplada a uma função que também
// escreve (como getOrCreateBill em lib/cardBillCalculator.js), extraia a parte
// pura de cálculo pra sua própria função exportada (ver
// computeExpectedCardBillTotal, extraída exatamente por esse motivo) e chame só
// essa parte aqui.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { buildVaSnapshot } from "../lib/vaPanel.js";
// Fase 3.3 — getReserveBalance/getCardCreditBalance são puramente leitura (só
// agregam ReserveMovement/CardCreditMovement já existentes, nunca escrevem).
import { getReserveBalance } from "../lib/reserves.js";
// Fase 4.1 — getObligationsBreakdown é puramente leitura (só classifica dado já
// existente, nunca escreve — mesma garantia de computeExpectedCardBillTotal acima).
import { getObligationsBreakdown, resolveCurrentRelevantCardBillId } from "../lib/freeMoney.js";
import { getCardCreditBalance } from "../lib/cardCredit.js";
// Decimal-first (Fase 3.1, Etapa 13): todo campo monetário lido do Prisma agora é
// Decimal (Prisma.Decimal/decimal.js) — nunca `+`/`-`/`Math.abs()` nativos nele (viram
// NaN/concatenação de string silenciosa, não um erro). Este script continua 100%
// leitura — só troca a aritmética por lib/money.js.
import { money, addMoney, subtractMoney } from "../lib/money.js";

const prisma = new PrismaClient();
const problems = [];

function check(label, ok, detail) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) problems.push(label);
}

// Recomputo independente do lib/accounts.js, só pra cruzar os dois caminhos.
async function rawAccountBalance(accountId) {
  const anchor = await prisma.balanceAdjustment.findFirst({ where: { accountId }, orderBy: { occurredAt: "desc" } });
  const since = anchor?.occurredAt ?? new Date(0);
  const base = money(anchor?.newBalance);
  const [inc, exp, tOut, tIn] = await Promise.all([
    prisma.income.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { fromAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
    prisma.transfer.aggregate({ where: { toAccountId: accountId, occurredAt: { gt: since } }, _sum: { amount: true } }),
  ]);
  let balance = base;
  balance = addMoney(balance, inc._sum.amount);
  balance = subtractMoney(balance, exp._sum.amount);
  balance = addMoney(balance, tIn._sum.amount);
  balance = subtractMoney(balance, tOut._sum.amount);
  return balance;
}

async function auditAccountBalances() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const balance = await rawAccountBalance(account.id);
    check(`Saldo de "${account.name}" é finito e >= -0.01`, balance.isFinite() && balance.gte(-0.01), `R$ ${balance.toFixed(2)}`);
  }
}

// Saldo real (lib/accounts.js) precisa bater exatamente com o recompute independente
// (rawAccountBalance, acima) — os dois usam a MESMA fórmula (âncora + movimento real).
// Se algum dia alguém reintroduzir receita recorrente virtual na fórmula de saldo real
// (removida na Fase 1.1), essa checagem diverge e pega o regresso.
async function auditNoVirtualCreditInBalance() {
  const accounts = await prisma.account.findMany();
  for (const account of accounts) {
    const [real, raw] = await Promise.all([computeAccountBalance(account.id), rawAccountBalance(account.id)]);
    check(
      `Saldo real de "${account.name}" não inclui receita recorrente virtual`,
      subtractMoney(real, raw).abs().lt(0.01),
      `computeAccountBalance=R$ ${real.toFixed(2)}, recompute independente=R$ ${raw.toFixed(2)}`
    );
  }
}

// O painel de VA (buildVaSnapshot) não pode ter uma segunda fonte de verdade pro saldo
// — tem que bater exatamente com computeAccountBalance da Account correspondente (era
// o bug corrigido na Fase 1.2: vaPanel.js tinha seu próprio cálculo, que ainda somava
// recarga futura ao saldo mostrado).
async function auditVaSnapshotMatchesAccountBalance() {
  const account = await prisma.account.findUnique({ where: { slug: "vale-alimentacao" } });
  if (!account) {
    check("Conta de Vale Alimentação existe pra checar o painel", false, "conta não encontrada");
    return;
  }
  const [snapshot, realBalance] = await Promise.all([buildVaSnapshot(), computeAccountBalance(account.id)]);
  check(
    "Saldo do painel de VA (buildVaSnapshot) bate com o saldo real da Account",
    snapshot != null && subtractMoney(snapshot.balance, realBalance).abs().lt(0.01),
    `painel=R$ ${snapshot?.balance?.toFixed(2)}, Account real=R$ ${realBalance.toFixed(2)}`
  );
}

// Recomputa o total esperado de cada fatura em aberto usando só
// computeExpectedCardBillTotal (lib/cardBillCalculator.js) — uma função pura de
// leitura (aggregate), extraída de getOrCreateBill() especificamente pra isto.
// NUNCA chama getOrCreateBill() aqui — essa função pode fazer create/update.
async function auditCardBills() {
  const openBills = await prisma.cardBill.findMany({ where: { status: { in: ["open", "partially_paid"] } } });
  const cardsById = new Map();
  for (const bill of openBills) {
    let card = cardsById.get(bill.cardId);
    if (!card) {
      card = await prisma.card.findUnique({ where: { id: bill.cardId } });
      cardsById.set(bill.cardId, card);
    }
    const expected = await computeExpectedCardBillTotal(card, bill.cycleMonth);
    check(
      `CardBill ${bill.cycleMonth} bate com o recomputo (read-only)`,
      subtractMoney(bill.totalAmount, expected).abs().lt(0.01),
      `armazenado R$ ${bill.totalAmount.toFixed(2)}, esperado R$ ${expected.toFixed(2)}`
    );
  }
}

// Status derivado tem que bater com paidAmount vs totalAmount — pega qualquer fatura
// que ficou "paid" com pagamento parcial (bug corrigido na Fase 1, checa se sobrou
// dado antigo pra reconciliar) ou "partially_paid"/"open"/"closed" com paidAmount que
// já devia ter fechado como "paid".
async function auditCardBillStatus() {
  const bills = await prisma.cardBill.findMany();
  for (const bill of bills) {
    const paid = money(bill.paidAmount);
    const total = money(bill.totalAmount);
    const isPaidInFull = paid.gte(subtractMoney(total, 0.01)) && paid.gt(0);
    const expectedStatus =
      isPaidInFull
        ? "paid"
        : paid.gt(0)
          ? "partially_paid"
          : bill.status === "open" || bill.status === "closed"
            ? bill.status
            : null; // paidAmount 0 mas status "paid"/"partially_paid" também é inconsistente
    check(
      `CardBill ${bill.cardId}/${bill.cycleMonth} status bate com paidAmount`,
      expectedStatus === null ? bill.status !== "paid" && bill.status !== "partially_paid" : bill.status === expectedStatus,
      `status=${bill.status}, paidAmount=${paid.toFixed(2)}, totalAmount=${total.toFixed(2)}`
    );
  }
}

// Antecipação sem fromAccountId é o bug P0-1 da auditoria (dinheiro contado duas
// vezes) — depois da Fase 1, toda antecipação NOVA sempre tem fromAccountId; esta
// checagem existe pra pegar histórico ainda não reconciliado (Fase 4).
async function auditAnticipations() {
  const orphanAnticipations = await prisma.transfer.count({
    where: { kind: "installment_anticipation", fromAccountId: null },
  });
  check(
    "Nenhuma antecipação de fatura sem conta de origem (fromAccountId)",
    orphanAnticipations === 0,
    `${orphanAnticipations} encontrada(s) — reconciliação histórica pendente (Fase 4 da auditoria)`
  );
}

async function auditMigrationSums() {
  const legacyRows = await prisma.legacyTransaction.findMany();
  // LegacyTransaction.amount é Float de propósito (tabela congelada, fora do escopo
  // dos 17 campos convertidos — ver docs/phase3-money-audit.md) — soma via money.js
  // do mesmo jeito, só pra comparar com o lado Decimal sem gambiarra de tipo.
  const legacyByType = legacyRows.reduce((acc, r) => {
    acc[r.type] = addMoney(acc[r.type] || 0, r.amount);
    return acc;
  }, {});
  const [incomeSum, expenseSum] = await Promise.all([
    prisma.income.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { source: "migration" }, _sum: { amount: true } }),
  ]);
  check(
    "Soma de Income migrado bate com transaction_legacy",
    subtractMoney(legacyByType.income || 0, incomeSum._sum.amount || 0).abs().lt(0.01)
  );
  check(
    "Soma de Expense migrado bate com transaction_legacy",
    subtractMoney(legacyByType.expense || 0, expenseSum._sum.amount || 0).abs().lt(0.01)
  );
}

async function auditOrphans() {
  const orphanExpenses = await prisma.expense.count({ where: { accountId: null, cardId: null } });
  check("Nenhuma Expense órfã (sem conta nem cartão)", orphanExpenses === 0, `${orphanExpenses} encontrada(s)`);

  const orphanBillRules = await prisma.bill.count({
    where: { recurringRuleId: { not: null }, recurringRule: { is: null } },
  });
  check("Nenhuma Bill com recurringRuleId inválido", orphanBillRules === 0, `${orphanBillRules} encontrada(s)`);

  const inactiveRuleBills = await prisma.bill.findMany({
    where: { status: { in: ["pending", "overdue"] }, recurringRuleId: { not: null }, recurringRule: { isActive: false } },
  });
  check("Nenhuma Bill pendente presa a RecurringRule inativa", inactiveRuleBills.length === 0, `${inactiveRuleBills.length} encontrada(s)`);
}

// Fase 3.2 — AppSettings é singleton por construção (id fixo "default" + PK), mas
// alguém poderia criar uma segunda linha com outro id explícito; esta checagem
// confirma por evidência (count real), não por confiar na constraint sozinha.
async function auditAppSettingsSingleton() {
  const rows = await prisma.appSettings.findMany();
  check("Existe exatamente um AppSettings", rows.length === 1, `${rows.length} encontrado(s)`);
  if (rows.length === 0) return;

  const s = rows[0];
  check(`AppSettings.id === "default"`, s.id === "default", s.id);
  check(
    "AppSettings.cycleStartDay é um dia de mês válido (1-31)",
    Number.isInteger(s.cycleStartDay) && s.cycleStartDay >= 1 && s.cycleStartDay <= 31,
    String(s.cycleStartDay)
  );
  check(
    "AppSettings.safetyMarginPercent é um percentual não-negativo (Int, não Decimal — não é dinheiro)",
    Number.isInteger(s.safetyMarginPercent) && s.safetyMarginPercent >= 0,
    String(s.safetyMarginPercent)
  );
  check(
    "AppSettings.operationalHistoryStart é uma data válida",
    s.operationalHistoryStart instanceof Date && !Number.isNaN(s.operationalHistoryStart.getTime()),
    s.operationalHistoryStart?.toISOString?.()
  );
  check(
    "AppSettings.vaHistoryStart é uma data válida",
    s.vaHistoryStart instanceof Date && !Number.isNaN(s.vaHistoryStart.getTime()),
    s.vaHistoryStart?.toISOString?.()
  );
}

// Fase 3.2 — confirma por introspecção real do schema (não por suposição) que
// `confidence` só existe nos 7 models aprovados e NÃO foi adicionado aos models
// explicitamente excluídos (CardBill, Installment, RecurringRule, LegacyTransaction)
// nem a nenhum outro model — pega uma regressão de escopo se alguém adicionar o
// campo em outro lugar sem essa checagem ser atualizada de propósito.
async function auditDataConfidenceScope() {
  // Fase 3.2: Income, Expense, Transfer, BalanceAdjustment, CardLimitUpdate,
  // Purchase, Bill. Fase 3.3: + ReserveMovement, ExternalInstallmentPlan,
  // ConfirmedCommitment, Contingency, Receivable, CardCreditMovement. Fora de
  // propósito: Reserve (metadata, o fato está no movement), ExternalInstallment
  // (herda semanticamente do Plan), CategoryBudget (config/intenção, não fato),
  // RecurringRule (regra futura, não fato reconstruído), CardBill/Installment/
  // LegacyTransaction (derivados/deterministicos/congelados).
  const EXPECTED_WITH_CONFIDENCE = new Set([
    "Income", "Expense", "Transfer", "BalanceAdjustment", "CardLimitUpdate", "Purchase", "Bill",
    "ReserveMovement", "ExternalInstallmentPlan", "ConfirmedCommitment", "Contingency", "Receivable", "CardCreditMovement",
  ]);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name::text AS table_name FROM information_schema.columns WHERE column_name = 'confidence' AND table_schema = 'public'`
  );
  const actualWithConfidence = new Set(rows.map((r) => r.table_name));
  const missing = [...EXPECTED_WITH_CONFIDENCE].filter((m) => !actualWithConfidence.has(m));
  const unexpected = [...actualWithConfidence].filter((m) => !EXPECTED_WITH_CONFIDENCE.has(m));
  check(
    `Coluna \`confidence\` existe exatamente nos ${EXPECTED_WITH_CONFIDENCE.size} models aprovados (nenhum a mais, nenhum a menos)`,
    missing.length === 0 && unexpected.length === 0,
    `faltando=${JSON.stringify(missing)}, inesperado=${JSON.stringify(unexpected)}`
  );

  // Redundante com a garantia do tipo enum do Postgres (um valor fora da lista nem
  // consegue ser gravado), mas confirmado por evidência de dado real mesmo assim —
  // mesmo espírito do resto deste script (nunca assumir, sempre checar).
  const ALLOWED = new Set(["CONFIRMED", "CONFIRMED_BY_MEMORY", "ESTIMATED", "UNCERTAIN", "RECONCILIATION_ADJUSTMENT"]);
  const distinctValues = await Promise.all(
    [...EXPECTED_WITH_CONFIDENCE].map(async (model) => {
      const accessor = model.charAt(0).toLowerCase() + model.slice(1);
      const distinct = await prisma[accessor].findMany({ distinct: ["confidence"], select: { confidence: true } });
      return { model, values: distinct.map((d) => d.confidence).filter((v) => v != null) };
    })
  );
  const invalid = distinctValues.flatMap(({ model, values }) => values.filter((v) => !ALLOWED.has(v)).map((v) => `${model}:${v}`));
  check("Nenhum valor de confidence fora do enum permitido em nenhum dos 7 models", invalid.length === 0, invalid.join(", "));
}

// Fase 3.3 — Domain Models V2. Todas as checagens abaixo são só find/aggregate/
// count, nunca escrevem (getReserveBalance/getCardCreditBalance também são
// puramente leitura — ver import no topo do arquivo).

async function auditReserveBalances() {
  const reserves = await prisma.reserve.findMany({ where: { isActive: true } });
  for (const reserve of reserves) {
    const balance = await getReserveBalance(reserve.id);
    check(
      `Reserve "${reserve.name}" tem saldo não-negativo`,
      balance.gte(0),
      `R$ ${balance.toFixed(2)}`
    );
  }
}

async function auditPositiveLedgerAmounts() {
  // Redundante com o CHECK do banco (amount > 0), mas confirmado por evidência de
  // dado real mesmo assim — mesmo espírito do resto deste script.
  const [reserveMovements, cardCreditMovements, externalInstallments, commitments, receivables, contingencies] = await Promise.all([
    prisma.reserveMovement.count({ where: { amount: { lte: 0 } } }),
    prisma.cardCreditMovement.count({ where: { amount: { lte: 0 } } }),
    prisma.externalInstallment.count({ where: { amount: { lte: 0 } } }),
    prisma.confirmedCommitment.count({ where: { amount: { lte: 0 } } }),
    prisma.receivable.count({ where: { amount: { lte: 0 } } }),
    prisma.contingency.count({ where: { maxAmount: { lte: 0 } } }),
  ]);
  check("Nenhum ReserveMovement.amount <= 0", reserveMovements === 0, `${reserveMovements} encontrado(s)`);
  check("Nenhum CardCreditMovement.amount <= 0", cardCreditMovements === 0, `${cardCreditMovements} encontrado(s)`);
  check("Nenhum ExternalInstallment.amount <= 0", externalInstallments === 0, `${externalInstallments} encontrado(s)`);
  check("Nenhum ConfirmedCommitment.amount <= 0", commitments === 0, `${commitments} encontrado(s)`);
  check("Nenhum Receivable.amount <= 0", receivables === 0, `${receivables} encontrado(s)`);
  check("Nenhuma Contingency.maxAmount <= 0", contingencies === 0, `${contingencies} encontrado(s)`);
}

async function auditExternalInstallmentNumbers() {
  const plans = await prisma.externalInstallmentPlan.findMany({ include: { installments: true } });
  for (const plan of plans) {
    const numbers = plan.installments.map((i) => i.number).sort((a, b) => a - b);
    const expected = Array.from({ length: plan.installmentCount }, (_, i) => i + 1);
    check(
      `ExternalInstallmentPlan "${plan.description}" tem números de parcela 1..${plan.installmentCount} sem lacuna/duplicata`,
      JSON.stringify(numbers) === JSON.stringify(expected),
      `esperado ${JSON.stringify(expected)}, achado ${JSON.stringify(numbers)}`
    );
  }
}

async function auditSettledCommitments() {
  const settled = await prisma.confirmedCommitment.findMany({ where: { status: "SETTLED" }, include: { expense: true } });
  for (const c of settled) {
    check(
      `ConfirmedCommitment "${c.description}" (SETTLED) tem expenseId + settledAt + Expense real`,
      c.expenseId != null && c.settledAt != null && c.expense != null,
      `expenseId=${c.expenseId}, settledAt=${c.settledAt}, expense existe=${c.expense != null}`
    );
  }

  const expenseIds = settled.map((c) => c.expenseId).filter(Boolean);
  const uniqueExpenseIds = new Set(expenseIds);
  check(
    "Nenhum Expense vinculado a mais de um ConfirmedCommitment settled (vínculo duplicado)",
    expenseIds.length === uniqueExpenseIds.size,
    `${expenseIds.length} vínculos, ${uniqueExpenseIds.size} únicos`
  );
}

async function auditReceivedReceivables() {
  const received = await prisma.receivable.findMany({ where: { status: "RECEIVED" }, include: { income: true } });
  for (const r of received) {
    check(
      `Receivable "${r.description}" (RECEIVED) tem incomeId + Income real`,
      r.incomeId != null && r.income != null,
      `incomeId=${r.incomeId}, income existe=${r.income != null}`
    );
  }

  const incomeIds = received.map((r) => r.incomeId).filter(Boolean);
  const uniqueIncomeIds = new Set(incomeIds);
  check(
    "Nenhum Income vinculado a mais de um Receivable recebido (vínculo duplicado)",
    incomeIds.length === uniqueIncomeIds.size,
    `${incomeIds.length} vínculos, ${uniqueIncomeIds.size} únicos`
  );
}

async function auditContingencyBounds() {
  const contingencies = await prisma.contingency.findMany({ where: { expectedAmount: { not: null } } });
  for (const c of contingencies) {
    const expected = c.expectedAmount;
    check(
      `Contingency "${c.description}": expectedAmount dentro de [0, maxAmount]`,
      expected.gte(0) && expected.lte(c.maxAmount),
      `expected=${expected.toFixed(2)}, max=${c.maxAmount.toFixed(2)}`
    );
  }
}

async function auditCardCreditBalances() {
  const cards = await prisma.card.findMany();
  for (const card of cards) {
    const hasMovements = (await prisma.cardCreditMovement.count({ where: { cardId: card.id } })) > 0;
    if (!hasMovements) continue;
    const balance = await getCardCreditBalance(card.id);
    check(`Saldo credor do cartão "${card.name}" é não-negativo`, balance.gte(0), `R$ ${balance.toFixed(2)}`);
  }
}

async function auditExternalInstallmentExpenseLinks() {
  const paid = await prisma.externalInstallment.findMany({ where: { status: "PAID", expenseId: { not: null } } });
  const expenseIds = paid.map((i) => i.expenseId);
  const uniqueExpenseIds = new Set(expenseIds);
  check(
    "Nenhum Expense vinculado a mais de uma ExternalInstallment (vínculo duplicado)",
    expenseIds.length === uniqueExpenseIds.size,
    `${expenseIds.length} vínculos, ${uniqueExpenseIds.size} únicos`
  );
}

// Fase 4.0 — Ciclos + Obligation Classification. Todas read-only.

async function auditCardCycleConfig() {
  const cards = await prisma.card.findMany();
  for (const card of cards) {
    const dueDayValid = Number.isInteger(card.dueDay) && card.dueDay >= 1 && card.dueDay <= 31;
    check(`Card "${card.name}": dueDay válido (1-31)`, dueDayValid, String(card.dueDay));
    if (card.closingDay != null) {
      const closingDayValid = Number.isInteger(card.closingDay) && card.closingDay >= 1 && card.closingDay <= 31;
      check(`Card "${card.name}": closingDay válido (1-31) quando presente`, closingDayValid, String(card.closingDay));
    }
  }
}

// Formaliza por evidência que nenhuma segunda fonte de verdade sobre "o plano
// está completo" foi introduzida — ExternalInstallmentPlan.status só tem
// ACTIVE/CANCELLED (nunca um "COMPLETED" manual, ver schema.prisma); a
// completude é sempre derivada das installments (lib/externalInstallments.js:
// computePlanProgress). Esta checagem confirma que todo status armazenado
// continua dentro desse conjunto restrito, pra qualquer regressão futura
// (alguém adicionando um valor novo ao enum) ser pega aqui.
async function auditExternalInstallmentPlanCompleteness() {
  const plans = await prisma.externalInstallmentPlan.findMany({ include: { installments: true } });
  const ALLOWED_STATUS = new Set(["ACTIVE", "CANCELLED"]);
  for (const plan of plans) {
    check(`ExternalInstallmentPlan "${plan.description}": status dentro do conjunto restrito (ACTIVE/CANCELLED, nunca um "COMPLETED" manual)`, ALLOWED_STATUS.has(plan.status), plan.status);
    const paidCount = plan.installments.filter((i) => i.status === "PAID").length;
    const isFullyPaid = plan.installments.length > 0 && paidCount === plan.installments.length;
    if (isFullyPaid) {
      check(`ExternalInstallmentPlan "${plan.description}": totalmente pago, completude é derivada (nenhum campo próprio pra contradizer)`, true, `${paidCount}/${plan.installments.length}`);
    }
  }
}

async function auditCommitmentFunding() {
  const commitments = await prisma.confirmedCommitment.findMany();
  for (const c of commitments) {
    if (c.status === "FUNDED") {
      check(
        `ConfirmedCommitment "${c.description}" (FUNDED) tem fundingAccountId OU fundingReserveId (não nenhum dos dois)`,
        c.fundingAccountId != null || c.fundingReserveId != null,
        `fundingAccountId=${c.fundingAccountId}, fundingReserveId=${c.fundingReserveId}`
      );
      check(`ConfirmedCommitment "${c.description}" (FUNDED) tem fundedAt`, c.fundedAt != null);
    }
    // Proibido: as duas origens de funding simultaneamente — um commitment é
    // fundado por UMA fonte, nunca duas ao mesmo tempo (estruturalmente já
    // impedido pelos services, que só transicionam CONFIRMED->FUNDED setando um
    // dos dois — esta checagem é a evidência de que isso se sustenta no dado real).
    check(
      `ConfirmedCommitment "${c.description}": nunca fundingAccountId e fundingReserveId simultâneos`,
      !(c.fundingAccountId != null && c.fundingReserveId != null)
    );
  }
}

// Datas/ciclos obviamente inválidos — evidência contra regressão do bug original
// (computeDueAt somando um mês a mais quando closingDay estava presente).
async function auditCardBillDateSanity() {
  const bills = await prisma.cardBill.findMany();
  for (const bill of bills) {
    check(
      `CardBill ${bill.cardId}/${bill.cycleMonth}: dueAt não é anterior a closesAt`,
      bill.dueAt.getTime() >= bill.closesAt.getTime(),
      `closesAt=${bill.closesAt.toISOString()}, dueAt=${bill.dueAt.toISOString()}`
    );
  }
}

// Fase 4.0.2 — vínculo Income <-> RecurringRule por recurringOccurrenceDate.
async function auditRecurringIncomeOccurrences() {
  const withOccurrenceDate = await prisma.income.findMany({
    where: { recurringOccurrenceDate: { not: null } },
    include: { recurringRule: true },
  });
  for (const income of withOccurrenceDate) {
    check(
      `Income ${income.id}: recurringOccurrenceDate não-nulo tem recurringRuleId não-nulo`,
      income.recurringRuleId != null,
      `recurringRuleId=${income.recurringRuleId}`
    );
    if (income.recurringRuleId != null) {
      check(
        `Income ${income.id}: RecurringRule vinculada existe e é kind=income`,
        income.recurringRule != null && income.recurringRule.kind === "income",
        `recurringRule=${income.recurringRule ? income.recurringRule.kind : "não encontrada"}`
      );
    }
  }

  // Duplicidade já é impossível pela @@unique([recurringRuleId,
  // recurringOccurrenceDate]) do banco — confirmado por evidência mesmo assim
  // (mesmo espírito do resto deste script: nunca só confiar na constraint).
  const grouped = new Map();
  for (const income of withOccurrenceDate) {
    if (income.recurringRuleId == null) continue;
    const key = `${income.recurringRuleId}:${income.recurringOccurrenceDate.toISOString().slice(0, 10)}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  const duplicated = [...grouped.entries()].filter(([, count]) => count > 1);
  check("Nenhuma ocorrência (recurringRuleId + recurringOccurrenceDate) duplicada", duplicated.length === 0, JSON.stringify(duplicated));
}

// Fase 4.1 — Financial Engine V2. Read-only.

// protectedMoney por conta não pode exceder o saldo real dessa conta — não dá
// pra "proteger" mais dinheiro do que a conta realmente tem.
async function auditProtectedMoneyWithinAccountBalance() {
  const reserves = await prisma.reserve.findMany({ where: { isActive: true } });
  const byAccount = new Map();
  for (const reserve of reserves) {
    const balance = await getReserveBalance(reserve.id);
    byAccount.set(reserve.accountId, addMoney(byAccount.get(reserve.accountId) || money(0), balance));
  }
  for (const [accountId, protectedSum] of byAccount) {
    const accountBalance = await computeAccountBalance(accountId);
    check(
      `Soma das Reserve ativas da conta ${accountId} não excede o saldo real da conta`,
      protectedSum.lte(accountBalance),
      `protegido=${protectedSum.toFixed(2)}, saldo=${accountBalance.toFixed(2)}`
    );
  }
}

// Nenhuma obrigação (CardBill/Bill/ExternalInstallment/ConfirmedCommitment)
// pode ser classificada em mais de uma classe simultaneamente — o classificador
// já garante isso por construção (lib/freeMoney.js:classifyAllObligations só
// empurra pra UM bucket), mas confirmado aqui por evidência de dado real, não
// só por confiar no código.
async function auditObligationClassesMutuallyExclusive() {
  const now = new Date();
  const buckets = await getObligationsBreakdown({ now, nextIncomeDate: now });
  const seen = new Map();
  const duplicated = [];
  for (const cls of Object.keys(buckets)) {
    for (const item of buckets[cls].items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) duplicated.push(key);
      seen.set(key, cls);
    }
  }
  check("Nenhuma obrigação classificada em mais de uma classe simultaneamente (incurred/currentHorizon/future)", duplicated.length === 0, JSON.stringify(duplicated));
}

// Fase 4.1.2 — Card Liability Gate. A seleção "primeira fatura não liquidada"
// (lib/freeMoney.js:resolveCurrentRelevantCardBillId) não depende de data
// nenhuma — funciona corretamente mesmo se o calendário/hora de fechamento for
// impreciso (item 3). Mas ela PRESSUPÕE que a materialização de CardBill é
// contígua ao redor de "agora" (sem lacuna). Esta checagem é a rede de
// segurança dessa suposição: sinaliza (não falha o script) se a fatura
// "relevante" resolvida pra algum cartão estiver anormalmente longe no tempo —
// evidência de uma possível lacuna de materialização, não uma prova de bug.
function auditCurrentRelevantCardBillDistance(cardsWithBills, now) {
  const ANOMALY_THRESHOLD_DAYS = 62; // ~2 ciclos de folga — generoso de propósito, só pra pegar lacuna real.
  for (const { card, bills } of cardsWithBills) {
    const currentId = resolveCurrentRelevantCardBillId(bills);
    if (!currentId) continue; // nenhuma fatura não liquidada — nada a checar.
    const bill = bills.find((b) => b.id === currentId);
    const daysFromNow = Math.abs((bill.closesAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    check(
      `Card "${card.name}": fatura relevante (${bill.cycleMonth}) está a uma distância razoável de hoje (possível lacuna de materialização, senão)`,
      daysFromNow <= ANOMALY_THRESHOLD_DAYS,
      `closesAt=${bill.closesAt.toISOString()}, hoje=${now.toISOString()}, distância=${Math.round(daysFromNow)} dias`
    );
  }
}

async function main() {
  console.log("--- Auditoria de consistência (read-only) ---\n");
  await auditAccountBalances();
  await auditNoVirtualCreditInBalance();
  await auditVaSnapshotMatchesAccountBalance();
  await auditCardBills();
  await auditCardBillStatus();
  await auditAnticipations();
  await auditMigrationSums();
  await auditOrphans();
  await auditAppSettingsSingleton();
  await auditDataConfidenceScope();
  await auditReserveBalances();
  await auditPositiveLedgerAmounts();
  await auditExternalInstallmentNumbers();
  await auditSettledCommitments();
  await auditReceivedReceivables();
  await auditContingencyBounds();
  await auditCardCreditBalances();
  await auditExternalInstallmentExpenseLinks();
  await auditCardCycleConfig();
  await auditExternalInstallmentPlanCompleteness();
  await auditCommitmentFunding();
  await auditCardBillDateSanity();
  await auditRecurringIncomeOccurrences();
  await auditProtectedMoneyWithinAccountBalance();
  await auditObligationClassesMutuallyExclusive();

  const cardsForRelevanceCheck = await prisma.card.findMany();
  const cardsWithBills = await Promise.all(
    cardsForRelevanceCheck.map(async (card) => ({ card, bills: await prisma.cardBill.findMany({ where: { cardId: card.id } }) }))
  );
  auditCurrentRelevantCardBillDistance(cardsWithBills, new Date());

  console.log(`\n${problems.length === 0 ? "✅ Tudo consistente." : `❌ ${problems.length} divergência(s) encontrada(s).`}`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
