// Fase 10.6 — PLANNER 100% SOMENTE LEITURA do catch-up 08/10 → 13/10 (Itaú, Caju, Dinheiro, cartão Itaú, Cofrinho/Tattoo, CNPJ, Repasses do Caju).
//
// LÊ o estado atual (via `client`), CALCULA o plano e devolve um objeto determinístico com as mutações que SERIAM necessárias; não executa nada
// (o executor é outro arquivo). Fonte dos movimentos: as informações detalhadas e confirmadas pelo usuário (extrato Itaú até 13/10, telas do
// cartão em 13/10, saldo do Caju, contagem física de dinheiro). Idempotência conceitual: sobre um estado já reconciliado, operations.length = 0.
import { money, addMoney, subtractMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { getCardBillPeriod } from "../../lib/cardCycle.js";
import { addMonthKey } from "../../lib/formatMoney.js";
import { getAppTimezone } from "../../lib/appTimezone.js";
import { isAfterAnchor } from "../../lib/anchorOrdering.js";
import { PAYMENT_KEY_PREFIX } from "../../lib/cardBillPaymentKey.js";

export const PLAN_TAG = "FASE106-CATCHUP";

function tzOffsetMs(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - date.getTime();
}
// "fim do dia" é 23:59:59 LOCAL (America/Sao_Paulo) convertido para o instante UTC que o schema guarda.
export function zonedInstant(dateStr, timeStr, timeZone = getAppTimezone()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [H, M, S] = timeStr.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, H, M, S);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess).toISOString();
}
export const ANCHOR_AT = zonedInstant("2026-10-13", "23:59:59"); // 13/10 23:59:59 BRT = 2026-10-14T02:59:59.000Z
export const LIMIT_OBSERVED_AT = ANCHOR_AT;
// A leitura do app em 13/10 NÃO inclui a compra de 12/10 (Rei do Pernil, ainda não postada): o instante da observação é o do último dia
// postado (11/10 23:59:59 BRT). Assim o motor trata a compra de 12/10 como "lançado depois da observação" (incorrido, fora do observado).
export const BILL_OBSERVED_AT = zonedInstant("2026-10-11", "23:59:59");

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);
const nextDay = (s) => new Date(day(s).getTime() + 86400000);
const num = (v) => Number(v?.toString?.() ?? v);
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
const fmt = (m) => money(m).toFixed(2);

export const TARGETS = Object.freeze({
  itau: "12.28",
  caju: "248.46",
  dinheiro: "181.00",
  cajuBefore: "530.89",
  octTotal: "1795.77",
  octCredit: "118.34",
  octPayment: "1677.43",
  novObserved: "1060.46",
  novNewPosted: "488.67",
  novProjectedInstallments: "571.79",
  futureTotal: "461.32",
  limit: { total: "5087.00", available: "3465.22", used: "1621.78" },
  tattoo: "150.00",
  goalTarget: "2635.00",
  cnpjPayable: "1335.00",
  tinyReceivable: "65.90",
  cajuReimbursements: "100.50",
  cajuAfter: "147.96",
});

