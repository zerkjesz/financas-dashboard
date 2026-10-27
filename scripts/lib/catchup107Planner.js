// Fase 10.7 — PLANNER 100% SOMENTE LEITURA do catch-up 14/10 → 27/10 (Itaú, Caju, Dinheiro, Cofrinho/Tattoo, cartão Itaú, Tattoo 1 na mãe).
//
// Estado-base: PROD depois da Fase 10.6 (Itaú 12,28 · Caju 248,46 · Dinheiro 181,00 · Cofrinho 150,00 · repasses 100,50 PENDING).
// Recorte: tudo o que é real até 27/10/2026. Eventos FUTUROS ficam de fora (casaco R$245 de 28/10, envio de R$438 à mãe, segunda tattoo R$1.650).
// Idempotência: cada fase aplicada é reconhecida por MARCADORES (FASE107-CATCHUP:…) — não pelo "último valor" — para que movimentos legítimos
// posteriores (ex.: a liquidação de um repasse, uma compra nova) nunca reabram o plano. Sobre o estado aplicado, operations.length = 0.
import { money, addMoney, subtractMoney } from "../../lib/money.js";
import { computeAccountBalance } from "../../lib/accounts.js";
import { getCardBillPeriod } from "../../lib/cardCycle.js";
import { isAfterAnchor } from "../../lib/anchorOrdering.js";
import { zonedInstant } from "./catchup106Planner.js";

export const PLAN_TAG = "FASE107-CATCHUP";

// MODELO DE ÂNCORA (mesmo da 10.6): saldo observado EM UM INSTANTE. As reconciliações sem horário bancário conhecido usam o INSTANTE REAL da
// execução. Única exceção: a revisão do saldo de 13/10 que o banco publicou no extrato — o extrato informa o saldo FIM DO DIA 13/10, então ESSA
// âncora (e só ela) é, de fato, 13/10 23:59:59 BRT: o banco afirma "fim do dia".
export const OBSERVED_AT_POLICY = "EXECUTION_INSTANT";
export const BANK_EOD_13_10 = zonedInstant("2026-10-13", "23:59:59");
export const LATEST_LINE_DAY = "2026-10-26"; // última data-calendário incluída (extrato emitido em 27/10)
export const SOURCES_NOTE = "Fontes informadas pelo usuário (valores recebidos por narração; o sistema não releu os arquivos): export ALL_TIME do Norte de 27/10/2026, extrato oficial Itaú emitido em 27/10/2026, telas atuais da fatura Itaú, telas do Caju e explicações do usuário.";

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const dayKey = (d) => d.toISOString().slice(0, 10);
const nextDay = (s) => new Date(day(s).getTime() + 86400000);
const num = (v) => Number(v?.toString?.() ?? v);
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
const fmt = (m) => money(m).toFixed(2);

export const TARGETS = Object.freeze({
  itau: "4918.52",
  itauRevision13: "15.21",
  caju: "859.21",
  cajuRawMath: "858.81",
  dinheiro: "0.00",
  cofrinho: "193.00",
  tattoo1: { total: "1450.00", count: 10, value: "145.00" },
  salaryCredit: "5309.15",
  salaryBase: "4937.18",
  overtime: "371.97",
  novObserved: "1480.88",
  novPrevObserved: "1060.46",
  novDelta: "420.42",
  novNewItems: "320.42",
  reiDoPernil: "100.00",
  novCalculatedAfter: "1476.77",
  cajuReimbursements: "100.50",
  cajuAfterReimbursements: "758.71",
});

