// Fase 10.4 — PASSO A: PLANNER 100% SOMENTE LEITURA do catch-up financeiro (Itaú conta + Caju + cartão Itaú + Tiger).
//
// Este módulo LÊ o estado atual (via `client`, que pode ser PROD, rehearsal ou uma transação de teste), CALCULA o plano e devolve um
// objeto determinístico com as mutações que SERIAM necessárias. Ele NÃO executa nada: não existe aqui nenhum caminho de escrita —
// só consultas (find*/aggregate) e aritmética. O executor (PASSO B) é um artefato separado, ainda não criado.
//
// Fontes autoritativas (documentos do usuário): extrato Itaú emitido em 08/10/2026 (saldo 2.490,38, fechamento de 07/10), fatura
// Itaú fechada em 04/10/2026 (total 1.795,77, vencimento 13/10, NÃO paga) e saldo informado do Caju (530,89).
//
// Idempotência conceitual: cada operação só é planejada se o estado atual ainda não é o desejado; sobre um estado já reconciliado
// `operations.length === 0`.
import { Prisma } from "@prisma/client";
import { money, addMoney, subtractMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { getCardBillPeriod } from "../../lib/cardCycle.js";
import { addMonthKey } from "../../lib/formatMoney.js";
import { getAppTimezone } from "../../lib/appTimezone.js";
import { isAfterAnchor } from "../../lib/anchorOrdering.js";

export const PLAN_TAG = "FASE104-CATCHUP";
export const TARGETS = Object.freeze({
  itauBank: "2490.38",
  cajuBank: "530.89",
  cardBillObserved: "1795.77",
  cardBillCycle: "2026-10",
  cardBillDue: "2026-10-13",
  cardLimit: { total: "5087.00", available: "2471.16", used: "2615.84" },
  futureNext: "571.79",
  futureLater: "248.28",
  futureTotal: "820.07",
});
// FUSO: o Norte opera em America/Sao_Paulo. "Fim do dia" é 23:59:59 LOCAL, convertido para o instante UTC que o schema guarda — nunca
// "23:59:59Z" cru (que seria 20:59:59 em Brasília).
function tzOffsetMs(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - date.getTime();
}
export function zonedInstant(dateStr, timeStr, timeZone = getAppTimezone()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [H, M, S] = timeStr.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, H, M, S);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess).toISOString();
}
// Âncoras de saldo: 07/10/2026 23:59:59 America/Sao_Paulo (fechamento de 07/10 do extrato) = 2026-10-08T02:59:59.000Z.
export const ANCHOR_AT = zonedInstant("2026-10-07", "23:59:59");
// Observação da fatura: 04/10/2026 23:59:59 America/Sao_Paulo — DEPOIS de todo lançamento atribuído ao fechamento (inclusive o IOF de 04/10).
export const CARD_OBSERVED_AT = zonedInstant("2026-10-04", "23:59:59");

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);
const nextDay = (s) => new Date(day(s).getTime() + 86400000);
const num = (v) => Number(v?.toString?.() ?? v);
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
const fmt = (m) => money(m).toFixed(2);

// ----------------------------------------------------------------------------- dados do plano (constantes)
export const ITAU_ITEMS = [
  { key: "20260928-rend", date: "2026-09-28", kind: "income", amount: "0.28", description: "Rendimento Aplic Aut Mais — rendimento bancário", category: "Outros" },
  { key: "20260930-pedro-lazari", date: "2026-09-30", kind: "expense", amount: "29.50", description: "Pedro / Lazari — lanche", category: "Alimentação", note: "deveria ter sido pago pelo Caju — reembolso interno Caju → Itaú de R$ 29,50 PENDENTE (ação manual; domínio sem pendência interna)" },
  { key: "20260930-bar-mercearia", date: "2026-09-30", kind: "expense", amount: "4.00", description: "Bar/Mercearia — seda", category: "Outros" },
  { key: "20261001-gabriel-capinha", date: "2026-10-01", kind: "expense", amount: "27.00", description: "Gabriel — reposição de capinha de celular (danificada pela Catarina)", category: "Outros" },
  { key: "20261001-kaizen", date: "2026-10-01", kind: "income", amount: "0.11", description: "Pix recebido — Kaizen (finalidade desconhecida)", category: "Outros" },
  { key: "20261002-posto", date: "2026-10-02", kind: "expense", amount: "50.00", description: "Posto — gasolina do carro", category: "Transporte" },
  { key: "20261002-fernando", date: "2026-10-02", kind: "expense", amount: "2.00", description: "Fernando — paçoca", category: "Alimentação" },
  { key: "20261002-tapete", date: "2026-10-02", kind: "expense", amount: "48.89", description: "Tapete higiênico da Catarina", category: "Outros" },
  { key: "20261005-leandro-tiger", date: "2026-10-05", kind: "expense", amount: "1000.00", description: "Leandro — acordo da Tiger (R$ 1.000 de R$ 6.000)", category: "Outros" },
  { key: "20261005-ricardo-lavagem", date: "2026-10-05", kind: "expense", amount: "130.00", description: "Ricardo — lavagem do carro", category: "Transporte" },
  { key: "20261005-rend", date: "2026-10-05", kind: "income", amount: "0.04", description: "Rendimento Aplic Aut Mais — rendimento bancário", category: "Outros" },
  { key: "20261007-posto", date: "2026-10-07", kind: "expense", amount: "30.00", description: "Posto — gasolina", category: "Transporte" },
  { key: "20261007-pedro-estepe", date: "2026-10-07", kind: "expense", amount: "25.00", description: "Pedro — borracheiro (troca/colocação do estepe)", category: "Transporte" },
];
export const CAJU_ITEMS = [{ key: "20261003-carrossel", date: "2026-10-03", kind: "expense", amount: "65.36", description: "Carrossel — supermercado (lasanha, queijo, bacon etc.)", category: "Alimentação" }];

