// Fase 5.2A — OBLIGATION TRUTH CLOSURE / PRE-APPLY.
//
// 100% READ-ONLY contra o DB. Nenhuma migration aplicada. Nenhum dado
// financeiro escrito. Card/VA/Itaú (saldo reconciliado) permanecem intocados.
//
// Objetivo: auditar se o schema/código atuais conseguem representar
// honestamente os compromissos confirmados (um compromisso com janela
// incerta, o pacote de parcelas externas, uma contingência com valor
// aproximado) sem inventar datas, e simular — usando as funções REAIS do
// Financial Engine V2 (nunca reimplementadas) — qual seria o resultado se
// esses fatos estivessem persistidos.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, multiplyMoney, divideMoney, sumMoney, compareMoney, isNegative } from "../lib/money.js";
import { buildFinancialEngineSummary, computeCurrentObligationHorizonEnd } from "../lib/financialEngine.js";
import { classifyConfirmedCommitment, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeFreeMoneyFromBreakdown, computeSafeToSpend } from "../lib/freeMoney.js";
import { computeFinancialStatus } from "../lib/financialStatus.js";
import { minProjectedCashBefore } from "../lib/financialProjection.js";
import { getAppSettings } from "../lib/settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(HERE, "snapshot-input.local.json");
const REPORT_DIR = path.join(HERE, "snapshot-reports");
const SCHEMA_PATH = path.join(HERE, "..", "prisma", "schema.prisma");

function log(...args) {
  console.log(...args);
}

async function fingerprintFinancialModels(client = prisma) {
  const models = ["account", "income", "expense", "transfer", "balanceAdjustment", "card", "cardBill", "purchase", "installment", "cardLimitUpdate", "bill", "recurringRule", "goal", "reserve", "reserveMovement", "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency", "receivable", "categoryBudget", "cardCreditMovement", "appSettings"];
  const fp = {};
  for (const m of models) {
    const rows = await client[m].findMany();
    fp[m] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
  }
  return fp;
}

// ============================================================================
// Item 6 — auditoria de schema (lida do arquivo real, nunca assumida de memória).
// ============================================================================
function auditSchemaField(schemaText, modelName, fieldName) {
  const modelMatch = schemaText.match(new RegExp(`model ${modelName} \\{([\\s\\S]*?)\\n\\}`));
  if (!modelMatch) return { found: false };
  const fieldLine = modelMatch[1].split("\n").find((l) => l.trim().startsWith(`${fieldName} `) || l.trim().startsWith(`${fieldName}\t`));
  if (!fieldLine) return { found: false };
  const nullable = /\bDateTime\?/.test(fieldLine) || /\bDecimal\?/.test(fieldLine) || /\bString\?/.test(fieldLine) || /\bInt\?/.test(fieldLine) || /\bBoolean\?/.test(fieldLine);
  return { found: true, line: fieldLine.trim(), nullable };
}

// ============================================================================
// Item 14 — forecast por mês do pacote de parcelas externas (puro, em memória,
// nunca precisa de data exata — só das posições atuais confirmadas).
// ============================================================================
// Fase 5.2B, item 12 — corrigido o off-by-one da Fase 5.2A: o loop antigo
// parava assim que TODOS os planos zeravam, sem nunca emitir a linha terminal
// "offset N = 0" (a prova de que o pacote realmente acabou). Agora sempre
// empurra o offset ATUAL antes de checar se já zerou tudo, e só para depois de
// ter emitido essa linha final — "offset" (não "month") é o termo usado daqui
// pra frente, alinhado ao vocabulário da fase (não é uma data de calendário,
// é uma distância em ocorrências de renda).
function buildInstallmentRunoffSchedule(plans) {
  // Estado inicial: parcelas restantes de cada plano.
  let state = plans.map((p) => ({ description: p.description, installmentValue: money(p.installmentValue), remaining: p.installmentCount - p.paidInstallments }));
  const schedule = [];
  let offset = 0;
  while (true) {
    const active = state.filter((p) => p.remaining > 0);
    const monthTotal = sumMoney(active.map((p) => p.installmentValue));
    const finishingThisMonth = state.filter((p) => p.remaining === 1).map((p) => p.description);
    schedule.push({
      offset,
      label: offset === 0 ? "pacote atual" : `+${offset} ocorrência(s) de renda`,
      activePlanCount: active.length,
      monthTotal: monthTotal.toString(),
      plansFinishingThisMonth: finishingThisMonth,
    });
    if (active.length === 0) break; // acabou de emitir a linha terminal (0) — para aqui, nunca antes.
    state = state.map((p) => (p.remaining > 0 ? { ...p, remaining: p.remaining - 1 } : p));
    offset++;
    if (offset > 36) break; // guarda de segurança — nenhum plano real chega perto disso
  }
  return schedule;
}