// ----------------------------------------------------------------------------- dados do plano
// Lançamentos do ITAÚ (conta corrente). `posted` = data bancária (occurredAt); `ref` = data de referência informada na descrição do extrato
// (o domínio tem uma data só: usa-se a bancária e preserva-se a referência no rawMessage).
export const ITAU_ITEMS = [
  { key: "20261008-paulo-cortina", date: "2026-10-08", kind: "income", amount: "150.00", category: "Outros", description: "Paulo E. — venda de cortina usada (Marketplace) — entrada extraordinária, NÃO é salário nem renda recorrente" },
  { key: "20261008-rend", date: "2026-10-08", kind: "income", amount: "0.07", category: "Outros", description: "Rendimento Aplic Aut Mais — rendimento bancário" },
  { key: "20261009-raia-rinite", date: "2026-10-09", kind: "expense", amount: "59.89", category: "Saúde", description: "Raia Drogasil — remédio para rinite" },
  { key: "20261009-maria-ajuda", date: "2026-10-09", kind: "expense", amount: "100.00", category: "Outros", description: "Maria — Pix de ajuda para a mãe (ajuda familiar; sem reembolso)" },
  { key: "20261009-wagner", date: "2026-10-09", kind: "expense", amount: "10.00", category: "Outros", description: "Pix para Wagner (finalidade desconhecida)" },
  { key: "20261009-ventmea", date: "2026-10-09", kind: "income", amount: "0.05", category: "Outros", description: "VENTMEA — crédito confirmado no extrato (finalidade desconhecida)" },
  { key: "20261009-rend", date: "2026-10-09", kind: "income", amount: "0.01", category: "Outros", description: "Rendimento Aplic Aut Mais — rendimento bancário" },
  { key: "20261013-cri-remedio", date: "2026-10-13", ref: "2026-10-10", kind: "expense", amount: "16.90", category: "Saúde", description: "Casa do Cri — remédio da Catarina (pet / saúde animal)" },
  { key: "20261013-posto-10", date: "2026-10-13", ref: "2026-10-10", kind: "expense", amount: "50.00", category: "Transporte", description: "Posto — gasolina do carro" },
  { key: "20261013-ednilson", date: "2026-10-13", ref: "2026-10-10", kind: "expense", amount: "13.00", category: "Lazer", description: "Ednilson — duas cervejas" },
  { key: "20261013-carrossel-chinelo", date: "2026-10-13", ref: "2026-10-10", kind: "expense", amount: "33.99", category: "Outros", description: "Carrossel — chinelo Havaianas (vestuário / uso pessoal)" },
  { key: "20261013-bia-bandagem", date: "2026-10-13", ref: "2026-10-10", kind: "expense", amount: "70.50", category: "Lazer", description: "Ana Beatriz — bandagem para boxe (a Bia comprou e o usuário reembolsou via Pix)" },
  { key: "20261013-posto-12", date: "2026-10-13", ref: "2026-10-12", kind: "expense", amount: "52.00", category: "Transporte", description: "Posto — gasolina do carro" },
  { key: "20261013-maria-roupa", date: "2026-10-13", kind: "expense", amount: "63.50", category: "Outros", description: "Maria — roupa nova pós-castração da Catarina (pet)" },
];
export const CAJU_ITEMS = [
  { key: "20261008-almoco", date: "2026-10-08", kind: "expense", amount: "30.00", category: "Alimentação", description: "Almoço / comida" },
  { key: "20261008-adega", date: "2026-10-08", kind: "expense", amount: "8.50", category: "Alimentação", description: "Adega JJ — Coca-Cola retornável" },
  { key: "20261008-pizza", date: "2026-10-08", kind: "expense", amount: "48.00", category: "Alimentação", description: "Pizza" },
  { key: "20261010-super", date: "2026-10-10", kind: "expense", amount: "30.00", category: "Alimentação", description: "Supermercado (item exato desconhecido)" },
  { key: "20261010-desconhecida", date: "2026-10-10", kind: "expense", amount: "9.29", category: "Outros", description: "Compra no Caju confirmada (finalidade desconhecida)" },
  { key: "20261011-abc", date: "2026-10-11", kind: "expense", amount: "136.25", category: "Alimentação", description: "ABC — compras para casa" },
  { key: "20261012-gomes-bia", date: "2026-10-12", kind: "expense", amount: "19.98", category: "Alimentação", description: "Gomes — bebida para a Bia" },
];
// Compras REAIS no cartão desta fatura (novembro). Tiny: cobrança do CNPJ paga no cartão pessoal (recorrência pessoal NÃO projetada).
export const CARD_EXPENSES = [
  { key: "claude", date: "2026-10-08", amount: "117.35", category: "Trabalho", description: "Claude — assinatura (internacional)", isRecurring: true, posted: true },
  { key: "pet-ração-roupa", date: "2026-10-08", amount: "88.90", category: "Outros", description: "Chinait F Gurgel Comerc — ração da Catarina + primeira roupa de castração (pet)", isRecurring: false, posted: true },
  { key: "tiny", date: "2026-10-10", amount: "65.90", category: "Trabalho", description: "Tiny ERP — assinatura mensal do CNPJ paga no cartão pessoal (reembolso a receber do CNPJ)", isRecurring: false, posted: true },
  { key: "apple", date: "2026-10-10", amount: "19.90", category: "Outros", description: "Apple — assinatura", isRecurring: true, posted: true },
  { key: "pedro", date: "2026-10-10", amount: "16.00", category: "Outros", description: "Pedro Henrique — compra não identificada (finalidade desconhecida)", isRecurring: false, posted: true },
  { key: "wellhub", date: "2026-10-11", amount: "69.99", category: "Saúde", description: "Wellhub — Ricardo", isRecurring: true, posted: true },
  // Rei do Pernil: real e incorrida, mas AINDA não postada na fatura observada (fica fora do observedTotal; dentro do limite usado).
  { key: "rei-do-pernil", date: "2026-10-12", amount: "100.00", category: "Alimentação", description: "Lanchonete Rei do Pernil", isRecurring: false, posted: false },
];
export const DUCATI = { key: "ducati", description: "Conserto da Ducati — Jim.com", purchasedAt: "2026-10-09", count: 3, first: "2026-11", total: "319.56", value: "106.52", category: "Transporte" };
export const OTHER_COSTS_GAP = "4.11"; // "Outros custos" do app Itaú: custo bancário confirmado, sem detalhe individual — NÃO vira compra inventada.