// Linhas do cartão que JÁ existem mas divergem do documento oficial. `days` = datas aceitas para o casamento.
export const CARD_CORRECTIONS = [
  { key: "sushi", days: ["2026-09-05", "2026-09-06"], match: /sushi/i, set: { date: "2026-09-06", amount: "384.89" } },
  { key: "claude", days: ["2026-09-08"], match: /claude/i, set: { amount: "116.31", description: "Claude — assinatura (internacional)", isRecurring: true } },
  { key: "tiny", days: ["2026-09-10"], match: /tim rp|tiny|erp/i, set: { description: "Tiny ERP", amount: "65.90" } }, // recorrência UNKNOWN: isRecurring NÃO marcado
  { key: "apple", days: ["2026-09-10"], match: /apple/i, set: { amount: "19.90", description: "Apple — assinatura", isRecurring: true } },
  { key: "wellhub-ricardo", days: ["2026-09-11"], match: /gympass|wellhub/i, set: { amount: "69.99", description: "Wellhub — Ricardo", isRecurring: true } },
  { key: "wellhub-bia", days: ["2026-09-14"], match: /gympass|wellhub/i, set: { amount: "69.99", description: "Wellhub — Bia", isRecurring: true } },
  { key: "gustavo", days: ["2026-09-17"], match: /n[aã]o identificada|gustavo/i, set: { description: "Gustavo Alberto — serviços", amount: "38.00" } },
];
// Lançamentos REAIS desta fatura que não existiam no Norte. IOF agregado: encargo da fatura (04/10), NÃO distribuído entre as assinaturas.
export const CARD_NEW_EXPENSES = [
  { key: "chatgpt", date: "2026-09-25", amount: "110.20", description: "ChatGPT — assinatura (internacional)", category: "Outros", isRecurring: true },
  { key: "spotify", date: "2026-09-27", amount: "31.90", description: "Spotify — assinatura", category: "Lazer", isRecurring: true },
  { key: "iof", date: "2026-10-04", amount: "7.93", description: "IOF internacional — encargo agregado da fatura de 04/10/2026 (Claude + ChatGPT)", category: "Outros", isRecurring: false, chargeOfBill: true, note: "encargo da fatura fechada em 04/10/2026; o documento não traz data própria de transação ⇒ data econômica = fechamento (04/10), nunca retroativa" },
];
// Parcelamentos em andamento: SÓ as parcelas ainda não pagas, com o valor OBSERVADO (nada de distribuir centavos residuais).
export const CARD_PURCHASES = [
  { key: "amazon", description: "Amazon — pipoqueiras", purchasedAt: "2026-05-12", count: 5, first: "2026-06", total: "459.00", totalDerived: true, value: "91.80", category: "Outros", rows: [{ n: 5, amount: "91.80" }] },
  { key: "jim", description: "Roupas — Jim.com F C M", purchasedAt: "2026-06-05", count: 5, first: "2026-07", total: "599.80", value: "119.96", category: "Outros", rows: [{ n: 4, amount: "119.96" }, { n: 5, amount: "119.96" }] },
  { key: "ml-utilidade", description: "Mercado Livre — utilidade", purchasedAt: "2026-06-30", count: 4, first: "2026-07", total: "403.16", totalDerived: true, value: "100.79", category: "Outros", rows: [{ n: 4, amount: "100.79" }] },
  { key: "myrian-vacinas", description: "Myrian — vacinas da Catarina", purchasedAt: "2026-07-14", count: 3, first: "2026-08", total: "135.00", totalDerived: true, value: "45.00", category: "Saúde", rows: [{ n: 3, amount: "45.00" }] },
  { key: "dh-pc", description: "Manutenção do PC — DH Mega Vendas", purchasedAt: "2026-08-07", count: 3, first: "2026-09", total: "384.49", value: "128.16", category: "Outros", note: "total histórico 384,49 ≠ 3 × 128,16 (centavo residual não distribuído)", rows: [{ n: 2, amount: "128.16" }, { n: 3, amount: "128.16" }] },
  { key: "raia-venvanse", description: "Venvanse — Raia Drogasil", purchasedAt: "2026-08-10", count: 3, first: "2026-09", total: "512.00", value: "170.66", category: "Saúde", note: "total histórico 512,00 ≠ 3 × 170,66 (centavos residuais não distribuídos)", rows: [{ n: 2, amount: "170.66" }, { n: 3, amount: "170.66" }] },
  { key: "ml-colchao", description: "Mercado Livre — colchão inflável", purchasedAt: "2026-09-30", count: 4, first: "2026-10", total: "132.99", totalDerived: true, value: "33.24", category: "Outros", note: "3/4 e 4/4 derivadas do total oficial das próximas faturas (248,28 − Shein 181,80 = 66,48 ÷ 2); NÃO observadas individualmente", rows: [{ n: 1, amount: "33.27" }, { n: 2, amount: "33.24" }, { n: 3, amount: "33.24", derived: true }, { n: 4, amount: "33.24", derived: true }] },
];
// Linhas nacionais/internacionais da fatura (para o checkpoint contábil 1.561,33 + 226,51 + 7,93 = 1.795,77).
export const INVOICE_NATIONAL = ["25.35", "38.00", "31.90", "91.80", "119.96", "100.79", "45.00", "128.16", "170.66", "60.60", "384.89", "59.17", "65.90", "19.90", "69.99", "31.00", "15.00", "69.99", "33.27"];
export const INVOICE_INTERNATIONAL = ["116.31", "110.20"];
export const INVOICE_IOF = "7.93";
export const TIGER = {
  description: "Acordo Tiger — Leandro (saldo restante)",
  shortLabel: "Tiger",
  amount: "5000.00",
  notes: "Acordo total R$ 6.000,00; R$ 1.000,00 pagos em 05/10/2026 (Pix Leandro). Restante R$ 5.000,00 SEM datas/parcelas definidas — nada inventado. Sem vencimento ⇒ obrigação futura (não reduz o livre atual).",
};