// ----------------------------------------------------------------------------- dados do plano
// Lançamentos do ITAÚ — datas EXATAS do extrato oficial emitido em 27/10 (nenhuma data inferida). `date` = data usada em occurredAt (econômica);
// `posted` = data de lançamento bancário quando difere da econômica (Pedro: a descrição bancária referencia 24/10; lançado em 26/10).
export const ITAU_ITEMS = [
  // 13/10 — revisão do dia (explica a âncora revisada de 15,21; datadas 13/10 ⇒ já estão dentro do saldo revisado)
  { key: "20261013-pix-futuras", date: "2026-10-13", kind: "income", amount: "2.92", category: "Outros", description: "PIX TRANSF FUTURAS — crédito de casa de apostas (entrada extraordinária; NÃO recorrente, NÃO é salário, NÃO é próxima renda)", revision: true },
  { key: "20261013-rend", date: "2026-10-13", kind: "income", amount: "0.04", category: "Outros", description: "Rendimento bancário (extrato revisado de 13/10)", revision: true },
  // 14/10
  { key: "20261014-tqj", date: "2026-10-14", kind: "income", amount: "0.12", category: "Outros", description: "TQJ-PAR — crédito de casa de apostas (entrada extraordinária; NÃO recorrente, NÃO é salário)" },
  { key: "20261014-rifa", date: "2026-10-14", kind: "expense", amount: "5.06", category: "Lazer", description: "RIVMONT PRI — rifa" },
  // 21/10
  { key: "20261021-afiliado", date: "2026-10-21", kind: "income", amount: "130.20", category: "Trabalho", description: "Comissão de afiliado — venda de um curso (SISPAG PIX AUTORIZOU INTERMEDI): renda extra, NÃO recorrente por enquanto, não altera o salário-base" },
  { key: "20261021-posto-carro", date: "2026-10-21", kind: "expense", amount: "30.00", category: "Transporte", description: "Posto São Lourenço — gasolina do carro" },
  // 22/10
  { key: "20261022-carrossel", date: "2026-10-22", kind: "expense", amount: "55.22", category: "Alimentação", description: "Carrossel — provavelmente alimentação/mercado (o usuário não lembra o item exato)", confidence: "ESTIMATED" },
  { key: "20261022-leila", date: "2026-10-22", kind: "expense", amount: "49.90", category: "Outros", description: "Leila Nogueira — ração da Catarina (pet / alimentação animal)" },
  { key: "20261022-posto-moto", date: "2026-10-22", kind: "expense", amount: "70.00", category: "Transporte", description: "Posto — gasolina da moto" },
  // 23/10 (o crédito de 5.309,15 está em SALARY)
  { key: "20261023-posto-carro", date: "2026-10-23", kind: "expense", amount: "30.00", category: "Transporte", description: "Posto — gasolina do carro" },
  { key: "20261023-pneu", date: "2026-10-23", kind: "expense", amount: "190.00", category: "Transporte", description: "Carlos Henrique — troca de pneu do carro (gasto real agora; o usuário pretende recuperar economicamente na venda do carro — sem Receivable)" },
  // 26/10
  { key: "20261024-pedro-churrasco", date: "2026-10-24", posted: "2026-10-26", kind: "expense", amount: "40.00", category: "Lazer", description: "Pedro — churrasco (data econômica 24/10, referenciada na descrição bancária; lançado no banco em 26/10)" },
  { key: "20261026-tapete", date: "2026-10-26", kind: "expense", amount: "65.98", category: "Outros", description: "PIX Marketplace — tapete higiênico para a Catarina (pet)" },
];
// Contagem: linhas do EXTRATO desde a âncora anterior = ITAU_ITEMS (14 menos o crédito do salário que é 1 linha) → ver BANK_STATEMENT_LINES_NEW abaixo.
// Crédito bancário ÚNICO de 5.309,15 em 23/10 = salário-base (ocorrência recorrente de 24/10) + hora extra (extraordinária, NÃO recorrente).
export const SALARY = { date: "2026-10-23", occurrence: "2026-10-24", base: "4937.18", overtime: "371.97", total: "5309.15" };
export const CAJU_ITEMS = [
  { key: "20261015-emporio", date: "2026-10-15", kind: "expense", amount: "16.00", category: "Alimentação", description: "Empório São Jorge — alimentação" },
  { key: "20261016-carrossel", date: "2026-10-16", kind: "expense", amount: "126.30", category: "Alimentação", description: "Carrossel — alimentação/mercado" },
  { key: "20261016-alvarez", date: "2026-10-16", kind: "expense", amount: "22.00", category: "Alimentação", description: "Panificação Alvarez — alimentação" },
  { key: "20261017-padaria", date: "2026-10-17", kind: "expense", amount: "22.30", category: "Alimentação", description: "Padaria São Lourenço — alimentação" },
  { key: "20261018-abc", date: "2026-10-18", kind: "expense", amount: "28.96", category: "Alimentação", description: "Supermercados ABC — alimentação/mercado" },
  { key: "20261018-federal", date: "2026-10-18", kind: "expense", amount: "11.50", category: "Alimentação", description: "Federal São Lourenço — alimentação" },
  { key: "20261019-adega", date: "2026-10-19", kind: "expense", amount: "17.00", category: "Alimentação", description: "Adega JJ — alimentação/bebida" },
  { key: "20261023-daniel", date: "2026-10-23", kind: "expense", amount: "55.00", category: "Alimentação", description: "Daniel Nogueira — contexto exato desconhecido (pago no Auxílio Alimentação)", confidence: "UNCERTAIN" },
  { key: "20261023-carrossel", date: "2026-10-23", kind: "expense", amount: "8.99", category: "Alimentação", description: "Carrossel — alimentação" },
  { key: "20261023-abc-atacado", date: "2026-10-23", kind: "expense", amount: "253.61", category: "Alimentação", description: "ABC Atacado e Varejo — mercado/casa" },
  { key: "20261025-carrossel", date: "2026-10-25", kind: "expense", amount: "27.99", category: "Alimentação", description: "Carrossel — alimentação/mercado" },
  { key: "20261025-peixaria", date: "2026-10-25", kind: "expense", amount: "100.00", category: "Alimentação", description: "Peixaria Esperança — alimentação" },
];
export const CAJU_RECHARGE = { key: "20261023-recarga", date: "2026-10-23", occurrence: "2026-10-21", amount: "1300.00" }; // recarga de benefício (mesma regra de setembro: banco 23, ocorrência 21)
// Compras REAIS do cartão que passaram a compor a fatura de novembro observada em 27/10 (Rei do Pernil R$100 já existe no banco desde a 10.6).
export const CARD_EXPENSES = [
  { key: "wellhub-bia", date: "2026-10-14", amount: "69.99", category: "Saúde", description: "Wellhub — Ana Beatriz", isRecurring: true },
  { key: "aleve", date: "2026-10-17", amount: "11.68", category: "Saúde", description: "Compra não identificada — Aleve Farma (estabelecimento farmacêutico; o usuário não lembra o item)", confidence: "UNCERTAIN" },
  { key: "cicaplast", date: "2026-10-20", amount: "71.52", category: "Saúde", description: "Mercado Pago / Mercado Livre — Cicaplast (cuidado da tattoo)" },
  { key: "posto-carro", date: "2026-10-20", amount: "40.00", category: "Transporte", description: "Posto São Lourenço — gasolina do carro" },
  { key: "casa-criador", date: "2026-10-20", amount: "16.90", category: "Saúde", description: "Casa do Criador — antibiótico da Catarina (saúde animal)" },
  { key: "chatgpt", date: "2026-10-25", amount: "106.60", category: "Outros", description: "OpenAI ChatGPT — assinatura (US$ 20,00; internacional)", isRecurring: true },
  { key: "iof-chatgpt", date: "2026-10-25", amount: "3.73", category: "Outros", description: "IOF internacional — encargo da compra ChatGPT de 25/10 (não existe CardFee no domínio: lançado como encargo do cartão, não como compra independente)", isRecurring: false },
];
export const TATTOO1 = { description: "Tattoo — parte 1", creditor: "Mãe", count: 10, value: "145.00", total: "1450.00", firstDueDate: "2026-10-27" }; // 1ª parcela paga AGORA (hoje de 27/10)