// ----------------------------------------------------------------------------- planner
export async function buildCatchup106Plan({ client } = {}) {
  if (!client) throw new Error("client é obrigatório");
  const operations = [];
  const warnings = [];
  const blockers = [];
  const op = (o) => operations.push({ id: `op${String(operations.length + 1).padStart(2, "0")}`, ...o });

  const [itau, caju, dinheiro, card] = await Promise.all([
    client.account.findFirst({ where: { slug: "itau" } }),
    client.account.findFirst({ where: { slug: "vale-alimentacao" } }),
    client.account.findFirst({ where: { slug: "dinheiro" } }),
    client.card.findFirst({ orderBy: { createdAt: "asc" } }),
  ]);
  if (!itau || !caju || !dinheiro || !card) {
    blockers.push("Conta Itaú, Caju, Dinheiro ou cartão Itaú não encontrados.");
    return { operations, balancesBefore: null, balancesProjected: null, warnings, blockers };
  }
  const anchorOf = (acc) => client.balanceAdjustment.findFirst({ where: { accountId: acc.id }, orderBy: { occurredAt: "desc" } });
  const [itauAnchor, cajuAnchor, cashAnchor] = await Promise.all([anchorOf(itau), anchorOf(caju), anchorOf(dinheiro)]);
  const balancesBefore = { itau: fmt(await computeAccountBalance(itau.id, { client })), caju: fmt(await computeAccountBalance(caju.id, { client })), dinheiro: fmt(await computeAccountBalance(dinheiro.id, { client })) };
  const counts = (anchor, date) => !anchor || isAfterAnchor(date, anchor.occurredAt);
  let itauDelta = money(0);
  let cajuDelta = money(0);
  const addItau = (v, date) => { if (counts(itauAnchor, date)) itauDelta = addMoney(itauDelta, v); };
  const addCaju = (v, date) => { if (counts(cajuAnchor, date)) cajuDelta = addMoney(cajuDelta, v); };

  // ---------- 0) Energia (conta da casa): pagamento pelo MESMO caminho do app (Bill + Expense), nunca uma despesa solta
  const energyRule = await client.recurringRule.findFirst({ where: { name: "Energia", kind: "expense" } });
  const energyBill = energyRule ? await client.bill.findFirst({ where: { recurringRuleId: energyRule.id, cycleMonth: "2026-10", part: 1 } }) : null;
  if (!energyRule) blockers.push("Regra 'Energia' não encontrada.");
  else if (energyBill && energyBill.status !== "paid") blockers.push(`Bill de Energia 2026-10 existe com status ${energyBill.status} — conferir.`);
  else if (energyRule && !energyBill) {
    addItau(money("-359.96"), day("2026-10-13"));
    op({ section: "house", kind: "PAY_HOUSE_BILL", description: "CEMIG R$ 359,96 em 13/10 = Energia 2026-10 PAGA (Bill + despesa pelo caminho do app)", target: { model: "bill", ruleId: energyRule.id, cycleMonth: "2026-10", part: 1 }, data: { amount: "359.96", paidAt: "2026-10-13", accountId: itau.id }, effect: { itau: "-359.96" }, preconditions: { ruleId: energyRule.id, noBillForCycle: "2026-10" } });
  }

  // ---------- 1) pagamento da fatura de outubro: corrige 1.795,77 → 1.677,43, crédito do estorno e conciliação com a linha bancária
  const octBill = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth: "2026-10" } } });
  if (!octBill) blockers.push("CardBill 2026-10 não encontrada.");
  else {
    const payments = await client.transfer.findMany({ where: { cardBillId: octBill.id, kind: "card_bill_payment" } });
    const pay = payments.find((p) => String(p.rawMessage ?? "").startsWith(PAYMENT_KEY_PREFIX));
    if (!pay) blockers.push("Pagamento da fatura de outubro (settlement da 10.5) não encontrado.");
    else {
      if (same(pay.amount, TARGETS.octPayment)) {
        /* já corrigido */
      } else if (same(pay.amount, TARGETS.octTotal)) {
        addItau(money(TARGETS.octTotal).minus(TARGETS.octPayment), pay.occurredAt);
        op({ section: "card", kind: "CORRECT_CARD_BILL_PAYMENT", description: `Corrigir o pagamento REAL da fatura de outubro: R$ 1.795,77 → R$ 1.677,43 (banco: 08/10 FATURA PAGA ITAU PLATINUM). Total histórico da fatura segue 1.795,77`, target: { model: "transfer", id: pay.id, cardBillId: octBill.id }, from: { amount: "1795.77" }, to: { amount: TARGETS.octPayment }, effect: { itau: "+118.34" }, preconditions: { transferId: pay.id, currentAmount: "1795.77", billId: octBill.id, billStatus: octBill.status, billPaidAmount: octBill.paidAmount?.toString() ?? null, billTotal: octBill.totalAmount.toString() } });
      } else blockers.push(`Pagamento da fatura de outubro com valor inesperado (${pay.amount}); esperado 1.795,77 ou 1.677,43.`);
      // conciliação com a linha bancária (mesma função do fluxo real de import)
      const reconciled = /\|bank=/.test(pay.rawMessage ?? "");
      if (!reconciled) op({ section: "card", kind: "RECONCILE_PAYMENT_BANK_LINE", description: "Concilia o pagamento corrigido (1.677,43) com a linha bancária de 08/10 'FATURA PAGA ITAU PLATINUM' — 1 settlement, 1 débito bancário, sem 2ª saída", target: { model: "transfer", id: pay.id }, data: { accountId: itau.id, amount: TARGETS.octPayment, date: "2026-10-08", reference: "FATURA PAGA ITAU PLATINUM @2026-10-08 1677.43" }, preconditions: { transferId: pay.id, expectedAmountAfterCorrection: TARGETS.octPayment } });
    }
    const credits = await client.cardCreditMovement.findMany({ where: { cardId: card.id, note: { startsWith: `${PLAN_TAG}:` } } });
    const portao = await client.purchase.findFirst({ where: { cardId: card.id, description: { contains: "portão", mode: "insensitive" } } });
    if (!portao) blockers.push("Compra 'Controle do portão' não encontrada (estorno não teria a quem se vincular).");
    if (!credits.some((c) => c.kind === "CREDIT_GRANTED")) op({ section: "card", kind: "ADD_CARD_CREDIT", description: "Crédito/estorno de R$ 118,34 (05/10, MercadoLivre*shopantenas) = devolução INTEGRAL do Controle do portão. Compra e parcelas permanecem (2/2 de 59,17 segue no cronograma)", target: { model: "cardCreditMovement", cardId: card.id }, data: { kind: "CREDIT_GRANTED", amount: TARGETS.octCredit, occurredAt: "2026-10-05", cardBillId: octBill.id, note: `${PLAN_TAG}:credit-granted | estorno do Controle do portão (Purchase ${portao?.id ?? "?"}) — crédito integral 118,34 em 05/10` }, preconditions: { absent: { cardId: card.id, notePrefix: `${PLAN_TAG}:credit-granted` } } });
    if (!credits.some((c) => c.kind === "CREDIT_APPLIED")) op({ section: "card", kind: "ADD_CARD_CREDIT", description: "Crédito de R$ 118,34 aplicado na fatura de outubro (liquidada: 1.677,43 em dinheiro + 118,34 em crédito = 1.795,77)", target: { model: "cardCreditMovement", cardId: card.id }, data: { kind: "CREDIT_APPLIED", amount: TARGETS.octCredit, occurredAt: "2026-10-08", cardBillId: octBill.id, linkPayment: true, note: `${PLAN_TAG}:credit-applied | crédito do estorno aplicado à fatura 2026-10` }, preconditions: { absent: { cardId: card.id, notePrefix: `${PLAN_TAG}:credit-applied` } } });
  }

  // ---------- 2) Cofrinho Itaú / Tattoo: transferência para dinheiro protegido (NÃO despesa)
  const cofrinho = await client.account.findFirst({ where: { slug: "cofrinho-itau" } });
  if (!cofrinho) op({ section: "tattoo", kind: "ADD_ACCOUNT", description: "Conta 'Cofrinho Itaú' (type savings): o dinheiro do Cofrinho está FORA do saldo da conta corrente, então não entra no caixa livre; a Reserve exige uma conta (accountId obrigatório)", target: { model: "account" }, data: { slug: "cofrinho-itau", name: "Cofrinho Itaú", type: "savings" }, preconditions: { absentSlug: "cofrinho-itau" } });
  const cofrinhoTransfer = cofrinho ? await client.transfer.findFirst({ where: { toAccountId: cofrinho.id, rawMessage: { startsWith: `${PLAN_TAG}:cofrinho-tattoo` } } }) : null;
  if (!cofrinhoTransfer) {
    addItau(money("-150"), day("2026-10-08"));
    op({ section: "tattoo", kind: "ADD_TRANSFER", description: "APLICAÇÃO COFRINHOS −R$ 150,00 (08/10): Itaú → Cofrinho Itaú (Tattoo). Dinheiro guardado, NÃO é despesa", target: { model: "transfer" }, data: { amount: "150.00", occurredAt: "2026-10-08", fromSlug: "itau", toSlug: "cofrinho-itau", description: "Aplicação no Cofrinho Itaú — reserva Tattoo (NÃO é despesa)", rawMessage: `${PLAN_TAG}:cofrinho-tattoo | APLICACAO COFRINHOS` }, effect: { itau: "-150.00" }, preconditions: { absent: { rawMessagePrefix: `${PLAN_TAG}:cofrinho-tattoo` } } });
  }
  const reserve = cofrinho ? await client.reserve.findFirst({ where: { accountId: cofrinho.id, name: "Tattoo" } }) : null;
  if (!reserve) op({ section: "tattoo", kind: "ADD_RESERVE", description: "Reserve 'Tattoo' (meta R$ 2.635,00) no Cofrinho Itaú", target: { model: "reserve" }, data: { name: "Tattoo", targetAmount: TARGETS.goalTarget, accountSlug: "cofrinho-itau" }, preconditions: { absentReserve: "Tattoo" } });
  const reserveMoves = reserve ? await client.reserveMovement.findMany({ where: { reserveId: reserve.id } }) : [];
  if (!reserveMoves.some((m) => m.kind === "ALLOCATE" && same(m.amount, "150"))) op({ section: "tattoo", kind: "ADD_RESERVE_MOVEMENT", description: "ReserveMovement ALLOCATE R$ 150,00 (08/10) — Tattoo", target: { model: "reserveMovement" }, data: { kind: "ALLOCATE", amount: "150.00", occurredAt: "2026-10-08", note: `${PLAN_TAG}:tattoo | venda da cortina guardada no Cofrinho`, reserveName: "Tattoo" }, preconditions: { absentMovement: { reserveName: "Tattoo", kind: "ALLOCATE", amount: "150.00" } } });
  const goal = await client.goal.findFirst({ where: { name: { contains: "Tattoo", mode: "insensitive" } } });
  if (!goal) blockers.push("Meta Tattoo não encontrada.");
  else if (!same(goal.savedAmount, "150")) op({ section: "tattoo", kind: "UPDATE_GOAL_SAVED", description: `Meta Tattoo: guardado R$ ${fmt(goal.savedAmount)} → R$ 150,00 de R$ 2.635,00 (valor espelha a Reserve; a Reserve é a fonte do dinheiro protegido)`, target: { model: "goal", id: goal.id }, from: { savedAmount: goal.savedAmount.toString() }, to: { savedAmount: "150.00" }, preconditions: { goalId: goal.id, currentSaved: goal.savedAmount.toString() } });

  // ---------- 3) lançamentos do Itaú e do Caju
  async function ledgerItems(account, anchor, items, who) {
    for (const it of items) {
      const model = it.kind === "income" ? "income" : "expense";
      const exists = await client[model].findFirst({ where: { accountId: account.id, OR: [{ rawMessage: { startsWith: `${PLAN_TAG}:${it.key}` } }, { occurredAt: { gte: day(it.date), lt: nextDay(it.date) }, amount: it.amount }] } });
      if (exists) continue;
      const signed = it.kind === "income" ? money(it.amount) : money(it.amount).neg();
      if (who === "itau") addItau(signed, day(it.date));
      else addCaju(signed, day(it.date));
      const raw = `${PLAN_TAG}:${it.key}${it.ref ? ` | referência do extrato ${it.ref} (lote bancário ${it.date})` : ""}`;
      op({ section: who, kind: it.kind === "income" ? "ADD_INCOME" : "ADD_EXPENSE", description: `${it.kind === "income" ? "+" : "−"}R$ ${it.amount} em ${it.date}${it.ref ? ` (ref ${it.ref})` : ""}: ${it.description}`, target: { model, accountId: account.id }, data: { amount: it.amount, occurredAt: it.date, description: it.description, category: it.category, source: "manual", confidence: "CONFIRMED", rawMessage: raw, isRecurring: false }, effect: { [who]: `${it.kind === "income" ? "+" : "-"}${it.amount}` }, preconditions: { absent: { model, accountId: account.id, marker: `${PLAN_TAG}:${it.key}`, day: it.date, amount: it.amount } } });
    }
  }
  await ledgerItems(itau, itauAnchor, ITAU_ITEMS, "itau");

  // Bia reembolsou R$ 29 do lanche (12/10): Receivable RECEIVED + Income de reembolso (NÃO é renda)
  const biaRec = await client.receivable.findFirst({ where: { notes: { startsWith: `${PLAN_TAG}:bia-29` } } });
  if (!biaRec) {
    addItau(money("29"), day("2026-10-12"));
    op({ section: "itau", kind: "ADD_RECEIVABLE_RECEIVED", description: "Reembolso da Bia R$ 29,00 (12/10): Receivable RECEIVED + Income 'Reembolso' — parte dela no lanche Rei do Pernil (R$ 100 seguem como compra no cartão). NÃO é renda", target: { model: "receivable" }, data: { counterparty: "Ana Beatriz", description: "Reembolso da Bia — parte do lanche Rei do Pernil", amount: "29.00", receivedAt: "2026-10-12", accountId: itau.id, category: "Outros", incomeDescription: "Reembolso Ana Beatriz — parte do lanche Rei do Pernil (NÃO é renda)", notes: `${PLAN_TAG}:bia-29 | Pix de 29,00 referência 12/10 (lote bancário 13/10)` }, effect: { itau: "+29.00" }, preconditions: { absent: { notesPrefix: `${PLAN_TAG}:bia-29` } } });
  }

  // ---------- 4) CNPJ: compromisso de R$ 1.335 deixa de ser FUNDED (sem liquidar) + recebível Tiny R$ 65,90
  const cnpj = await client.confirmedCommitment.findFirst({ where: { description: { startsWith: "Devolver valor restante ao CNPJ" } } });
  if (!cnpj) blockers.push("Compromisso 'Devolver valor restante ao CNPJ' não encontrado.");
  else if (cnpj.status === "FUNDED") op({ section: "cnpj", kind: "UNFUND_COMMITMENT", description: "Compromisso CNPJ R$ 1.335,00: FUNDED → CONFIRMED (o dinheiro separado não existe mais: Itaú 12,28 + Dinheiro 181,00). Não liquida, não reduz, sem vencimento inventado", target: { model: "confirmedCommitment", id: cnpj.id }, from: { status: "FUNDED", fundingAccountId: cnpj.fundingAccountId }, to: { status: "CONFIRMED", fundingAccountId: null, fundedAt: null, dueDate: null, amount: "1335.00" }, data: { notes: "Valor que o usuário pretende devolver ao CNPJ (R$ 1.335,00). NÃO está mais separado/funded: em 13/10 o Itaú tem R$ 12,28 e o Dinheiro R$ 181,00. Ainda não pago. Sem prazo definido pelo usuário (nenhuma data inventada). Não compensar com o recebível do Tiny (relações distintas)." }, preconditions: { commitmentId: cnpj.id, status: "FUNDED", amount: cnpj.amount.toString(), settlementMode: cnpj.settlementMode, fundingAccountId: cnpj.fundingAccountId } });
  else if (cnpj.status !== "CONFIRMED") blockers.push(`Compromisso CNPJ em status inesperado: ${cnpj.status}.`);
  const tinyRec = await client.receivable.findFirst({ where: { notes: { startsWith: `${PLAN_TAG}:tiny-65.90` } } });
  if (!tinyRec) op({ section: "cnpj", kind: "ADD_RECEIVABLE", description: "Recebível do CNPJ R$ 65,90 (PENDING, sem data): reembolso da cobrança Tiny ERP paga no cartão pessoal. NÃO é renda; NÃO netado contra os R$ 1.335 devidos ao CNPJ", target: { model: "receivable" }, data: { counterparty: "CNPJ / Zerk Commerce", description: "Reembolso Tiny ERP — cobrança empresarial paga no cartão pessoal", amount: "65.90", expectedDate: null, notes: `${PLAN_TAG}:tiny-65.90 | duas relações distintas: usuário→CNPJ 1.335,00 e CNPJ→usuário 65,90` }, preconditions: { absent: { notesPrefix: `${PLAN_TAG}:tiny-65.90` } } });

  // ---------- 5) Caju
  await ledgerItems(caju, cajuAnchor, CAJU_ITEMS, "caju");

  // ---------- 6) cartão Itaú: novembro (observação 1.060,46), compras reais, Ducati 3x, limite
  const novBill = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth: "2026-11" } } });
  if (!novBill) blockers.push("CardBill 2026-11 não encontrada.");
  const { start: novStart, end: novEnd } = getCardBillPeriod(card, "2026-11");
  const calcNow = async () => {
    const [e, i] = await Promise.all([
      client.expense.aggregate({ where: { cardId: card.id, occurredAt: { gte: novStart, lt: novEnd } }, _sum: { amount: true } }),
      client.installment.aggregate({ where: { billMonth: "2026-11", purchase: { cardId: card.id } }, _sum: { amount: true } }),
    ]);
    return addMoney(money(e._sum.amount), money(i._sum.amount));
  };
  const calcBefore = await calcNow();
  let calcPlanned = calcBefore; // projeção do calculado depois do plano
  const postedExisting = [];
  const newCardExpenses = [];
  for (const e of CARD_EXPENSES) {
    const exists = await client.expense.findFirst({ where: { cardId: card.id, OR: [{ rawMessage: { startsWith: `${PLAN_TAG}:card-${e.key}` } }, { occurredAt: { gte: day(e.date), lt: nextDay(e.date) }, amount: e.amount }] } });
    if (exists) { postedExisting.push(e.key); continue; }
    newCardExpenses.push(e);
  }
  const ducatiExists = (await client.purchase.findMany({ where: { cardId: card.id } })).some((p) => (p.rawMessage ?? "").startsWith(`${PLAN_TAG}:card-${DUCATI.key}`) || (dayKey(p.purchasedAt) === DUCATI.purchasedAt && same(p.installmentValue, DUCATI.value) && p.installmentCount === 3));
  const latestObs = novBill ? await client.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: "2026-11" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }) : null;
  const obsDone = !!latestObs && same(latestObs.observedTotal, TARGETS.novObserved);
  // calculado NO MOMENTO da observação = tudo que já estava postado (sem a compra de 12/10)
  const postedNew = newCardExpenses.filter((e) => e.posted);
  let calcAtObservation = calcBefore;
  for (const e of postedNew) calcAtObservation = addMoney(calcAtObservation, e.amount);
  if (!ducatiExists) calcAtObservation = addMoney(calcAtObservation, DUCATI.value);
  if (obsDone) calcAtObservation = money(latestObs.calculatedTotal); // observação já gravada: o calculado FOI congelado nela
  if (!obsDone && novBill) op({ section: "card", kind: "RECORD_CARD_BILL_OBSERVATION", description: `Observação oficial da fatura de NOVEMBRO em 13/10: R$ 1.060,46 (OPEN, não paga). Detalhe conhecido ${fmt(calcAtObservation)} + 'Outros custos' ${OTHER_COSTS_GAP} (custo bancário confirmado, sem compra inventada). Instante = último dia POSTADO (11/10): a compra de 12/10 fica fora do observado`, target: { model: "cardBillReconciliation", cardId: card.id }, data: { cycleMonth: "2026-11", observedTotal: TARGETS.novObserved, calculatedTotal: fmt(calcAtObservation), delta: fmt(subtractMoney(TARGETS.novObserved, calcAtObservation)), occurredAt: BILL_OBSERVED_AT, confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: `${PLAN_TAG}:card-bill-nov`, note: "Fatura de novembro observada no app do Itaú em 13/10/2026: R$ 1.060,46 (inclui R$ 571,79 de parcelas já contratadas + R$ 488,67 de lançamentos novos, dos quais R$ 4,11 'Outros custos' sem detalhe individual). A compra de 12/10 (Rei do Pernil, R$ 100) ainda não estava postada e NÃO está neste total." }, preconditions: { cardId: card.id, cycleMonth: "2026-11", noObservationWithTotal: TARGETS.novObserved } });
  for (const e of newCardExpenses) {
    calcPlanned = addMoney(calcPlanned, e.amount);
    op({ section: "card", kind: "ADD_CARD_EXPENSE", description: `Compra real no cartão ${e.date} R$ ${e.amount}: ${e.description}${e.posted ? "" : " (já incorrida, FORA do observedTotal)"}`, target: { model: "expense", cardId: card.id }, data: { amount: e.amount, occurredAt: e.date, description: e.description, category: e.category, isRecurring: e.isRecurring, source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:card-${e.key} | fatura Itaú 13/10/2026${e.posted ? "" : " | NÃO postada na fatura observada"}`, posted: e.posted }, preconditions: { absent: { cardId: card.id, marker: `${PLAN_TAG}:card-${e.key}`, day: e.date, amount: e.amount } } });
  }
  const plannedRows = [];
  if (!ducatiExists) {
    calcPlanned = addMoney(calcPlanned, DUCATI.value);
    const rows = [1, 2, 3].map((n) => ({ number: n, amount: DUCATI.value, billMonth: addMonthKey(DUCATI.first, n - 1) }));
    rows.forEach((r) => plannedRows.push({ billMonth: r.billMonth, amount: r.amount }));
    op({ section: "card", kind: "ADD_PURCHASE_WITH_INSTALLMENTS", description: "Conserto da Ducati (Jim.com, 09/10): R$ 319,56 em 3x de R$ 106,52 — nov/26, dez/26, jan/27", target: { model: "purchase", cardId: card.id }, data: { description: DUCATI.description, totalAmount: DUCATI.total, installmentCount: 3, installmentValue: DUCATI.value, firstInstallmentMonth: DUCATI.first, startingInstallmentNumber: 1, purchasedAt: DUCATI.purchasedAt, category: DUCATI.category, confidence: "CONFIRMED", rows, rawMessage: `${PLAN_TAG}:card-${DUCATI.key}` }, preconditions: { absent: { cardId: card.id, marker: `${PLAN_TAG}:card-${DUCATI.key}`, purchasedDay: DUCATI.purchasedAt, value: DUCATI.value, count: 3 } } });
  }
  // futuras (somente leitura + linhas planejadas)
  const installmentRows = await client.installment.findMany({ where: { purchase: { cardId: card.id }, billMonth: { gte: "2026-12" } }, select: { billMonth: true, amount: true } });
  const byMonth = {};
  for (const r of [...installmentRows, ...plannedRows.filter((x) => x.billMonth >= "2026-12")]) byMonth[r.billMonth] = addMoney(byMonth[r.billMonth] ?? money(0), r.amount);
  const dec = fmt(byMonth["2026-12"] ?? 0), jan = fmt(byMonth["2027-01"] ?? 0), feb = fmt(byMonth["2027-02"] ?? 0);
  const futureTotal = fmt(addMoney(addMoney(dec, jan), feb));
  const bills = await client.cardBill.findMany({ where: { cardId: card.id } });
  for (const b of bills) {
    if (b.status === "paid") continue;
    const projected = b.cycleMonth === "2026-11" ? fmt(calcPlanned) : b.cycleMonth >= "2026-12" ? fmt(byMonth[b.cycleMonth] ?? 0) : null;
    if (projected == null) continue;
    if (!same(b.totalAmount, projected)) op({ section: "card", kind: "SYNC_CARD_BILL_ROW", description: `CardBill ${b.cycleMonth}: total persistido ${b.totalAmount} → ${projected} (o CALCULADO; o observado fica na observação)`, target: { model: "cardBill", id: b.id }, from: { totalAmount: b.totalAmount.toString() }, data: { totalAmount: projected }, preconditions: { billId: b.id, currentTotal: b.totalAmount.toString(), currentStatus: b.status } });
  }
  const latestLimit = await client.cardLimitUpdate.findFirst({ where: { cardId: card.id }, orderBy: { occurredAt: "desc" } });
  if (!(latestLimit && same(latestLimit.newUsedLimit, TARGETS.limit.used) && same(latestLimit.reportedAvailable ?? 0, TARGETS.limit.available))) op({ section: "card", kind: "RECORD_CARD_LIMIT_OBSERVATION", description: "Snapshot do limite em 13/10: total 5.087,00 · disponível 3.465,22 · utilizado 1.621,78 (= fatura 1.060,46 + parcelas futuras 461,32 + compra pendente 100,00). Histórico anterior preservado", target: { model: "cardLimitUpdate", cardId: card.id }, data: { newTotalLimit: TARGETS.limit.total, newUsedLimit: TARGETS.limit.used, reportedAvailable: TARGETS.limit.available, occurredAt: LIMIT_OBSERVED_AT, rawMessage: `${PLAN_TAG}:card-limit` }, preconditions: { cardId: card.id, noLimitObservationWithUsed: TARGETS.limit.used } });

  // ---------- 7) Repasses do Caju (obrigação interna Caju → Itaú; NÃO altera saldo enquanto PENDING)
  // antes da migration aditiva a tabela ainda não existe na PROD: trata como vazia (o executor exige a migration aplicada)
  let existingReimb = [];
  let reimbTableMissing = false;
  try { existingReimb = await client.internalReimbursement.findMany({ where: { fromAccountId: caju.id } }); } catch (e) { if (/does not exist|P2021|InternalReimbursement/i.test(String(e?.message ?? e))) reimbTableMissing = true; else throw e; }
  if (reimbTableMissing) warnings.push("Tabela InternalReimbursement ainda não existe nesta base: a migration aditiva 20261013120000 precisa ser aplicada antes do executor.");
  const lazariExp = await client.expense.findFirst({ where: { accountId: itau.id, rawMessage: { startsWith: "FASE104-CATCHUP:20260930-pedro-lazari" } } });
  if (!lazariExp) warnings.push("Gasto original do lanche Lazari (30/09) não encontrado: o repasse será criado sem vínculo ao gasto de origem.");
  if (!existingReimb.some((r) => String(r.notes ?? "").startsWith(`${PLAN_TAG}:lazari`))) op({ section: "reimbursements", kind: "ADD_INTERNAL_REIMBURSEMENT", description: "Repasse Caju → Itaú R$ 29,50 PENDENTE — lanche Lazari (30/09) pago pelo Itaú, deveria ter sido o Caju", target: { model: "internalReimbursement" }, data: { amount: "29.50", description: "Lanche Lazari — 30/09", sourceLabel: "Pedro / Lazari — lanche (30/09, pago pelo Itaú)", sourceExpenseMarker: "FASE104-CATCHUP:20260930-pedro-lazari", notes: `${PLAN_TAG}:lazari | deveria ter sido pago pelo Caju` }, preconditions: { absent: { notesPrefix: `${PLAN_TAG}:lazari` } } });
  if (!existingReimb.some((r) => String(r.notes ?? "").startsWith(`${PLAN_TAG}:rei-do-pernil`))) op({ section: "reimbursements", kind: "ADD_INTERNAL_REIMBURSEMENT", description: "Repasse Caju → Itaú R$ 71,00 PENDENTE — Rei do Pernil (R$ 100 no cartão − R$ 29 reembolsados pela Bia)", target: { model: "internalReimbursement" }, data: { amount: "71.00", description: "Rei do Pernil — sua parte (100 − 29 da Bia)", sourceLabel: "Lanchonete Rei do Pernil — R$ 100,00 no cartão (12/10)", sourceExpenseMarker: `${PLAN_TAG}:card-rei-do-pernil`, notes: `${PLAN_TAG}:rei-do-pernil | R$ 100 no cartão; Bia reembolsou R$ 29; parte do usuário R$ 71 deveria sair do Caju` }, preconditions: { absent: { notesPrefix: `${PLAN_TAG}:rei-do-pernil` } } });

  // ---------- 8) saldos projetados e âncoras de reconciliação (só o resíduo que NENHUMA linha real explica)
  const itauLedger = addMoney(balancesBefore.itau, itauDelta);
  const cajuLedger = addMoney(balancesBefore.caju, cajuDelta);
  const cashLedger = money(balancesBefore.dinheiro);
  const itauAdj = subtractMoney(TARGETS.itau, itauLedger);
  const cajuAdj = subtractMoney(TARGETS.caju, cajuLedger);
  const cashAdj = subtractMoney(TARGETS.dinheiro, cashLedger);
  const recon = (acc, target, adj, ledger, note, extra = {}) =>
    op({ section: acc.slug, kind: "ADD_BALANCE_RECONCILIATION", description: `Âncora de reconciliação ${acc.name}: ledger projetado ${fmt(ledger)} → saldo autoritativo ${target} (ajuste ${fmt(adj)}; RECONCILIATION_ADJUSTMENT, nunca Expense/Income)`, target: { model: "balanceAdjustment", accountId: acc.id }, data: { newBalance: target, confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: ANCHOR_AT, rawMessage: `${PLAN_TAG}:${acc.slug}-recon`, note }, effect: { adjustment: fmt(adj) }, preconditions: { accountId: acc.id, targetBalance: target, expectedAdjustment: fmt(adj), expectedLedgerAfterLines: fmt(ledger), requiresNoRealLineExplains: true, ...extra } });
  if (!itauAdj.isZero()) recon(itau, TARGETS.itau, itauAdj, itauLedger, "Reconciliação Itaú (extrato até 13/10): após todas as linhas itemizadas o ledger fica 0,06 acima do saldo informado pelo banco (12,28); resíduo de centavos sem linha real correspondente (observação anterior de 2.490,38 preservada).");
  if (!cajuAdj.isZero()) recon(caju, TARGETS.caju, cajuAdj, cajuLedger, "Reconciliação Caju: movimentos narrados somam 282,02 (esperado 248,87) mas o app mostra 248,46 — diferença de −0,41 sem movimento real correspondente.");
  if (!cashAdj.isZero()) recon(dinheiro, TARGETS.dinheiro, cashAdj, cashLedger, "Contagem física de 13/10: R$ 181,00 em mãos. A trilha dos R$ 154,00 consumidos não é conhecida — NÃO se inventam despesas em espécie.");
  const balancesProjected = { itauLedger: fmt(itauLedger), itauAdjustment: fmt(itauAdj), itau: TARGETS.itau, cajuLedger: fmt(cajuLedger), cajuAdjustment: fmt(cajuAdj), caju: TARGETS.caju, dinheiroLedger: fmt(cashLedger), dinheiroAdjustment: fmt(cashAdj), dinheiro: TARGETS.dinheiro };
  if (!itauAdj.isZero()) warnings.push(`Itaú: resíduo de centavos ${fmt(itauAdj)} após todas as linhas ⇒ RECONCILIATION_ADJUSTMENT (observação anterior preservada).`);

  // ---------- 9) checkpoints
  const sum = (arr) => arr.reduce((a, v) => addMoney(a, v), money(0));
  const novPostedNew = sum([...CARD_EXPENSES.filter((e) => e.posted).map((e) => e.amount), DUCATI.value, OTHER_COSTS_GAP]);
  const limitUsed = sum([TARGETS.novObserved, TARGETS.futureTotal, "100.00"]);
  const checkpoints = [
    { name: "novembro: 571,79 + 488,67 = 1.060,46", expected: TARGETS.novObserved, actual: fmt(addMoney(TARGETS.novProjectedInstallments, TARGETS.novNewPosted)) },
    { name: "novos lançamentos postados de novembro (itens + Ducati 1/3 + outros custos) = 488,67", expected: TARGETS.novNewPosted, actual: fmt(novPostedNew) },
    { name: "novembro: calculado projetado (sem a compra de 12/10) + 'outros custos' = observado", expected: TARGETS.novObserved, actual: fmt(addMoney(calcAtObservation, OTHER_COSTS_GAP)) },
    { name: "futuras dez + jan + fev = 461,32", expected: TARGETS.futureTotal, actual: futureTotal },
    { name: "dezembro = 200,36", expected: "200.36", actual: dec },
    { name: "janeiro = 200,36", expected: "200.36", actual: jan },
    { name: "fevereiro = 60,60", expected: "60.60", actual: feb },
    { name: "limite utilizado = fatura 1.060,46 + futuras 461,32 + compra pendente 100,00", expected: TARGETS.limit.used, actual: fmt(limitUsed) },
    { name: "limite disponível = total − utilizado", expected: TARGETS.limit.available, actual: fmt(subtractMoney(TARGETS.limit.total, TARGETS.limit.used)) },
    { name: "outubro: 1.795,77 − 118,34 = 1.677,43", expected: TARGETS.octPayment, actual: fmt(subtractMoney(TARGETS.octTotal, TARGETS.octCredit)) },
    { name: "Itaú projetado = banco", expected: TARGETS.itau, actual: fmt(addMoney(itauLedger, itauAdj)) },
    { name: "Caju projetado = app (ledger + ajuste)", expected: TARGETS.caju, actual: fmt(addMoney(cajuLedger, cajuAdj)) },
    { name: "Dinheiro projetado = contagem física (ledger + ajuste)", expected: TARGETS.dinheiro, actual: fmt(addMoney(cashLedger, cashAdj)) },
    { name: "Caju: 530,89 − 282,02 = 248,87 (antes do ajuste de −0,41); depois de aplicado o ledger já é 248,46", expected: cajuAdj.isZero() ? TARGETS.caju : "248.87", actual: fmt(cajuLedger) },
    { name: "repasses do Caju: 29,50 + 71,00 = 100,50; após repasses 148,… = 147,96", expected: TARGETS.cajuAfter, actual: fmt(subtractMoney(TARGETS.caju, TARGETS.cajuReimbursements)) },
  ].map((c) => ({ ...c, ok: same(c.expected, c.actual) }));
  for (const c of checkpoints) if (!c.ok) blockers.push(`Checkpoint falhou: ${c.name} (esperado ${c.expected}, obtido ${c.actual})`);

  return {
    operations,
    balancesBefore,
    balancesProjected,
    card: { octoberTotal: TARGETS.octTotal, octoberCredit: TARGETS.octCredit, octoberPaymentTarget: TARGETS.octPayment, novObservedTarget: TARGETS.novObserved, novCalculatedAtObservation: fmt(calcAtObservation), novCalculatedAfterPlan: fmt(calcPlanned), novKnownGap: OTHER_COSTS_GAP, futureDec: dec, futureJan: jan, futureFeb: feb, futureTotal, pendingIncurred: "100.00", limit: TARGETS.limit },
    tattoo: { goalBefore: goal ? { saved: goal.savedAmount.toString(), target: goal.targetAmount.toString() } : null, plan: "Cofrinho Itaú (conta savings) + Reserve Tattoo + ALLOCATE 150 + Goal.saved 150", reserveBalance: TARGETS.tattoo },
    cnpj: { payableBefore: cnpj ? { status: cnpj.status, amount: cnpj.amount.toString(), funding: cnpj.fundingAccountId ? "Itaú" : null } : null, payableAfter: { status: "CONFIRMED", amount: TARGETS.cnpjPayable, funded: false, dueDate: null }, receivable: { amount: TARGETS.tinyReceivable, status: "PENDING" } },
    reimbursements: { lazari: "29.50", reiDoPernil: "71.00", total: TARGETS.cajuReimbursements, cajuBalance: TARGETS.caju, availableAfter: TARGETS.cajuAfter },
    checkpoints,
    warnings,
    blockers,
  };
}