// ----------------------------------------------------------------------------- suporte do domínio a reembolso interno
// Verifica NO SCHEMA REAL (metadados do Prisma, somente leitura) se existe pendência de transferência interna:
//   (a) Transfer com campo de estado (status/pending) — hoje Transfer é sempre um fato REALIZADO;
//   (b) ConfirmedCommitment com modo de liquidação "INTERNAL_TRANSFER" — só existem EXPENSE e EXTERNAL_TRANSFER.
export function detectInternalReimbursementSupport() {
  const models = Prisma.dmmf.datamodel.models;
  const transfer = models.find((m) => m.name === "Transfer");
  const commitment = models.find((m) => m.name === "ConfirmedCommitment");
  const transferHasState = transfer.fields.some((f) => /^(status|pending|isPending|settledAt)$/i.test(f.name));
  const settlementField = commitment.fields.find((f) => f.name === "settlementMode");
  const commitmentHasInternalMode = !!settlementField && /INTERNAL/i.test(String(settlementField.default ?? ""));
  const supported = transferHasState || commitmentHasInternalMode;
  return {
    supported,
    transferHasState,
    commitmentHasInternalMode,
    reason: supported
      ? "o domínio expõe estado/modo para transferência interna pendente"
      : "Transfer só registra movimento REALIZADO (sem status/pendente) e ConfirmedCommitment só liquida por EXPENSE ou EXTERNAL_TRANSFER (devolução externa): não há pendência Caju → Itaú sem inventar estrutura",
  };
}