// Nota do plano (aparece na UI de Compromissos: curta e explícita). Valor/parcelas/credor são CONFIRMADOS pelo usuário; só o CALENDÁRIO é estimado.
export const TATTOO1_NOTES = "Tattoo parte 1: R$ 1.450 em 10x de R$ 145 no cartão de crédito da mãe (valor, parcelas e credor confirmados pelo usuário; nenhuma parcela paga; o Cofrinho NÃO foi repassado). 1ª parcela: data de planejamento 27/10/2026 — o usuário a paga agora com o salário deste ciclo. Parcelas 2–10: datas projetadas mensalmente (27/11 em diante) apenas para organização financeira; não é vencimento contratual informado pelo usuário. A 2ª tattoo (R$ 1.650) NÃO existe no Norte.";

// ----------------------------------------------------------------------------- planner
export async function buildCatchup107Plan({ client } = {}) {
  if (!client) throw new Error("client é obrigatório");
  const operations = [];
  const warnings = [];
  const blockers = [];
  const op = (o) => operations.push({ id: `op${String(operations.length + 1).padStart(2, "0")}`, ...o });

  const [itau, caju, dinheiro, cofrinho, card] = await Promise.all([
    client.account.findFirst({ where: { slug: "itau" } }),
    client.account.findFirst({ where: { slug: "vale-alimentacao" } }),
    client.account.findFirst({ where: { slug: "dinheiro" } }),
    client.account.findFirst({ where: { slug: "cofrinho-itau" } }),
    client.card.findFirst({ orderBy: { createdAt: "asc" } }),
  ]);
  if (!itau || !caju || !dinheiro || !cofrinho || !card) {
    blockers.push("Conta Itaú, Caju, Dinheiro, Cofrinho ou cartão Itaú não encontrados (estado-base da 10.6 ausente).");
    return { operations, balancesBefore: null, balancesProjected: null, warnings, blockers, checkpoints: [] };
  }
  const latestAnchor = (acc) => client.balanceAdjustment.findFirst({ where: { accountId: acc.id }, orderBy: { occurredAt: "desc" } });
  const [itauAnchor, cajuAnchor, cashAnchor, cofAnchor] = await Promise.all([latestAnchor(itau), latestAnchor(caju), latestAnchor(dinheiro), latestAnchor(cofrinho)]);
  const balancesBefore = {};
  for (const [k, a] of [["itau", itau], ["caju", caju], ["dinheiro", dinheiro], ["cofrinho", cofrinho]]) balancesBefore[k] = fmt(await computeAccountBalance(a.id, { client }));
  const marker = (m) => ({ rawMessage: { startsWith: `${PLAN_TAG}:${m}` } });
  const anchorDone = async (acc, m) => client.balanceAdjustment.findFirst({ where: { accountId: acc.id, ...marker(m) } });

  // ---------- estado preservado (nada disto pode mudar nesta fase)
  const reimb = await client.internalReimbursement.findMany({ where: { fromAccountId: caju.id }, orderBy: { amount: "asc" } });
  const reimbPending = reimb.filter((r) => r.status === "PENDING");
  if (reimb.length !== 2 || reimbPending.length !== 2 || fmt(reimbPending.reduce((a, r) => addMoney(a, r.amount), money(0))) !== TARGETS.cajuReimbursements) warnings.push(`Repasses do Caju não estão exatamente como informado (2 PENDING = 100,50): ${reimb.map((r) => `${r.amount}:${r.status}`).join(", ")} — esta fase não os toca.`);
  const tiny = await client.receivable.findFirst({ where: { notes: { startsWith: "FASE106-CATCHUP:tiny-65.90" } } });
  const cnpj = await client.confirmedCommitment.findFirst({ where: { description: { startsWith: "Devolver valor restante ao CNPJ" } } });
  const tiger = await client.confirmedCommitment.findFirst({ where: { description: { startsWith: "Acordo Tiger" } } });
  if (!tiny || tiny.status !== "PENDING" || !same(tiny.amount, "65.90")) blockers.push("Recebível Tiny 65,90 não está PENDING como informado.");
  if (!cnpj || cnpj.status !== "CONFIRMED" || !same(cnpj.amount, "1335") || cnpj.fundingAccountId) blockers.push("Compromisso CNPJ 1.335 não está CONFIRMED/não-funded como informado.");
  if (!tiger || tiger.status !== "CONFIRMED" || !same(tiger.amount, "5000") || tiger.dueDate) blockers.push("Compromisso Tiger 5.000 não está CONFIRMED sem dueDate como informado.");

  // ---------- helper de lançamento (marcador; possível duplicata sem marcador ⇒ BLOCKER, nunca ignorar em silêncio)
  let itauDelta = money(0);
  let cajuDelta = money(0);
  const itauRevDone = !!(await anchorDone(itau, "itau-13-revision"));
  const itauEffAnchorAt = itauRevDone ? itauAnchor.occurredAt : new Date(BANK_EOD_13_10);
  const itauBase = itauRevDone ? money(balancesBefore.itau) : money(TARGETS.itauRevision13);
  const counts = (anchorAt, date) => !anchorAt || isAfterAnchor(date, anchorAt);
  async function ledgerItem(account, who, it, extra = {}) {
    const model = it.kind === "income" ? "income" : "expense";
    const marked = await client[model].findFirst({ where: { accountId: account.id, ...marker(it.key) } });
    if (marked) return;
    const clash = await client[model].findFirst({ where: { accountId: account.id, occurredAt: { gte: day(it.date), lt: nextDay(it.date) }, amount: it.amount, OR: [{ rawMessage: null }, { NOT: { rawMessage: { startsWith: PLAN_TAG } } }] } });
    if (clash) { blockers.push(`Possível duplicata não marcada: ${model} ${it.amount} em ${it.date} (${clash.description.slice(0, 40)}) — conferir antes de importar "${it.description.slice(0, 40)}".`); return; }
    const signed = it.kind === "income" ? money(it.amount) : money(it.amount).neg();
    if (who === "itau" && !it.revision && counts(itauEffAnchorAt, day(it.date))) itauDelta = addMoney(itauDelta, signed);
    if (who === "caju" && counts(cajuAnchor?.occurredAt, day(it.date))) cajuDelta = addMoney(cajuDelta, signed);
    const note = [it.posted ? `lançamento bancário em ${it.posted}` : null, it.revision ? "já refletido no saldo revisado do banco (13/10 = 15,21)" : null].filter(Boolean).join("; ");
    op({ section: who, kind: it.kind === "income" ? "ADD_INCOME" : "ADD_EXPENSE", description: `${it.kind === "income" ? "+" : "−"}R$ ${it.amount} em ${it.date}${it.posted ? ` (banco ${it.posted})` : ""}: ${it.description}`, target: { model, accountId: account.id }, data: { amount: it.amount, occurredAt: it.date, description: it.description, category: it.category, source: "manual", confidence: it.confidence ?? "CONFIRMED", rawMessage: `${PLAN_TAG}:${it.key}${note ? ` | ${note}` : ""}`, isRecurring: false, ...extra }, effect: { [who]: `${it.kind === "income" ? "+" : "-"}${it.amount}` }, preconditions: { absent: { model, accountId: account.id, marker: `${PLAN_TAG}:${it.key}`, day: it.date, amount: it.amount } } });
  }

  // ---------- 1) Itaú: revisão do saldo de 13/10 (auditável: a âncora anterior de 12,28 é preservada) + linhas
  if (!itauRevDone) {
    const explained = ITAU_ITEMS.filter((i) => i.revision).reduce((a, i) => addMoney(a, i.amount), money(0));
    const expectedResidual = subtractMoney(subtractMoney(TARGETS.itauRevision13, itauAnchor.newBalance), explained);
    op({ section: "itau", kind: "ADD_BANK_BALANCE_REVISION", description: `Revisão do saldo do Itaú de 13/10 publicada no extrato: ${fmt(itauAnchor.newBalance)} → 15,21 (fim do dia 13/10). Explicada por +2,92 (PIX TRANSF FUTURAS) +0,04 (rendimento); resíduo ${fmt(expectedResidual)}. A âncora anterior é PRESERVADA (histórico append-only)`, target: { model: "balanceAdjustment", accountId: itau.id }, data: { newBalance: TARGETS.itauRevision13, occurredAt: BANK_EOD_13_10, confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: `${PLAN_TAG}:itau-13-revision`, note: `O extrato oficial emitido em 27/10 revisou o saldo bancário de 13/10 (fim do dia) de ${fmt(itauAnchor.newBalance)} para 15,21: +2,92 (PIX TRANSF FUTURAS, crédito de casa de apostas) +0,04 (rendimento) e resíduo de ${fmt(expectedResidual)} sem linha real. A âncora anterior (13/10, ${fmt(itauAnchor.newBalance)}) foi preservada. ${SOURCES_NOTE}` }, effect: { revision: fmt(subtractMoney(TARGETS.itauRevision13, itauAnchor.newBalance)) }, preconditions: { accountId: itau.id, previousAnchorId: itauAnchor.id, previousAnchorBalance: itauAnchor.newBalance.toString(), explained: fmt(explained), expectedResidual: fmt(expectedResidual) } });
  }
  for (const it of ITAU_ITEMS) await ledgerItem(itau, "itau", it);

  // salário: 1 crédito bancário de 5.309,15 = base (ocorrência recorrente) + hora extra (extraordinária)
  const salaryRule = await client.recurringRule.findFirst({ where: { name: "Salário", kind: "income" } });
  if (!salaryRule) blockers.push("Regra recorrente 'Salário' não encontrada.");
  else {
    const baseDone = await client.income.findFirst({ where: { recurringRuleId: salaryRule.id, recurringOccurrenceDate: day(SALARY.occurrence) } });
    const otDone = await client.income.findFirst({ where: { accountId: itau.id, ...marker("20261023-hora-extra") } });
    if (!same(salaryRule.amount, SALARY.base)) blockers.push(`Salário-base da regra (${salaryRule.amount}) ≠ ${SALARY.base}.`);
    if (!baseDone) {
      if (counts(itauEffAnchorAt, day(SALARY.date))) itauDelta = addMoney(itauDelta, SALARY.base);
      op({ section: "itau", kind: "ADD_RECURRING_INCOME", description: `+R$ ${SALARY.base} em ${SALARY.date}: salário-base — ocorrência recorrente de ${SALARY.occurrence} realizada (parte do crédito bancário único de ${SALARY.total})`, target: { model: "income", accountId: itau.id, ruleId: salaryRule.id }, data: { amount: SALARY.base, occurredAt: SALARY.date, recurringOccurrenceDate: SALARY.occurrence, description: "Salário — outubro/2026 (parte do crédito bancário único de R$ 5.309,15 em 23/10: salário-base)", category: "Trabalho", source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:20261023-salario-base | crédito bancário único ${SALARY.total} = base ${SALARY.base} + hora extra ${SALARY.overtime}` }, effect: { itau: `+${SALARY.base}` }, preconditions: { ruleId: salaryRule.id, absentOccurrence: SALARY.occurrence } });
    }
    if (!otDone) {
      if (counts(itauEffAnchorAt, day(SALARY.date))) itauDelta = addMoney(itauDelta, SALARY.overtime);
      op({ section: "itau", kind: "ADD_INCOME", description: `+R$ ${SALARY.overtime} em ${SALARY.date}: hora extra / banco de horas — renda real EXTRAORDINÁRIA (não recorrente; não altera o salário esperado nem a regra da próxima renda)`, target: { model: "income", accountId: itau.id }, data: { amount: SALARY.overtime, occurredAt: SALARY.date, description: "Hora extra / banco de horas — outubro/2026 (parte do crédito bancário único de R$ 5.309,15; extraordinária, NÃO recorrente)", category: "Trabalho", source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:20261023-hora-extra | crédito bancário único ${SALARY.total} = base ${SALARY.base} + hora extra ${SALARY.overtime}`, isRecurring: false }, effect: { itau: `+${SALARY.overtime}` }, preconditions: { absent: { model: "income", accountId: itau.id, marker: `${PLAN_TAG}:20261023-hora-extra`, day: SALARY.date, amount: SALARY.overtime } } });
    }
  }

  // ---------- 2) Caju: recarga recorrente + despesas
  const cajuRule = await client.recurringRule.findFirst({ where: { name: "Vale Alimentação - Recarga", kind: "income" } });
  if (!cajuRule) blockers.push("Regra recorrente da recarga do Caju não encontrada.");
  else {
    const rDone = await client.income.findFirst({ where: { recurringRuleId: cajuRule.id, recurringOccurrenceDate: day(CAJU_RECHARGE.occurrence) } });
    if (!rDone) {
      if (counts(cajuAnchor?.occurredAt, day(CAJU_RECHARGE.date))) cajuDelta = addMoney(cajuDelta, CAJU_RECHARGE.amount);
      op({ section: "caju", kind: "ADD_RECURRING_INCOME", description: `+R$ ${CAJU_RECHARGE.amount} em ${CAJU_RECHARGE.date}: recarga de benefício do Caju (ocorrência ${CAJU_RECHARGE.occurrence}) — NÃO é salário, NÃO é renda irrestrita`, target: { model: "income", accountId: caju.id, ruleId: cajuRule.id }, data: { amount: CAJU_RECHARGE.amount, occurredAt: CAJU_RECHARGE.date, recurringOccurrenceDate: CAJU_RECHARGE.occurrence, description: "Recarga mensal VA/Caju — outubro/2026 (benefício restrito a alimentação)", category: "Trabalho", source: "manual", confidence: "CONFIRMED", rawMessage: `${PLAN_TAG}:${CAJU_RECHARGE.key}` }, effect: { caju: `+${CAJU_RECHARGE.amount}` }, preconditions: { ruleId: cajuRule.id, absentOccurrence: CAJU_RECHARGE.occurrence } });
    }
  }
  for (const it of CAJU_ITEMS) await ledgerItem(caju, "caju", it);

  // ---------- 3) cartão Itaú: novembro
  const novBill = await client.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: card.id, cycleMonth: "2026-11" } } });
  if (!novBill) blockers.push("CardBill 2026-11 não encontrada.");
  const { start: novStart, end: novEnd } = getCardBillPeriod(card, "2026-11");
  const [expAgg, instAgg] = await Promise.all([
    client.expense.aggregate({ where: { cardId: card.id, occurredAt: { gte: novStart, lt: novEnd } }, _sum: { amount: true } }),
    client.installment.aggregate({ where: { billMonth: "2026-11", purchase: { cardId: card.id } }, _sum: { amount: true } }),
  ]);
  const calcBefore = addMoney(money(expAgg._sum.amount), money(instAgg._sum.amount));
  const rei = await client.expense.findFirst({ where: { cardId: card.id, description: { contains: "Rei do Pernil" } } });
  if (!rei || !same(rei.amount, TARGETS.reiDoPernil)) blockers.push("Compra 'Rei do Pernil' R$ 100 não encontrada no cartão (esperada desde a 10.6).");
  const newCard = [];
  for (const e of CARD_EXPENSES) {
    if (await client.expense.findFirst({ where: { cardId: card.id, ...marker(`card-${e.key}`) } })) continue;
    const clash = await client.expense.findFirst({ where: { cardId: card.id, occurredAt: { gte: day(e.date), lt: nextDay(e.date) }, amount: e.amount, OR: [{ rawMessage: null }, { NOT: { rawMessage: { startsWith: PLAN_TAG } } }] } });
    if (clash) { blockers.push(`Possível duplicata não marcada no cartão: ${e.amount} em ${e.date} (${clash.description.slice(0, 40)}).`); continue; }
    newCard.push(e);
  }
  const phaseObs = novBill ? await client.cardBillReconciliation.findFirst({ where: { cardId: card.id, cycleMonth: "2026-11", ...marker("card-bill-nov") } }) : null;
  const obsDone = !!phaseObs;
  let calcPlanned = calcBefore;
  for (const e of newCard) calcPlanned = addMoney(calcPlanned, e.amount);
  const calcAtObs = obsDone ? money(phaseObs.calculatedTotal) : calcPlanned;
  for (const e of newCard) {
    op({ section: "card", kind: "ADD_CARD_EXPENSE", description: `Compra real no cartão ${e.date} R$ ${e.amount}: ${e.description}`, target: { model: "expense", cardId: card.id }, data: { amount: e.amount, occurredAt: e.date, description: e.description, category: e.category, isRecurring: !!e.isRecurring, source: "manual", confidence: e.confidence ?? "CONFIRMED", rawMessage: `${PLAN_TAG}:card-${e.key} | fatura Itaú novembro observada em 27/10/2026` }, preconditions: { absent: { cardId: card.id, marker: `${PLAN_TAG}:card-${e.key}`, day: e.date, amount: e.amount } } });
  }
  if (!obsDone && novBill) {
    op({ section: "card", kind: "RECORD_CARD_BILL_OBSERVATION", description: `Observação oficial da fatura de NOVEMBRO em 27/10: R$ 1.480,88 (era 1.060,46; +420,42 = 320,42 de lançamentos novos + 100,00 do Rei do Pernil, que agora entra no observado e deixa de ser "pendente fora do observado"). Detalhe conhecido ${fmt(calcAtObs)} + R$ 4,11 de 'Outros custos' (mesmo gap da 10.6, sem compra inventada)`, target: { model: "cardBillReconciliation", cardId: card.id }, data: { cycleMonth: "2026-11", observedTotal: TARGETS.novObserved, calculatedTotal: fmt(calcAtObs), delta: fmt(subtractMoney(TARGETS.novObserved, calcAtObs)), observedAt: OBSERVED_AT_POLICY, confidence: "RECONCILIATION_ADJUSTMENT", rawMessage: `${PLAN_TAG}:card-bill-nov`, note: `Fatura de novembro observada no app do Itaú em 27/10/2026: R$ 1.480,88 (OPEN, fechamento 04/11, vencimento 11/11). Anterior (13/10): 1.060,46. Os R$ 100,00 da Lanchonete Rei do Pernil (12/10), que estavam FORA do observado desde a 10.6, passam a estar DENTRO deste total — contados uma única vez. ${SOURCES_NOTE}` }, preconditions: { cardId: card.id, cycleMonth: "2026-11", noPhaseObservation: true } });
    if (!same(novBill.totalAmount, calcPlanned)) op({ section: "card", kind: "SYNC_CARD_BILL_ROW", description: `CardBill 2026-11: total persistido ${novBill.totalAmount} → ${fmt(calcPlanned)} (o CALCULADO; o observado fica na observação)`, target: { model: "cardBill", id: novBill.id }, from: { totalAmount: novBill.totalAmount.toString() }, data: { totalAmount: fmt(calcPlanned) }, preconditions: { billId: novBill.id, currentTotal: novBill.totalAmount.toString(), currentStatus: novBill.status } });
  }
  const sched = await client.installment.findMany({ where: { purchase: { cardId: card.id }, billMonth: { gte: "2026-12" } }, select: { billMonth: true, amount: true } });
  const byMonth = {};
  for (const r of sched) byMonth[r.billMonth] = addMoney(byMonth[r.billMonth] ?? money(0), r.amount);
  const futureDec = fmt(byMonth["2026-12"] ?? 0), futureJan = fmt(byMonth["2027-01"] ?? 0), futureFeb = fmt(byMonth["2027-02"] ?? 0);

  // ---------- 4) Tattoo 1 (dívida real na mãe: 10 x 145; nada pago; nenhuma data inventada)
  const tattooPlan = await client.externalInstallmentPlan.findFirst({ where: { description: TATTOO1.description, creditor: TATTOO1.creditor } });
  const tattooTwo = await client.externalInstallmentPlan.findFirst({ where: { description: { contains: "Tattoo", mode: "insensitive" }, NOT: { description: TATTOO1.description } } });
  if (tattooTwo) blockers.push(`Já existe outro plano 'Tattoo' (${tattooTwo.description}) — a segunda tattoo NÃO foi realizada e não pode existir.`);
  if (!tattooPlan) op({ section: "tattoo", kind: "ADD_EXTERNAL_INSTALLMENT_PLAN", description: "Plano 'Tattoo — parte 1' na mãe: R$ 1.450,00 em 10x de R$ 145,00 (cartão de crédito da mãe), ACTIVE, 0 parcelas pagas. 1ª parcela (R$ 145,00) = compromisso do CICLO ATUAL com data de PLANEJAMENTO 27/10 (o usuário a paga AGORA) ⇒ horizonte corrente, reduz o livre de hoje. Parcelas 2–10: calendário de PLANEJAMENTO mensal (27/11…27/07/2027), ESTIMADO, NÃO é vencimento contratual informado pelo usuário (o modelo CALENDAR_DATE exige uma data por parcela; AFTER_NEXT_INCOME não permite a 1ª no horizonte corrente)", target: { model: "externalInstallmentPlan" }, data: { description: TATTOO1.description, creditor: TATTOO1.creditor, installmentValue: TATTOO1.value, installmentCount: TATTOO1.count, dueTiming: "CALENDAR_DATE", firstDueDate: TATTOO1.firstDueDate, confidence: "ESTIMATED", notes: TATTOO1_NOTES }, preconditions: { absentPlan: TATTOO1.description } });
  else if (tattooPlan.status !== "ACTIVE" || !same(tattooPlan.installmentValue, TATTOO1.value) || tattooPlan.installmentCount !== TATTOO1.count) blockers.push("Plano 'Tattoo — parte 1' existe mas difere do informado.");

  // ---------- 5) Cofrinho / Tattoo reserve: +43 sem origem conhecida ⇒ reconciliação (nunca Income inventada)
  const reserve = await client.reserve.findFirst({ where: { accountId: cofrinho.id, name: "Tattoo" } });
  const goal = await client.goal.findFirst({ where: { name: { contains: "Tattoo", mode: "insensitive" } } });
  const cofDone = await anchorDone(cofrinho, "cofrinho-recon");
  const cofAdj = cofDone ? money(0) : subtractMoney(TARGETS.cofrinho, balancesBefore.cofrinho);
  const explainingTransfer = await client.transfer.findMany({ where: { toAccountId: cofrinho.id, occurredAt: { gt: day("2026-10-08") }, OR: [{ rawMessage: null }, { NOT: { rawMessage: { startsWith: PLAN_TAG } } }] } });
  if (explainingTransfer.length) warnings.push(`Há Transfer(s) para o Cofrinho depois de 08/10 que podem explicar parte dos R$ 43: ${explainingTransfer.map((t) => `${t.amount}@${dayKey(t.occurredAt)}`).join(", ")}.`);
  if (!reserve || !goal) blockers.push("Reserve/Meta Tattoo não encontradas.");
  else if (!cofDone && !cofAdj.isZero()) {
    op({ section: "tattoo", kind: "ADD_BALANCE_RECONCILIATION", description: `Âncora de reconciliação Cofrinho Itaú: saldo ${balancesBefore.cofrinho} → ${TARGETS.cofrinho} observado (+${fmt(cofAdj)}; origem do acréscimo NÃO detalhada: nenhuma Transfer/ReserveMovement a explica; RECONCILIATION_ADJUSTMENT, nunca Income inventada)`, target: { model: "balanceAdjustment", accountId: cofrinho.id }, data: { newBalance: TARGETS.cofrinho, confidence: "RECONCILIATION_ADJUSTMENT", observedAt: OBSERVED_AT_POLICY, rawMessage: `${PLAN_TAG}:cofrinho-recon`, note: `Saldo do Cofrinho Tattoo observado em 27/10: R$ 193,00 (era 150,00). O acréscimo de R$ 43,00 não tem origem detalhada. Âncora gravada no INSTANTE real da reconciliação (o horário exato da leitura não é conhecido). ${SOURCES_NOTE}` }, effect: { adjustment: fmt(cofAdj) }, preconditions: { accountId: cofrinho.id, targetBalance: TARGETS.cofrinho, expectedAdjustment: fmt(cofAdj), expectedLedgerAfterLines: balancesBefore.cofrinho } });
    op({ section: "tattoo", kind: "ADD_RESERVE_MOVEMENT", description: `ReserveMovement ADJUST_INCREASE R$ ${fmt(cofAdj)} (Tattoo): saldo observado 193,00; origem do acréscimo não detalhada`, target: { model: "reserveMovement", reserveId: reserve.id }, data: { kind: "ADJUST_INCREASE", amount: fmt(cofAdj), note: `${PLAN_TAG}:tattoo-observed | acréscimo de saldo observado no Cofrinho em 27/10 (origem não detalhada). ${SOURCES_NOTE}` }, preconditions: { reserveId: reserve.id, currentBalance: "150.00", absentNotePrefix: `${PLAN_TAG}:tattoo-observed` } });
    if (!same(goal.savedAmount, TARGETS.cofrinho)) op({ section: "tattoo", kind: "UPDATE_GOAL_SAVED", description: `Meta Tattoo: guardado ${fmt(goal.savedAmount)} → ${TARGETS.cofrinho} de 2.635,00 (espelha a Reserve; contado uma vez)`, target: { model: "goal", id: goal.id }, from: { savedAmount: goal.savedAmount.toString() }, to: { savedAmount: TARGETS.cofrinho }, preconditions: { goalId: goal.id, currentSaved: goal.savedAmount.toString() } });
  }

  // ---------- 6) saldos projetados e reconciliações (só o resíduo que NENHUMA linha real explica)
  const itauLedger = addMoney(itauBase, itauDelta);
  const cajuLedger = addMoney(balancesBefore.caju, cajuDelta);
  const cashLedger = money(balancesBefore.dinheiro);
  const cajuDone = await anchorDone(caju, "caju-recon");
  const cashDone = await anchorDone(dinheiro, "dinheiro-recon");
  const itauReconDone = await anchorDone(itau, "itau-recon");
  const adjOf = (done, target, ledger) => (done ? money(0) : subtractMoney(target, ledger));
  const itauAdj = adjOf(itauReconDone || itauRevDone, TARGETS.itau, itauLedger); // fase já aplicada ⇒ movimentos posteriores não são "corrigidos" de volta ao alvo
  const cajuAdj = adjOf(cajuDone, TARGETS.caju, cajuLedger);
  const cashAdj = adjOf(cashDone, TARGETS.dinheiro, cashLedger);
  const recon = (acc, slug, target, adj, ledger, note) =>
    op({ section: acc.slug, kind: "ADD_BALANCE_RECONCILIATION", description: `Âncora de reconciliação ${acc.name}: ledger projetado ${fmt(ledger)} → saldo autoritativo ${target} (ajuste ${fmt(adj)}; RECONCILIATION_ADJUSTMENT, nunca Expense/Income)`, target: { model: "balanceAdjustment", accountId: acc.id }, data: { newBalance: target, confidence: "RECONCILIATION_ADJUSTMENT", observedAt: OBSERVED_AT_POLICY, rawMessage: `${PLAN_TAG}:${slug}-recon`, note: `${note} Âncora gravada no INSTANTE real da reconciliação (o horário exato da leitura não é conhecido). ${SOURCES_NOTE}` }, effect: { adjustment: fmt(adj) }, preconditions: { accountId: acc.id, targetBalance: target, expectedAdjustment: fmt(adj), expectedLedgerAfterLines: fmt(ledger) } });
  if (!itauAdj.isZero()) recon(itau, "itau", TARGETS.itau, itauAdj, itauLedger, "Reconciliação Itaú (extrato até 27/10): resíduo de centavos sem linha real correspondente.");
  if (!cajuAdj.isZero()) recon(caju, "caju", TARGETS.caju, cajuAdj, cajuLedger, "Reconciliação Caju: as linhas informadas somam 858,81 mas o app mostra 859,21 — diferença de +0,40 sem movimento real correspondente.");
  if (!cashAdj.isZero()) recon(dinheiro, "dinheiro", TARGETS.dinheiro, cashAdj, cashLedger, "Dinheiro físico: o usuário afirmou que NÃO possui mais os R$ 181,00 e autorizou zerar a conta; a trilha dos gastos não é conhecida — NÃO se inventam despesas em espécie.");
  const balancesProjected = { itauLedger: fmt(itauLedger), itauAdjustment: fmt(itauAdj), itau: TARGETS.itau, cajuLedger: fmt(cajuLedger), cajuAdjustment: fmt(cajuAdj), caju: TARGETS.caju, dinheiroLedger: fmt(cashLedger), dinheiroAdjustment: fmt(cashAdj), dinheiro: TARGETS.dinheiro, cofrinho: TARGETS.cofrinho, cofrinhoAdjustment: fmt(cofAdj) };

  // ---------- 7) checkpoints (independentes do estado: a fase aplicada é reconhecida por marcador)
  const sum = (arr) => arr.reduce((a, v) => addMoney(a, v), money(0));
  const cajuSpend = sum(CAJU_ITEMS.map((i) => i.amount));
  const finalOf = (done, anchorRow, ledger, adj) => (done && anchorRow ? fmt(anchorRow.newBalance) : fmt(addMoney(ledger, adj)));
  const checkpoints = [
    { name: "Itaú: 15,21 (13/10 revisado) + movimentos 14→26/10 = 4.918,52 (resíduo 0,00)", expected: TARGETS.itau, actual: itauRevDone ? TARGETS.itau : fmt(addMoney(itauLedger, itauAdj)) },
    { name: "Itaú: 12,28 + 2,92 + 0,04 − 15,21 = resíduo da revisão de 13/10 = −0,03", expected: "-0.03", actual: itauRevDone ? "-0.03" : fmt(subtractMoney(subtractMoney(TARGETS.itauRevision13, itauAnchor.newBalance), ITAU_ITEMS.filter((i) => i.revision).reduce((a, i) => addMoney(a, i.amount), money(0)))) },
    { name: "salário: 4.937,18 + 371,97 = crédito bancário 5.309,15", expected: SALARY.total, actual: fmt(addMoney(SALARY.base, SALARY.overtime)) },
    { name: "Caju: despesas visíveis = 689,65", expected: "689.65", actual: fmt(cajuSpend) },
    { name: "Caju: 248,46 + 1.300,00 − 689,65 = 858,81 (conta matemática); app 859,21 ⇒ resíduo +0,40", expected: TARGETS.caju, actual: finalOf(cajuDone, cajuAnchor, cajuLedger, cajuAdj) },
    { name: "Caju: resíduo = +0,40", expected: "0.40", actual: cajuDone ? "0.40" : fmt(cajuAdj) },
    { name: "Caju após repasses pendentes: 859,21 − 100,50 = 758,71", expected: TARGETS.cajuAfterReimbursements, actual: fmt(subtractMoney(TARGETS.caju, TARGETS.cajuReimbursements)) },
    { name: "Dinheiro: 181,00 → 0,00 (ajuste −181,00)", expected: TARGETS.dinheiro, actual: cashDone ? TARGETS.dinheiro : fmt(addMoney(cashLedger, cashAdj)) },
    { name: "Cofrinho/Tattoo: 150,00 + 43,00 = 193,00", expected: TARGETS.cofrinho, actual: cofDone ? TARGETS.cofrinho : fmt(addMoney(balancesBefore.cofrinho, cofAdj)) },
    { name: "Tattoo 1: 10 × 145,00 = 1.450,00", expected: TATTOO1.total, actual: fmt(money(TATTOO1.value).times(TATTOO1.count)) },
    { name: "novos lançamentos de novembro: soma = 320,42", expected: TARGETS.novNewItems, actual: fmt(sum(CARD_EXPENSES.map((e) => e.amount))) },
    { name: "novembro: 1.060,46 + 320,42 + 100,00 (Rei do Pernil, já no banco) = 1.480,88", expected: TARGETS.novObserved, actual: fmt(sum([TARGETS.novPrevObserved, TARGETS.novNewItems, TARGETS.reiDoPernil])) },
    { name: "novembro: delta observado = 420,42", expected: TARGETS.novDelta, actual: fmt(subtractMoney(TARGETS.novObserved, TARGETS.novPrevObserved)) },
    { name: "novembro: calculado após o plano (1.156,35 + 320,42) = 1.476,77; observado − calculado = 4,11", expected: "4.11", actual: fmt(subtractMoney(TARGETS.novObserved, calcAtObs)) },
    { name: "parcelas futuras preservadas: dez 200,36 · jan 200,36", expected: "200.36", actual: futureDec === futureJan ? futureDec : `${futureDec}/${futureJan}` },
  ].map((c) => ({ ...c, ok: same(c.expected, c.actual) }));
  for (const c of checkpoints) if (!c.ok) blockers.push(`Checkpoint falhou: ${c.name} (esperado ${c.expected}, obtido ${c.actual})`);

  return {
    operations,
    balancesBefore,
    balancesProjected,
    bank: { statementLinesNewSinceLastAnchor: 14, itauEconomicRecordsCreated: ITAU_ITEMS.length + 2, cajuStatementLines: CAJU_ITEMS.length + 1, cajuEconomicRecordsCreated: CAJU_ITEMS.length + 1, note: "14 linhas bancárias do Itaú desde 12,28: 13/10 (2) + 14/10 (2) + 21/10 (2) + 22/10 (3) + 23/10 (3: crédito 5.309,15 + posto + pneu) + 26/10 (2). O crédito 5.309,15 é UMA linha bancária decomposta em 2 registros econômicos (base + hora extra): 14 linhas → 15 registros, mesmo total." },
    itau: { revision: { from: fmt(itauAnchor.newBalance), to: TARGETS.itauRevision13, done: itauRevDone }, newMovements: ITAU_ITEMS.filter((i) => !i.revision).length, residual: fmt(itauAdj) },
    card: { novObservedTarget: TARGETS.novObserved, previousObserved: TARGETS.novPrevObserved, delta: TARGETS.novDelta, calculatedAfterPlan: fmt(calcAtObs), knownGap: fmt(subtractMoney(TARGETS.novObserved, calcAtObs)), futureDec, futureJan, futureFeb, reiDoPernilIncludedInObserved: true },
    income: { salaryBankCredit: SALARY.total, baseSalary: SALARY.base, overtime: SALARY.overtime, affiliate: "130.20", gamblingCredits: "3.08" },
    tattoo: { reserveBefore: balancesBefore.cofrinho, reserveTarget: TARGETS.cofrinho, goalBefore: goal ? goal.savedAmount.toString() : null, plan1: `${TATTOO1.total} / ${TATTOO1.count} x ${TATTOO1.value}`, firstInstallmentDue: TATTOO1.firstDueDate, firstInstallmentCommittedNow: true, tattoo2Created: false, casacoReceivableCreated: false, future438PaymentCreated: false },
    preserved: { cajuReimbursementsPending: fmt(reimbPending.reduce((a, r) => addMoney(a, r.amount), money(0))), tinyReceivable: tiny ? tiny.amount.toString() : null, cnpjPayable: cnpj ? `${cnpj.amount} ${cnpj.status}` : null, tiger: tiger ? `${tiger.amount} ${tiger.status}` : null },
    checkpoints,
    sources: SOURCES_NOTE,
    warnings,
    blockers,
  };
}