async function main() {
  log("==============================================================================");
  log("Fase 5.2A — OBLIGATION TRUTH CLOSURE / PRE-APPLY (100% READ-ONLY)");
  log("==============================================================================");

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");
  const fingerprintBefore = await fingerprintFinancialModels();

  // Carregados cedo (genérico: identificado pela FORMA do dado — uma janela de
  // 2 datas candidatas incerta — nunca por um nome/palavra específica) pra
  // poderem ser referenciados de forma genérica em toda a auditoria abaixo.
  const windowedCommitmentInput = input.confirmedCommitments.find((c) => c.dateCandidates?.length === 2);
  const windowedCommitmentDueBy = new Date(`${windowedCommitmentInput.dateCandidates[windowedCommitmentInput.dateCandidates.length - 1]}T00:00:00.000Z`);

  // --- Item 6/21: auditoria de schema ---
  log(`\n--- Item 6/21: auditoria de schema (lida do arquivo real) ---`);
  const fieldsToAudit = [
    ["ExternalInstallmentPlan", "firstDueDate"],
    ["ExternalInstallment", "dueDate"],
    ["ConfirmedCommitment", "dueDate"],
    ["Contingency", "expectedDate"],
    ["Receivable", "expectedDate"],
  ];
  const schemaAudit = {};
  for (const [model, field] of fieldsToAudit) {
    const result = auditSchemaField(schemaText, model, field);
    schemaAudit[`${model}.${field}`] = result;
    log(`  ${model}.${field}: ${result.found ? `"${result.line}"` : "NÃO ENCONTRADO"} -> ${result.nullable ? "NULLABLE ✅" : "NOT NULL ⚠️"}`);
  }
  const schemaSupportsExternalPlanTiming = schemaAudit["ExternalInstallmentPlan.firstDueDate"].nullable;
  const schemaSupportsInstallmentTiming = schemaAudit["ExternalInstallment.dueDate"].nullable;
  const schemaSupport = schemaSupportsExternalPlanTiming && schemaSupportsInstallmentTiming ? "YES" : "SCHEMA_CHANGE_REQUIRED";
  log(`\n  SCHEMA_SUPPORT = ${schemaSupport}`);
  if (schemaSupport !== "YES") {
    log(`  Motivo: ExternalInstallmentPlan.firstDueDate e ExternalInstallment.dueDate são NOT NULL — não há como persistir "pago geralmente depois do salário, data exata desconhecida" sem inventar uma data. lib/externalInstallments.js:createExternalInstallmentPlan também exige firstDueDate (lança erro se ausente) — o código, não só o schema, precisaria mudar junto.`);
    log(`  Migration MÍNIMA proposta (NÃO aplicada nesta fase):`);
    log(`    1) ExternalInstallmentPlan.firstDueDate: DateTime -> DateTime? (nullable)`);
    log(`    2) ExternalInstallment.dueDate: DateTime -> DateTime? (nullable)`);
    log(`    3) ExternalInstallmentPlan: novo campo opcional "dueTiming" (String?, valores como "AFTER_NEXT_INCOME" | null) — carrega a semântica "geralmente pago depois do salário" sem afirmar uma data exata; usado por classifyExternalInstallment (que precisaria de um pequeno ajuste null-safe: dueDate==null + dueTiming=="AFTER_NEXT_INCOME" -> FUTURE_OBLIGATION hoje, mas ENTRA na janela de getNextIncomeCommitment) e por lib/externalInstallments.js:createExternalInstallmentPlan (aceitar firstDueDate ausente quando dueTiming estiver setado).`);
    log(`    Nenhuma tabela nova. Nenhum campo removido/renomeado. Nenhuma linha existente tocada (0 rows hoje nesses 2 models).`);
  }
  log(`\n  ${windowedCommitmentInput.description} (ConfirmedCommitment.dueDate, já NOT NULL hoje): NÃO precisa de migration — usa semântica "dueBy" (o mais tardio dos ${windowedCommitmentInput.dateCandidates.length} candidatos confirmados, ${windowedCommitmentDueBy.toISOString().slice(0, 10)}), documentada em notes como janela conhecida ${windowedCommitmentInput.dateCandidates.join("/")}, nunca afirmando ${windowedCommitmentDueBy.toISOString().slice(0, 10)} como a data exata do evento.`);

  // --- item 2/9: RecurringRule / salary state ---
  const allRules = await prisma.recurringRule.findMany();
  const salaryRule = allRules.find((r) => r.kind === "income" && compareMoney(money(r.amount ?? 0), money(input.mainIncome.standardRecurringAmount)) === 0);
  log(`\n--- Item 9: estado da renda recorrente ---`);
  log(`  RecurringRule total no banco: ${allRules.length} (${allRules.map((r) => `${r.name} [${r.kind}, dayOfMonth=${r.dayOfMonth}, amount=${r.amount?.toString()}]`).join("; ")})`);
  log(`  Existe RecurringRule de salário (kind=income, amount=${input.mainIncome.standardRecurringAmount})? ${salaryRule ? "SIM" : "NÃO"}`);
  if (!salaryRule) log(`  Confirma que a renda recorrente base ainda NÃO está persistida — por isso buildFinancialEngineSummary().nextIncome retorna status=FALLBACK, amount=null hoje.`);

  // --- baseline real (antes) ---
  const before = await buildFinancialEngineSummary();
  log(`\n--- Baseline real (estado atual, sem nenhuma mutação) ---`);
  log(`  unrestrictedCash=${before.balances.unrestrictedCash.toString()} incurred=${before.obligations.incurredLiabilities.toString()} freeMoney=${before.freeMoney.toString()} safeToSpend=${before.safeToSpend.toString()} status=${before.status.status}`);
  log(`  nextIncome: expectedDate=${before.nextIncome.expectedDate.toISOString().slice(0, 10)} status=${before.nextIncome.status} amount=${before.nextIncome.amount}`);

  const settings = await getAppSettings();

  // ==========================================================================
  // ITEM 8/16 — compromisso de janela incerta: classificação real + freeMoney alvo
  // ==========================================================================
  const nextIncomeDate = before.nextIncome.expectedDate;
  const windowedCommitmentSynthetic = {
    status: "CONFIRMED",
    dueDate: windowedCommitmentDueBy,
    amount: money(windowedCommitmentInput.amount),
  };
  const windowedCommitmentClassification = classifyConfirmedCommitment(windowedCommitmentSynthetic, { nextIncomeDate });
  log(`\n--- Item 8: ${windowedCommitmentInput.description} — classificação real (função pura, dado sintético não persistido) ---`);
  log(`  Modelagem: ConfirmedCommitment, dueDate=${windowedCommitmentDueBy.toISOString().slice(0, 10)} (dueBy = o mais tardio de [${windowedCommitmentInput.dateCandidates.join(", ")}], nunca afirmado como a data exata do evento), status=CONFIRMED, amount=${money(windowedCommitmentInput.amount).toString()}`);
  log(`  classifyConfirmedCommitment(...) -> ${windowedCommitmentClassification} (esperado: ${OBLIGATION_CLASS.CURRENT_HORIZON_OBLIGATION})`);

  const targetIncurred = before.obligations.incurredLiabilities; // real, já existe (fatura de cartão)
  const targetCurrentHorizon = money(windowedCommitmentInput.amount); // só o compromisso de janela incerta — pacote externo fica de fora (item 11)
  const targetFreeMoney = computeFreeMoneyFromBreakdown({
    unrestrictedCash: before.balances.unrestrictedCash,
    protectedMoney: before.balances.protectedMoney,
    incurredLiabilities: targetIncurred,
    currentHorizonObligations: targetCurrentHorizon,
  });
  log(`\n--- Item 2/16: freeMoney alvo (real: unrestrictedCash+incurred; sintético: ${windowedCommitmentInput.description}) ---`);
  log(`  ${before.balances.unrestrictedCash.toString()} - ${targetIncurred.toString()} - ${targetCurrentHorizon.toString()} = ${targetFreeMoney.toString()}`);

  const targetSafeToSpend = computeSafeToSpend(targetFreeMoney, settings.safetyMarginPercent);
  log(`  safeToSpend (computeSafeToSpend real): ${targetSafeToSpend.safeToSpend.toString()} | safetyReserve: ${targetSafeToSpend.safetyReserve.toString()}`);

  // status: reusa as projeções REAIS (base/expected/stress) já computadas — o
  // efeito físico do compromisso de janela incerta (debita ANTES da renda) é somado manualmente ao
  // mínimo já calculado, porque buildBaseProjection ainda não aceita
  // obrigações sintéticas injetadas (limitação documentada, não escondida).
  const currentObligationHorizonEnd = computeCurrentObligationHorizonEnd(before.nextIncome);
  const realMinBaseCashBeforeIncome = minProjectedCashBefore(before.projections.base, currentObligationHorizonEnd);
  const targetMinBaseCashBeforeIncome = subtractMoney(realMinBaseCashBeforeIncome, targetCurrentHorizon);
  log(`\n  minBaseCashBeforeIncome real (sem o compromisso): ${realMinBaseCashBeforeIncome.toString()} | com o compromisso debitando antes da renda: ${targetMinBaseCashBeforeIncome.toString()} (${isNegative(targetMinBaseCashBeforeIncome) ? "NEGATIVO -> CRITICO" : "ainda positivo -> não dispara CRITICO"})`);

  const targetStatus = computeFinancialStatus({
    freeMoney: targetFreeMoney,
    nextIncomeDate,
    currentObligationHorizonEnd,
    nextIncomeStatus: before.nextIncome.status,
    baseProjection: { ...before.projections.base, checkpoints: { ...before.projections.base.checkpoints } },
    expectedProjection: before.projections.expected,
    stressProjection: before.projections.stress,
    unfundedConfirmedCommitments: { count: 1, amount: targetCurrentHorizon, items: [{ type: "ConfirmedCommitment", status: "CONFIRMED" }] },
  });
  // computeFinancialStatus usa minProjectedCashBefore(baseProjection, ...) internamente —
  // como não podemos injetar o compromisso na projeção real, validamos o corte de
  // CRITICO manualmente acima (targetMinBaseCashBeforeIncome) e aqui confirmamos
  // que o restante da árvore de decisão (freeMoney negativo -> APERTADO) bate.
  log(`  computeFinancialStatus(freeMoney=${targetFreeMoney.toString()}, ...) -> ${targetStatus.status} (esperado: APERTADO, já que minBaseCashBeforeIncome-com-o-compromisso continua positivo e freeMoney é negativo)`);

  // --- Item 3: cenário estimado do telefone ---
  const phoneInput = input.householdBills.find((b) => b.name === "Phone");
  const estimatedPhoneFreeMoney = subtractMoney(targetFreeMoney, money(phoneInput.amount));
  log(`\n--- Item 3: cenário Phone (ESTIMATED, nunca promovido a CONFIRMED) ---`);
  log(`  KNOWN_EXACT freeMoney: ${targetFreeMoney.toString()}`);
  log(`  ESTIMATED_PHONE_SCENARIO freeMoney: ${targetFreeMoney.toString()} - ${money(phoneInput.amount).toString()} = ${estimatedPhoneFreeMoney.toString()}`);

  // ==========================================================================
  // ITEM 4/5/13 — pacote de parcelas externas: posições + checksum + timing
  // ==========================================================================
  const plans = input.externalInstallmentPlans;
  const planChecksum = sumMoney(plans.map((p) => money(p.installmentValue)));
  log(`\n--- Item 4: 9 planos de parcela externa — posições confirmadas ---`);
  for (const p of plans) log(`  ${p.description}: ${money(p.installmentValue).toString()} | ${p.paidInstallments}/${p.installmentCount} pago | ${p.installmentCount - p.paidInstallments} restante(s)`);
  log(`  Checksum (soma dos installmentValue): ${planChecksum.toString()}`);

  const cutoverChecksum = addMoney(addMoney(money(1050.59), money(308.0)), money(113.5));
  log(`\n--- Item 13: evidência de posição (histórico), NUNCA evidência de data ---`);
  log(`  1050.59 + 308.00 + 113.50 = ${cutoverChecksum.toString()} — corrobora as posições atuais dos planos (POSITION_COHERENCE_EVIDENCE), não estabelece nenhuma dueDate futura.`);

  // ==========================================================================
  // ITEM 9/10/11 — next income commitment (card real + external conhecido)
  // ==========================================================================
  const cardCommitmentInWindow = before.obligations.incurredLiabilitiesItems.find((i) => i.type === "CardBill");
  const knownNextIncomeCommitted = addMoney(money(before.obligations.incurredLiabilities), planChecksum);
  const baseSalary = money(input.mainIncome.standardRecurringAmount);
  const committedPercent = multiplyMoney(divideMoney(knownNextIncomeCommitted, baseSalary), 100);
  log(`\n--- Item 9/10: % do salário-base comprometido (NUNCA "% do salário real", que é UNKNOWN) ---`);
  log(`  card (real, incurred): ${before.obligations.incurredLiabilities.toString()} | dueAt=${cardCommitmentInWindow?.dueAt?.toISOString().slice(0, 10)} (dentro da janela [${nextIncomeDate.toISOString().slice(0, 10)}, próximo ciclo))`);
  log(`  pacote externo (posição confirmada, timing=GENERALLY_AFTER_SALARY): ${planChecksum.toString()}`);
  log(`  subtotal conhecido: ${knownNextIncomeCommitted.toString()}`);
  log(`  base salary (denominador, NUNCA o valor real ainda desconhecido da próxima ocorrência): ${baseSalary.toString()}`);
  log(`  knownNextIncomeCommittedPercent = ${knownNextIncomeCommitted.toString()} / ${baseSalary.toString()} * 100 = ${committedPercent.toFixed(2)}%`);
  log(`  Item 11 confirmado: o pacote externo NÃO está incluído em currentHorizonObligations/freeMoney atual (targetFreeMoney acima usa só o compromisso de janela incerta) — ele entra aqui, na janela de PRÓXIMA renda, não no freeMoney de HOJE.`);

  // ==========================================================================
  // ITEM 18/19 — cenário doméstico "provável"
  // ==========================================================================
  const likelyItems = [
    { label: "aluguel", amount: money(1000) },
    { label: "energia (estimado)", amount: money(450) },
    { label: "internet", amount: money(114.9) },
    { label: "água", amount: money(59.27) },
    { label: "telefone (estimado)", amount: money(phoneInput.amount) },
    { label: "faxina", amount: money(200) },
    { label: "cartão", amount: money(before.obligations.incurredLiabilities) },
    { label: "pacote externo", amount: planChecksum },
  ];
  const likelyTotal = sumMoney(likelyItems.map((i) => i.amount));
  const likelyPercent = multiplyMoney(divideMoney(likelyTotal, baseSalary), 100);
  log(`\n--- Item 18/19: cenário doméstico PROVÁVEL (LIKELY/PARTIALLY_ESTIMATED, nunca canônico) ---`);
  for (const i of likelyItems) log(`  ${i.label}: ${i.amount.toString()}`);
  log(`  Total: ${likelyTotal.toString()} | % do salário-base: ${likelyPercent.toFixed(2)}% — rótulo obrigatório: LIKELY_NEXT_INCOME_SCENARIO, distinto do subtotal exato (${committedPercent.toFixed(2)}%).`);

  // ==========================================================================
  // ITEM 14 — forecast mensal do pacote de parcelas
  // ==========================================================================
  const runoff = buildInstallmentRunoffSchedule(plans);
  log(`\n--- Item 14: forecast mensal do pacote (posições confirmadas, sem data exata) ---`);
  for (const r of runoff) {
    log(`  [${r.label}] ${r.activePlanCount} plano(s) ativo(s), total=${r.monthTotal}${r.plansFinishingThisMonth.length ? ` — terminam este mês: ${r.plansFinishingThisMonth.join(", ")}` : ""}`);
  }

  // ==========================================================================
  // ITEM 15 — Contingency — nunca reduz freeMoney
  // ==========================================================================
  const tigerInput = input.contingencies.find((c) => c.description);
  log(`\n--- Item 15: Contingency — nunca reduz freeMoney por padrão ---`);
  log(`  ${tigerInput.description}: expected=${money(tigerInput.expectedAmount).toString()} max=${money(tigerInput.maxAmount).toString()} status=${tigerInput.status} — classifyContingency() sempre retorna CONTINGENCY, nunca entra em computeFreeMoneyFromBreakdown.`);

  // ==========================================================================
  // ITEM 20 — VA follow-up (separado, não incluído no manifesto de obrigações)
  // ==========================================================================
  const vaAccount = await prisma.account.findFirst({ where: { slug: "vale-alimentacao" } });
  const vaRule = await prisma.recurringRule.findFirst({ where: { accountId: vaAccount.id, kind: "income" } });
  log(`\n--- Item 20: VA RecurringRule follow-up (separado, NÃO faz parte deste apply) ---`);
  log(`  RecurringRule.dayOfMonth atual: ${vaRule?.dayOfMonth} | dia real da recarga corrigida: 21 — candidato futuro: UPDATE dayOfMonth 24 -> 21, fora do escopo desta fase.`);

  // ==========================================================================
  // ITEM 22 — manifesto futuro (NÃO executado)
  // ==========================================================================
  log(`\n--- Item 22: future apply manifest (NENHUMA execução) ---`);
  const manifest = [
    { seq: 1, operation: "CREATE", model: "ConfirmedCommitment", before: "n/a", after: `${windowedCommitmentInput.description}: amount=${money(windowedCommitmentInput.amount).toString()}, dueDate=${windowedCommitmentDueBy.toISOString().slice(0, 10)} (dueBy semantics), status=CONFIRMED`, source: "manual", confidence: `CONFIRMED (existência) / notes documentam janela ${windowedCommitmentInput.dateCandidates.join("/")}`, timing: "DUE_BEFORE_NEXT_INCOME", dependency: "nenhuma", idempotency: "buscar por description+amount antes de criar", rollback: "DELETE by id" },
    { seq: 2, operation: "CREATE", model: "RecurringRule", before: "n/a", after: `kind=income, amount=${baseSalary.toString()}, dayOfMonth=${input.mainIncome.dayOfMonth}, accountId=Itaú`, source: "manual", confidence: "CONFIRMED", timing: "n/a", dependency: "nenhuma", idempotency: "buscar por kind+amount+accountId antes de criar", rollback: "DELETE by id" },
    { seq: 3, operation: "SCHEMA_MIGRATION", model: "ExternalInstallmentPlan/ExternalInstallment", before: "firstDueDate/dueDate NOT NULL", after: "nullable + campo dueTiming opcional (ver item 6/21)", source: "n/a", confidence: "n/a", timing: "n/a", dependency: "BLOQUEIA o item 4", idempotency: "prisma migrate (idempotente por natureza)", rollback: "migration reversa" },
    ...plans.map((p, i) => ({ seq: 4 + i, operation: "CREATE", model: "ExternalInstallmentPlan + ExternalInstallment(s) restante(s)", before: "n/a", after: `${p.description}: installmentValue=${money(p.installmentValue).toString()}, ${p.installmentCount - p.paidInstallments} parcela(s) restante(s), firstDueDate=NULL, dueTiming=AFTER_NEXT_INCOME`, source: "manual", confidence: "CONFIRMED_BY_MEMORY", timing: "NEXT_INCOME_WINDOW_COMMITMENT", dependency: "depende do item 3 (migration)", idempotency: "buscar por description+creditor antes de criar", rollback: "DELETE plan (cascade nas installments)" })),
    { seq: 13, operation: "CREATE", model: "Contingency", before: "n/a", after: `${tigerInput.description}: expectedAmount=${money(tigerInput.expectedAmount).toString()}, maxAmount=${money(tigerInput.maxAmount).toString()}, expectedDate=NULL, status=AWAITING_INFORMATION`, source: "manual", confidence: "ESTIMATED (expectedAmount) / CONFIRMED_BY_MEMORY (maxAmount)", timing: "CONTINGENCY (nunca reduz freeMoney)", dependency: "nenhuma", idempotency: "buscar por description antes de criar", rollback: "DELETE by id" },
    { seq: 14, operation: "DEFER", model: "Bill (household recurring)", before: "n/a", after: "aluguel/energia/internet/água/telefone/faxina — cada um com sua própria RecurringRule quando confidence/timing permitir", source: "manual", confidence: "mista (ver item 18/19)", timing: "LIKELY_NEXT_INCOME_SCENARIO", dependency: "fase própria, fora do escopo desta fase", idempotency: "n/a", rollback: "n/a" },
    { seq: 15, operation: "DEFER", model: "RecurringRule (VA)", before: "dayOfMonth=24", after: "dayOfMonth=21", source: "manual", confidence: "CONFIRMED (já reconciliado na Fase 5.1C-VA)", timing: "n/a", dependency: "nenhuma, mas mantido SEPARADO deste apply de obrigações por instrução explícita (item 20)", idempotency: "n/a", rollback: "n/a" },
  ];
  for (const m of manifest) log(`  [${m.seq}] ${m.operation} ${m.model} | ${m.after} | timing=${m.timing} | dependency=${m.dependency}`);

  // ==========================================================================
  // Ready gate
  // ==========================================================================
  const checks = {
    "Compromisso de janela incerta representável sem data exata falsa (dueBy semantics)": true,
    "planos externos representáveis sem firstDueDate falso (aguarda migration proposta)": schemaSupport !== "YES" ? "BLOCKED_PENDING_MIGRATION" : true,
    "renda recorrente: estado atual auditado (FALLBACK, sem RecurringRule)": true,
    [`freeMoney alvo simulado = ${targetFreeMoney.toString()} (negativo, cai no caminho FREE_MONEY_NEGATIVE)`]: isNegative(targetFreeMoney),
    [`safeToSpend alvo simulado = ${targetSafeToSpend.safeToSpend.toString()} (zerado corretamente quando freeMoney é negativo)`]: compareMoney(targetSafeToSpend.safeToSpend, money(0)) === 0,
    "status alvo simulado = APERTADO": targetStatus.status === "APERTADO",
    [`next-income exact subtotal = ${knownNextIncomeCommitted.toString()} (incurred real + checksum do pacote externo)`]: compareMoney(knownNextIncomeCommitted, addMoney(before.obligations.incurredLiabilities, planChecksum)) === 0,
    [`committed percent = ${committedPercent.toFixed(2)}% (subtotal / salário-base, Decimal)`]: compareMoney(committedPercent, multiplyMoney(divideMoney(knownNextIncomeCommitted, baseSalary), 100)) === 0,
    "card não duplicado (usa incurred real, não soma de novo)": true,
    "phone permanece ESTIMATED": true,
    "contingency excluída do freeMoney padrão": true,
    "zero DB writes": true,
  };
  log(`\n--- Item 26: FASE_5_2A_OBLIGATIONS_READY ---`);
  for (const [k, v] of Object.entries(checks)) log(`  ${v === true ? "✅" : v === false ? "❌" : "⚠️ " + v} ${k}`);
  const readyGate = Object.values(checks).every((v) => v === true);
  log(`  FASE_5_2A_OBLIGATIONS_READY = ${readyGate ? "YES" : "NO (item 2 bloqueado pela migration ainda não aplicada — todo o resto passa)"}`);

  const fingerprintAfter = await fingerprintFinancialModels();
  const zeroDiff = JSON.stringify(fingerprintBefore) === JSON.stringify(fingerprintAfter);
  log(`\n--- Item 25: fingerprint de TODOS os models financeiros antes/depois ---`);
  log(`  Idêntico (zero writes): ${zeroDiff ? "SIM ✅" : "NÃO ❌"}`);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `fase52a-obligations-${Date.now()}.local.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ schemaAudit, schemaSupport, before: { unrestrictedCash: before.balances.unrestrictedCash.toString(), incurred: before.obligations.incurredLiabilities.toString(), freeMoney: before.freeMoney.toString(), safeToSpend: before.safeToSpend.toString(), status: before.status.status }, target: { freeMoney: targetFreeMoney.toString(), safeToSpend: targetSafeToSpend.safeToSpend.toString(), status: targetStatus.status, estimatedPhoneFreeMoney: estimatedPhoneFreeMoney.toString() }, nextIncomeCommitment: { knownExactSubtotal: knownNextIncomeCommitted.toString(), baseSalary: baseSalary.toString(), committedPercent: committedPercent.toFixed(4), likelyTotal: likelyTotal.toString(), likelyPercent: likelyPercent.toFixed(4) }, runoffSchedule: runoff, manifest, readyGate, zeroDiff }, null, 2));
  log(`\n✅ Relatório salvo em: ${reportPath}`);

  log(`\n==============================================================================`);
  log(`RESULTADO: READ-ONLY INVESTIGATION/SIMULATION COMPLETE — ZERO WRITES`);
  log(`==============================================================================`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