// ----------------------------------------------------------------------------- leitura auxiliar
async function cardCalculated(client, card, cycleMonth) {
  const { start, end } = getCardBillPeriod(card, cycleMonth);
  const [e, i] = await Promise.all([
    client.expense.aggregate({ where: { cardId: card.id, occurredAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    client.installment.aggregate({ where: { billMonth: cycleMonth, purchase: { cardId: card.id } }, _sum: { amount: true } }),
  ]);
  return addMoney(money(e._sum.amount), money(i._sum.amount));
}

async function houseBillState(client, ruleName, cycleMonth, { plannedPhone, waterReverted } = {}) {
  const rule = await client.recurringRule.findFirst({ where: { name: ruleName, kind: "expense" } });
  const bill = rule ? await client.bill.findFirst({ where: { recurringRuleId: rule.id, cycleMonth, part: 1 }, include: { expense: true } }) : null;
  const ruleAmount = rule?.amount != null ? fmt(rule.amount) : null;
  if (!rule) return { status: "NO_RULE" };
  if (bill?.status === "paid" && !(ruleName === "Água" && waterReverted)) {
    const amount = ruleName === "Telefone" && plannedPhone ? "57.48" : fmt(bill.expense?.amount ?? bill.amount);
    return { status: "PAID", amount };
  }
  if (ruleAmount == null) return { status: "PENDING_UNPRICED", amount: null }; // ex.: Energia — nunca vira zero nem média inventada
  return { status: "PENDING", amount: ruleAmount };
}

// ----------------------------------------------------------------------------- planner
export async function buildCatchup104Plan({ client } = {}) {
  if (!client) throw new Error("client é obrigatório");
  const operations = [];
  const warnings = [];
  const blockers = [];
  const op = (o) => operations.push({ id: `op${String(operations.length + 1).padStart(2, "0")}`, ...o });

  const [itau, caju, card] = await Promise.all([
    client.account.findFirst({ where: { slug: "itau" } }),
    client.account.findFirst({ where: { slug: "vale-alimentacao" } }),
    client.card.findFirst({ orderBy: { createdAt: "asc" } }),
  ]);
  if (!itau || !caju || !card) {
    blockers.push("Conta Itaú, conta Caju (vale-alimentacao) ou cartão Itaú não encontrados.");
    return { operations, balancesBefore: null, balancesProjected: null, cardReconciliation: null, warnings, blockers };
  }
  const itauAnchor = await client.balanceAdjustment.findFirst({ where: { accountId: itau.id }, orderBy: { occurredAt: "desc" } });
  const cajuAnchor = await client.balanceAdjustment.findFirst({ where: { accountId: caju.id }, orderBy: { occurredAt: "desc" } });
  const balancesBefore = { itau: fmt(await computeAccountBalance(itau.id, { client })), caju: fmt(await computeAccountBalance(caju.id, { client })) };
  const counts = (anchor, date) => !anchor || isAfterAnchor(date, anchor.occurredAt); // o saldo só soma lançamentos DEPOIS da última âncora (ordenação por dia local — lib/anchorOrdering.js)
  let itauDelta = money(0);
  let cajuDelta = money(0);

  // ---------- 1) contas da casa
  const falseWater = await client.bill.findFirst({ where: { description: "Água", cycleMonth: "2026-10", part: 1, status: "paid" }, include: { expense: true } });
  const waterIsFalse = !!falseWater?.expense && same(falseWater.amount, "59.27") && same(falseWater.expense.amount, "59.27") && dayKey(falseWater.expense.occurredAt) === "2026-09-26";
  if (falseWater && !waterIsFalse) blockers.push(`Água 2026-10 está paga mas não bate com o padrão esperado (59,27 em 26/09) — conferir manualmente: bill ${falseWater.id}.`);
  if (waterIsFalse) {
    if (counts(itauAnchor, falseWater.expense.occurredAt)) itauDelta = addMoney(itauDelta, "59.27");
    op({ section: "house", kind: "REMOVE_FALSE_HOUSE_PAYMENT", description: "Desfazer o pagamento INEXISTENTE da Água 2026-10 (−R$ 59,27 em 26/09, sem linha no extrato): remove a Expense e a Bill volta a PENDENTE (projetada pela regra)", target: { model: "bill", id: falseWater.id, expenseId: falseWater.expense.id }, effect: { itau: "+59.27" }, via: "undoHouseBillPayment (mecanismo existente do app, com trilha de auditoria)", preconditions: { billId: falseWater.id, billStatus: "paid", billAmount: "59.27", expenseId: falseWater.expense.id, expenseAmount: "59.27", expenseDay: "2026-09-26", cycleMonth: "2026-10" } });
  }
  const phone = await client.bill.findFirst({ where: { description: "Telefone", cycleMonth: "2026-10", part: 1, status: "paid" }, include: { expense: true } });
  const phoneWrong = !!phone?.expense && !same(phone.expense.amount, "57.48");
  if (phoneWrong && !same(phone.expense.amount, "60")) blockers.push(`Telefone pago com valor inesperado (${phone.expense.amount}); esperado 60,00 → 57,48.`);
  if (phoneWrong && same(phone.expense.amount, "60")) {
    if (counts(itauAnchor, phone.expense.occurredAt)) itauDelta = addMoney(itauDelta, subtractMoney(phone.expense.amount, "57.48"));
    op({ section: "house", kind: "CORRECT_HOUSE_PAYMENT_AMOUNT", description: "Telefone: Expense e Bill R$ 60,00 → R$ 57,48 (extrato CLARO 28/09); data e vínculo preservados", target: { model: "expense", id: phone.expense.id, billId: phone.id }, from: "60.00", to: "57.48", effect: { itau: "+2.52" }, preconditions: { expenseId: phone.expense.id, expenseAmount: "60.00", billId: phone.id, billAmount: phone.amount.toString(), billStatus: "paid" } });
  }

  // ---------- 2) ledger Itaú e Caju
  async function ledgerItems(account, anchor, items, who) {
    for (const it of items) {
      const model = it.kind === "income" ? "income" : "expense";
      const exists = await client[model].findFirst({ where: { accountId: account.id, OR: [{ rawMessage: { startsWith: `${PLAN_TAG}:${it.key}` } }, { occurredAt: { gte: day(it.date), lt: nextDay(it.date) }, amount: it.amount }] } });
      if (exists) continue;
      const signed = it.kind === "income" ? money(it.amount) : money(it.amount).neg();
      if (counts(anchor, day(it.date))) (who === "itau" ? (itauDelta = addMoney(itauDelta, signed)) : (cajuDelta = addMoney(cajuDelta, signed)));
      op({ section: who, kind: it.kind === "income" ? "ADD_INCOME" : "ADD_EXPENSE", description: `${it.kind === "income" ? "+" : "−"}R$ ${it.amount} em ${it.date}: ${it.description}`, target: { model, accountId: account.id }, data: { amount: it.amount, occurredAt: it.date, description: it.description, category: it.category, source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:${it.key}${it.note ? ` | ${it.note}` : ""}` }, effect: { [who]: `${it.kind === "income" ? "+" : "-"}${it.amount}` }, preconditions: { absent: { model, accountId: account.id, marker: `${PLAN_TAG}:${it.key}`, day: it.date, amount: it.amount } } });
    }
  }
  await ledgerItems(itau, itauAnchor, ITAU_ITEMS, "itau");
  await ledgerItems(caju, cajuAnchor, CAJU_ITEMS, "caju");

  // ---------- 3) Tiger (compromisso restante + contingência antiga)
  const commitments = await client.confirmedCommitment.findMany({ where: { description: { startsWith: "Acordo Tiger" } } });
  const activeCommitments = commitments.filter((c) => c.status !== "CANCELLED");
  const contingencies = await client.contingency.findMany({ where: { description: "Tiger", status: { not: "DISMISSED" } } });
  if (activeCommitments.length === 0) {
    op({ section: "tiger", kind: "ADD_CONFIRMED_COMMITMENT", description: "Compromisso confirmado 'Acordo Tiger — Leandro (saldo restante)' R$ 5.000,00 SEM prazo (total 6.000; 1.000 pagos em 05/10); dueDate = null ⇒ obrigação futura, não reduz o livre atual", target: { model: "confirmedCommitment" }, data: { description: TIGER.description, shortLabel: TIGER.shortLabel, amount: TIGER.amount, dueDate: null, status: "CONFIRMED", confidence: "CONFIRMED", notes: TIGER.notes }, preconditions: { noActiveCommitmentStartingWith: "Acordo Tiger" } });
  }
  for (const c of contingencies) {
    op({ section: "tiger", kind: "DISMISS_CONTINGENCY", description: `Contingência antiga 'Tiger' (esperado ${c.expectedAmount ?? "—"} / máx ${c.maxAmount}, ${c.status}) → DISMISSED: SUBSTITUÍDA pelo compromisso confirmado de R$ 5.000 (nunca coexistem como duas dívidas)`, target: { model: "contingency", id: c.id }, data: { status: "DISMISSED", notesAppend: "Substituída em 08/10/2026 pelo compromisso confirmado 'Acordo Tiger — Leandro' (restante R$ 5.000,00)." }, reversible: true, preconditions: { contingencyId: c.id, currentStatus: c.status, description: "Tiger" } });
  }
  const tigerCommitmentAfter = activeCommitments.length ? fmt(activeCommitments[0].amount) : TIGER.amount;
  const tigerRepresentationsAfter = Math.max(activeCommitments.length, 1) + 0; // compromissos ativos depois do plano
  const tigerContingenciesAfter = 0; // toda contingência Tiger ativa é dispensada pelo plano
  const tigerDoubleCount = tigerRepresentationsAfter + tigerContingenciesAfter > 1;

  // ---------- 4) cartão
  const expCandidates = await client.expense.findMany({ where: { cardId: card.id, occurredAt: { gte: day("2026-09-04"), lt: day("2026-10-05") } } });
  let calcBase = await cardCalculated(client, card, TARGETS.cardBillCycle);
  const calcBefore = calcBase;
  const taken = new Set();
  for (const c of CARD_CORRECTIONS) {
    const finalDay = c.set.date ?? c.days[c.days.length - 1];
    const found = expCandidates.find((e) => !taken.has(e.id) && c.days.includes(dayKey(e.occurredAt)) && c.match.test(e.description));
    if (!found) {
      blockers.push(`Linha do cartão '${c.key}' não encontrada (dias ${c.days.join("/")}).`);
      continue;
    }
    taken.add(found.id);
    const diff = {};
    if (c.set.amount != null && !same(found.amount, c.set.amount)) diff.amount = c.set.amount;
    if (c.set.description != null && found.description !== c.set.description) diff.description = c.set.description;
    if (c.set.isRecurring != null && found.isRecurring !== c.set.isRecurring) diff.isRecurring = c.set.isRecurring;
    if (dayKey(found.occurredAt) !== finalDay) diff.occurredAt = finalDay;
    if (!Object.keys(diff).length) continue;
    if (diff.amount != null) calcBase = addMoney(calcBase, subtractMoney(diff.amount, found.amount));
    op({ section: "card", kind: "CORRECT_CARD_EXPENSE", description: `Linha '${c.key}' do cartão → valor real da fatura: ${JSON.stringify(diff)}`, target: { model: "expense", id: found.id }, from: { amount: found.amount.toString(), date: dayKey(found.occurredAt), description: found.description }, data: diff, preconditions: { expenseId: found.id, cardId: card.id, currentAmount: found.amount.toString(), currentDay: dayKey(found.occurredAt), currentDescription: found.description } });
  }
  for (const n of CARD_NEW_EXPENSES) {
    const exists = await client.expense.findFirst({ where: { cardId: card.id, OR: [{ rawMessage: { startsWith: `${PLAN_TAG}:card-${n.key}` } }, { occurredAt: { gte: day(n.date), lt: nextDay(n.date) }, amount: n.amount }] } });
    if (exists) continue;
    calcBase = addMoney(calcBase, n.amount);
    op({ section: "card", kind: "ADD_CARD_EXPENSE", description: `Lançamento real da fatura ausente no Norte: ${n.date} R$ ${n.amount} ${n.description}`, target: { model: "expense", cardId: card.id }, data: { amount: n.amount, occurredAt: n.date, description: n.description, category: n.category, isRecurring: n.isRecurring, source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:card-${n.key} | fatura Itaú 04/10/2026${n.note ? ` | ${n.note}` : ""}` }, preconditions: { absent: { cardId: card.id, marker: `${PLAN_TAG}:card-${n.key}`, day: n.date, amount: n.amount } } });
  }
  const purchases = await client.purchase.findMany({ where: { cardId: card.id }, include: { installments: true } });
  const plannedRows = []; // { billMonth, amount }
  for (const p of CARD_PURCHASES) {
    const exists = purchases.find((x) => (x.rawMessage ?? "").startsWith(`${PLAN_TAG}:card-${p.key}`) || (dayKey(x.purchasedAt) === p.purchasedAt && same(x.installmentValue, p.value) && x.installmentCount === p.count));
    if (exists) continue;
    for (const r of p.rows) plannedRows.push({ billMonth: addMonthKey(p.first, r.n - 1), amount: r.amount });
    calcBase = addMoney(calcBase, p.rows.filter((r) => addMonthKey(p.first, r.n - 1) === TARGETS.cardBillCycle).reduce((a, r) => addMoney(a, r.amount), money(0)));
    if (p.totalDerived) warnings.push(`Parcelamento '${p.key}': total ${p.total} DERIVADO (valor × parcelas); as parcelas observadas são as reais.`);
    if (p.note) warnings.push(`Parcelamento '${p.key}': ${p.note}.`);
    op({ section: "card", kind: "ADD_PURCHASE_WITH_INSTALLMENTS", description: `Estruturar '${p.description}' (compra ${p.purchasedAt}, ${p.count}x): ${p.rows.map((r) => `${r.n}/${p.count}=${r.amount}${r.derived ? "*" : ""}`).join(", ")}`, target: { model: "purchase", cardId: card.id }, data: { description: p.description, totalAmount: p.total, installmentCount: p.count, installmentValue: p.value, firstInstallmentMonth: p.first, startingInstallmentNumber: p.rows[0].n, purchasedAt: p.purchasedAt, category: p.category, confidence: p.rows.some((r) => r.derived) ? "ESTIMATED" : "CONFIRMED", rows: p.rows.map((r) => ({ number: r.n, amount: r.amount, billMonth: addMonthKey(p.first, r.n - 1), derived: !!r.derived, confidence: r.derived ? "ESTIMATED" : "CONFIRMED", provenance: r.derived ? "derived_from_official_statement" : "observed_in_official_statement" })), totalDerived: !!p.totalDerived, note: p.note ?? null, rawMessage: `${PLAN_TAG}:card-${p.key}` }, preconditions: { absent: { cardId: card.id, marker: `${PLAN_TAG}:card-${p.key}`, purchasedDay: p.purchasedAt, value: p.value, count: p.count } } });
  }
  const shein = purchases.find((x) => /aniversario da bia|aniversário da bia|shein/i.test(x.description) && x.installmentCount === 6 && same(x.installmentValue, "60.60"));
  if (shein && shein.description !== "Roupas da Bia — Shein") op({ section: "card", kind: "RENAME_PURCHASE", description: "Renomear 'aniversário da Bia' → 'Roupas da Bia — Shein' (MESMA compra, 6 × 60,60 — não duplica)", target: { model: "purchase", id: shein.id }, data: { description: "Roupas da Bia — Shein" }, preconditions: { purchaseId: shein.id, currentDescription: shein.description } });
  if (!shein) blockers.push("Compra Shein/aniversário da Bia (6 × 60,60) não encontrada — risco de duplicar.");

  // ---------- 5) fatura: total calculado projetado, observação, limite, linha CardBill
  const projectedCalculated = fmt(calcBase);
  const latestRec = await client.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: TARGETS.cardBillCycle }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const recDone = !!latestRec && same(latestRec.observedTotal, TARGETS.cardBillObserved);
  const gapAfter = subtractMoney(TARGETS.cardBillObserved, projectedCalculated);
  if (!recDone) op({ section: "card", kind: "RECORD_CARD_BILL_OBSERVATION", description: `Observação oficial da fatura 2026-10: total R$ 1.795,77 (substitui a de 25/09: ${latestRec ? fmt(latestRec.observedTotal) : "—"}); vencimento 13/10; NÃO paga`, target: { model: "cardBillReconciliation", cardId: card.id }, data: { cycleMonth: TARGETS.cardBillCycle, observedTotal: TARGETS.cardBillObserved, calculatedTotal: projectedCalculated, delta: fmt(gapAfter), occurredAt: CARD_OBSERVED_AT, confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: `${PLAN_TAG}:card-bill` }, preconditions: { cardId: card.id, cycleMonth: TARGETS.cardBillCycle, noObservationWithTotal: TARGETS.cardBillObserved } });
  const latestLimit = await client.cardLimitUpdate.findFirst({ where: { cardId: card.id }, orderBy: { occurredAt: "desc" } });
  const limitDone = !!latestLimit && same(latestLimit.newUsedLimit, TARGETS.cardLimit.used) && latestLimit.newTotalLimit != null && same(latestLimit.newTotalLimit, TARGETS.cardLimit.total);
  if (!limitDone) op({ section: "card", kind: "RECORD_CARD_LIMIT_OBSERVATION", description: "Observação de limite NA DATA DE FECHAMENTO (04/10): total 5.087,00 · disponível 2.471,16 · utilizado 2.615,84 — não é saldo ao vivo", target: { model: "cardLimitUpdate", cardId: card.id }, data: { newTotalLimit: TARGETS.cardLimit.total, newUsedLimit: TARGETS.cardLimit.used, reportedAvailable: TARGETS.cardLimit.available, occurredAt: CARD_OBSERVED_AT, rawMessage: `${PLAN_TAG}:card-limit` }, preconditions: { cardId: card.id, noLimitObservationWithUsed: TARGETS.cardLimit.used } });
  // futuras (somente leitura + linhas planejadas)
  const installmentRows = await client.installment.findMany({ where: { purchase: { cardId: card.id }, billMonth: { gte: "2026-11" } }, select: { billMonth: true, amount: true } });
  const byMonth = {};
  for (const r of [...installmentRows, ...plannedRows.filter((x) => x.billMonth >= "2026-11")]) byMonth[r.billMonth] = addMoney(byMonth[r.billMonth] ?? money(0), r.amount);
  const futureNext = fmt(byMonth["2026-11"] ?? 0);
  const laterMonths = Object.keys(byMonth).filter((m) => m > "2026-11");
  const futureLater = fmt(laterMonths.reduce((a, m) => addMoney(a, byMonth[m]), money(0)));
  const futureTotal = fmt(addMoney(futureNext, futureLater));
  const bills = await client.cardBill.findMany({ where: { cardId: card.id } });
  for (const b of bills) {
    if (b.status === "paid") continue;
    const projected = b.cycleMonth === TARGETS.cardBillCycle ? projectedCalculated : b.cycleMonth >= "2026-11" ? fmt(byMonth[b.cycleMonth] ?? 0) : null;
    if (projected == null) continue;
    const data = {};
    if (!same(b.totalAmount, projected)) data.totalAmount = projected;
    if (b.cycleMonth === TARGETS.cardBillCycle) {
      if (b.status !== "closed") data.status = "closed";
      if (dayKey(b.dueAt) !== TARGETS.cardBillDue) data.dueAt = TARGETS.cardBillDue;
    }
    if (Object.keys(data).length) op({ section: "card", kind: "SYNC_CARD_BILL_ROW", description: `CardBill ${b.cycleMonth}: ${JSON.stringify(data)} (total persistido volta a ser o CALCULADO; nunca o observado)`, target: { model: "cardBill", id: b.id }, from: { totalAmount: b.totalAmount.toString(), status: b.status, dueAt: dayKey(b.dueAt) }, data, preconditions: { billId: b.id, currentTotal: b.totalAmount.toString(), currentStatus: b.status, currentDueDay: dayKey(b.dueAt) } });
  }

  // ---------- 6) saldos projetados e ajustes de reconciliação (só o resíduo que NENHUMA linha explica)
  const itauLedgerProjected = addMoney(balancesBefore.itau, itauDelta);
  const cajuLedgerProjected = addMoney(balancesBefore.caju, cajuDelta);
  const itauAdj = subtractMoney(TARGETS.itauBank, itauLedgerProjected);
  const cajuAdj = subtractMoney(TARGETS.cajuBank, cajuLedgerProjected);
  if (!itauAdj.isZero()) op({ section: "itau", kind: "ADD_BALANCE_RECONCILIATION", description: `Âncora de reconciliação Itaú: ledger projetado ${fmt(itauLedgerProjected)} → saldo do banco ${TARGETS.itauBank} (ajuste ${fmt(itauAdj)}; sem Expense/Income falsa)`, target: { model: "balanceAdjustment", accountId: itau.id }, data: { newBalance: TARGETS.itauBank, confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: ANCHOR_AT, rawMessage: `${PLAN_TAG}:itau-recon` }, effect: { itauAdjustment: fmt(itauAdj) }, preconditions: { accountId: itau.id, targetBalance: TARGETS.itauBank, expectedAdjustment: fmt(itauAdj), expectedLedgerAfterLines: fmt(itauLedgerProjected), requiresNoRealLineExplains: true } });
  if (!cajuAdj.isZero()) op({ section: "caju", kind: "ADD_BALANCE_RECONCILIATION", description: `Âncora de reconciliação Caju: ledger projetado ${fmt(cajuLedgerProjected)} → saldo informado ${TARGETS.cajuBank} (ajuste ${fmt(cajuAdj)}; nenhum movimento de 0,10 existe no Norte)`, target: { model: "balanceAdjustment", accountId: caju.id }, data: { newBalance: TARGETS.cajuBank, confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: ANCHOR_AT, rawMessage: `${PLAN_TAG}:caju-recon` }, effect: { cajuAdjustment: fmt(cajuAdj) }, preconditions: { accountId: caju.id, targetBalance: TARGETS.cajuBank, expectedAdjustment: fmt(cajuAdj), expectedLedgerAfterLines: fmt(cajuLedgerProjected), requiresNoRealLineExplains: true } });
  const balancesProjected = { itauLedger: fmt(itauLedgerProjected), itauAdjustment: fmt(itauAdj), itau: TARGETS.itauBank, cajuLedger: fmt(cajuLedgerProjected), cajuAdjustment: fmt(cajuAdj), caju: TARGETS.cajuBank };
  if (!itauAdj.isZero()) warnings.push(`Itaú: resíduo ${fmt(itauAdj)} sem linha bancária (âncora de 25/09 estava +0,19 acima do banco; o cabeçalho do extrato traz +0,09 em 07/10 não itemizado) ⇒ RECONCILIATION_ADJUSTMENT explícito.`);

  // ---------- 7) estado das contas da casa e reembolso interno
  const waterReverted = waterIsFalse;
  const houseAfter = {
    water: await houseBillState(client, "Água", "2026-10", { waterReverted }),
    energy: await houseBillState(client, "Energia", "2026-10"),
    phone: await houseBillState(client, "Telefone", "2026-10", { plannedPhone: phoneWrong }),
  };
  const reimbursement = detectInternalReimbursementSupport();
  const manualPendingActions = [];
  if (!reimbursement.supported) manualPendingActions.push({ id: "CAJU_TO_ITAU_29_50", from: "Caju", to: "Itaú", amount: "29.50", status: "PENDING_MANUAL", note: "Reembolso interno do lanche de 30/09 (Pedro / Lazari). NÃO realizado: quando transferir, Caju −29,50 e Itaú +29,50 (não é Income). Registrado só na anotação do lançamento de 29,50; sem estrutura nova no domínio." });
  const knownLimitations = [];
  if (!reimbursement.supported) knownLimitations.push("INTERNAL_REIMBURSEMENT: o domínio não suporta pendência de transferência interna (Transfer é sempre realizado; ConfirmedCommitment liquida só por EXPENSE/EXTERNAL_TRANSFER).");
  knownLimitations.push("CARD_RECURRING_TEMPLATES: não existe template recorrente para cartão (RecurringRule só tem conta); a recorrência é apenas a marca Expense.isRecurring nos lançamentos REAIS desta fatura. Tiny ERP permanece UNKNOWN (não marcado).");

  const existingTemplates = await client.recurringRule.findMany({ where: { kind: "expense", OR: [{ name: { contains: "Claude", mode: "insensitive" } }, { name: { contains: "ChatGPT", mode: "insensitive" } }, { name: { contains: "Spotify", mode: "insensitive" } }, { name: { contains: "Apple", mode: "insensitive" } }, { name: { contains: "Wellhub", mode: "insensitive" } }] }, select: { name: true } });
  const recurringCharges = { templatesSupportedForCards: false, existingTemplates: existingTemplates.map((t) => t.name), realChargesThisInvoice: { claude: "116.31", chatgpt: "110.20", spotify: "31.90", apple: "19.90", wellhubRicardo: "69.99", wellhubBia: "69.99" }, iofAggregate: INVOICE_IOF, iofDistributed: false, tiny: { amount: "65.90", recurrence: "UNKNOWN", markedRecurring: false } };

  // ---------- 8) checkpoints
  const sum = (arr) => arr.reduce((a, v) => addMoney(a, v), money(0));
  const checkpoints = [
    { name: "fatura = nacionais + internacionais + IOF", expected: TARGETS.cardBillObserved, actual: fmt(addMoney(addMoney(sum(INVOICE_NATIONAL), sum(INVOICE_INTERNATIONAL)), INVOICE_IOF)) },
    { name: "nacionais da fatura", expected: "1561.33", actual: fmt(sum(INVOICE_NATIONAL)) },
    { name: "internacionais (antes do IOF)", expected: "226.51", actual: fmt(sum(INVOICE_INTERNATIONAL)) },
    { name: "total calculado do ciclo 2026-10 após o plano = observado", expected: TARGETS.cardBillObserved, actual: projectedCalculated },
    { name: "próxima fatura (parcelas)", expected: TARGETS.futureNext, actual: futureNext },
    { name: "demais faturas (parcelas)", expected: TARGETS.futureLater, actual: futureLater },
    { name: "total futuro parcelado", expected: TARGETS.futureTotal, actual: futureTotal },
    { name: "limite utilizado = fatura + parcelas futuras", expected: TARGETS.cardLimit.used, actual: fmt(addMoney(TARGETS.cardBillObserved, futureTotal)) },
    { name: "Itaú projetado = banco", expected: TARGETS.itauBank, actual: fmt(addMoney(itauLedgerProjected, itauAdj)) },
    { name: "Caju projetado = informado", expected: TARGETS.cajuBank, actual: fmt(addMoney(cajuLedgerProjected, cajuAdj)) },
  ].map((c) => ({ ...c, ok: same(c.expected, c.actual) }));
  for (const c of checkpoints) if (!c.ok) blockers.push(`Checkpoint falhou: ${c.name} (esperado ${c.expected}, obtido ${c.actual})`);
  if (tigerDoubleCount) blockers.push("Tiger seria contado em dobro (contingência + compromisso).");

  const installmentsAfter = [
    ...purchases.map((p) => ({ description: p.description, existing: true })),
    ...CARD_PURCHASES.filter((p) => !purchases.some((x) => (x.rawMessage ?? "").startsWith(`${PLAN_TAG}:card-${p.key}`) || (dayKey(x.purchasedAt) === p.purchasedAt && same(x.installmentValue, p.value) && x.installmentCount === p.count))).map((p) => ({ description: p.description, existing: false })),
  ];

  return {
    operations,
    balancesBefore,
    balancesProjected,
    cardReconciliation: { cycleMonth: TARGETS.cardBillCycle, observedTotal: TARGETS.cardBillObserved, dueDate: TARGETS.cardBillDue, status: "UNPAID", calculatedBefore: fmt(calcBefore), calculatedAfter: projectedCalculated, gapAfter: fmt(gapAfter), limitObservedAtClose: TARGETS.cardLimit, futureNext, futureLater, futureTotal, installmentsAfter },
    house: houseAfter,
    tiger: { oldContingencyAction: contingencies.length ? "DISMISS (DISMISSED) — substituída pelo compromisso confirmado" : "nenhuma contingência ativa", newCommitment: tigerCommitmentAfter, noDueDate: true, doubleCount: tigerDoubleCount },
    recurringCharges,
    internalReimbursement: { ...reimbursement, manualPendingActions },
    checkpoints,
    knownLimitations,
    warnings,
    blockers,
  };
}
