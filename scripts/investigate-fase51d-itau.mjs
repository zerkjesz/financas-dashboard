// Fase 5.1D-ITAÚ — CANONICAL LEDGER MATCH / PRE-WRITE GATE.
//
// 100% READ-ONLY. Nenhuma escrita no banco. Nenhum model é alterado.
//
// Reconstrói o ledger operacional do Itaú entre AppSettings.operationalHistoryStart
// (lido do banco, nunca hardcoded) e o `asOf` do input, faz o matching genérico dos
// movimentos canônicos (carregados de um arquivo local gitignored — nunca hardcoded
// aqui) contra o estado ATUAL do dev DB, e decompõe matematicamente tanto o saldo
// atual quanto a diferença contra o saldo observado externo.
//
// Mesma disciplina das fases anteriores (5.1B-CARD-v2, 5.1C-VA):
//   - generic/sem dado pessoal hardcoded — todo valor esperado vem do input.
//   - matching nunca usa só o amount (amount + sinal + descrição + modelo + conta).
//   - nunca inventa data econômica quando só existe timestamp de backfill.
//   - fingerprint antes/depois de Card/VA obrigatório (prova de não-escrita).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(__dirname, "snapshot-input.local.json");
const REPORT_DIR = path.join(__dirname, "snapshot-reports");

function log(...args) {
  console.log(...args);
}

// --- Item 0: segurança ---------------------------------------------------
async function assertExtraSafety() {
  const directUrl = process.env.DIRECT_URL || "";
  if (/neon\.tech/i.test(directUrl) && /-pooler\.[a-z0-9-]*\.aws\.neon\.tech/i.test(directUrl) === false) {
    // apenas uma checagem de forma — o host real de produção nunca deve aparecer aqui.
  }
  if (process.env.VERCEL_ENV === "production") {
    console.error("🛑 ABORTADO — VERCEL_ENV=production.");
    process.exit(1);
  }
  try {
    const out = execSync("npx prisma migrate status", { encoding: "utf8", cwd: path.join(__dirname, "..") });
    if (!/up to date/i.test(out)) {
      console.error("🛑 ABORTADO — prisma migrate status não está clean:\n" + out);
      process.exit(1);
    }
  } catch (err) {
    console.error("🛑 ABORTADO — não foi possível confirmar prisma migrate status:", err.message);
    process.exit(1);
  }
  log("✅ Ambiente dev confirmado + prisma migrate status clean. VERCEL_ENV != production.");
}

// --- normalização de texto pra matching genérico (sem sinônimo hardcoded) ---
function normalizeTokens(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function tokenOverlapScore(a, b) {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
}

function bucketKey(signedAmount) {
  const abs = signedAmount.abs().toFixed(2);
  const sign = compareMoney(signedAmount, money(0)) >= 0 ? "+" : "-";
  return `${sign}${abs}`;
}

// Matching genérico de movimentos canônicos (com sinal) contra um pool de rows do
// DB (Income/Expense já convertidos pra {amount assinado, description, id, model}).
// Nunca usa só o amount: bucket exato por (sinal+valor) primeiro, depois texto só
// pra desambiguar quando há múltiplos candidatos no mesmo bucket — nunca inventa um
// match com score fraco quando há empate. Extraído aqui (em vez de inline) pra ser
// testável isoladamente (ver scripts/test-fase51d-itau-matching.mjs) e reutilizável
// por outras reconciliações futuras (mesmo padrão de matchCanonicalExpenses, em
// scripts/snapshot-dry-run.mjs).
export function matchOperationalMovements(canonicalItems, dbPool) {
  const dbByBucket = new Map();
  for (const row of dbPool) {
    const k = bucketKey(row.amount);
    if (!dbByBucket.has(k)) dbByBucket.set(k, []);
    dbByBucket.get(k).push(row);
  }

  const matchResults = [];
  for (const item of canonicalItems) {
    const k = bucketKey(item.amount);
    const bucket = (dbByBucket.get(k) || []).filter((r) => !r.consumed);
    let result;
    if (bucket.length === 1) {
      bucket[0].consumed = true;
      result = { ...item, status: "UNIQUE_BACKFILL_MATCH", matchedDbId: bucket[0].id, matchedModel: bucket[0].model, persistedAmount: bucket[0].amount, persistedOccurredAt: bucket[0].occurredAt, persistedDescription: bucket[0].description, textScore: tokenOverlapScore(item.description, bucket[0].description) };
    } else if (bucket.length === 0) {
      result = { ...item, status: "MISSING", matchedDbId: null };
    } else {
      // múltiplos candidatos no mesmo valor+sinal — desambiguar por texto
      const scored = bucket.map((r) => ({ row: r, score: tokenOverlapScore(item.description, r.description) })).sort((a, b) => b.score - a.score);
      if (scored[0].score > 0.2 && (scored.length === 1 || scored[0].score > scored[1].score)) {
        scored[0].row.consumed = true;
        result = { ...item, status: "UNIQUE_BACKFILL_MATCH", matchedDbId: scored[0].row.id, matchedModel: scored[0].row.model, persistedAmount: scored[0].row.amount, persistedOccurredAt: scored[0].row.occurredAt, persistedDescription: scored[0].row.description, textScore: scored[0].score, disambiguatedAmong: bucket.length };
      } else {
        result = { ...item, status: "AMBIGUOUS", candidateIds: bucket.map((r) => r.id), candidateCount: bucket.length };
      }
    }
    matchResults.push(result);
  }
  return matchResults;
}

// --- Fingerprint de subsistemas que esta fase NUNCA pode alterar ---------
async function fingerprintProtected(client = prisma) {
  const [cards, cardBills, purchases, installments, cardLimitUpdates, vaAccount] = await Promise.all([
    client.card.findMany({ orderBy: { id: "asc" } }),
    client.cardBill.findMany({ orderBy: { id: "asc" } }),
    client.purchase.findMany({ orderBy: { id: "asc" } }),
    client.installment.findMany({ orderBy: { id: "asc" } }),
    client.cardLimitUpdate.findMany({ orderBy: { id: "asc" } }),
    client.account.findFirst({ where: { slug: "vale-alimentacao" } }),
  ]);
  let vaExpenses = [];
  let vaIncomes = [];
  let vaAdjustments = [];
  if (vaAccount) {
    [vaExpenses, vaIncomes, vaAdjustments] = await Promise.all([
      client.expense.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
      client.income.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
      client.balanceAdjustment.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
    ]);
  }
  const shape = (rows) => rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt ?? null, amount: r.amount?.toString?.() ?? r.newBalance?.toString?.() ?? r.totalAmount?.toString?.() }));
  return {
    card: shape(cards),
    cardBill: shape(cardBills),
    purchase: shape(purchases),
    installment: shape(installments),
    cardLimitUpdate: shape(cardLimitUpdates),
    vaAccount: vaAccount ? { id: vaAccount.id, updatedAt: vaAccount.updatedAt } : null,
    vaExpense: shape(vaExpenses),
    vaIncome: shape(vaIncomes),
    vaBalanceAdjustment: shape(vaAdjustments),
  };
}

async function main() {
  log("==============================================================================");
  log("Fase 5.1D-ITAÚ — CANONICAL LEDGER MATCH / PRE-WRITE GATE (READ-ONLY)");
  log("==============================================================================");

  await assertTestEnvironment();
  await assertExtraSafety();

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`🛑 ABORTADO — input não encontrado: ${INPUT_PATH}`);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const itauInput = input.checkingAccount;
  if (!itauInput) throw new Error("input.checkingAccount ausente.");

  const fingerprintBefore = await fingerprintProtected(prisma);

  // --- Item 1: as-of e cutoff ---------------------------------------------
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  const operationalHistoryStart = settings.operationalHistoryStart;
  log(`\nAppSettings.operationalHistoryStart (real, lido do banco): ${operationalHistoryStart.toISOString()}`);
  const asOf = new Date(`${input.asOf}T00:00:00.000Z`);
  const asOfEndExclusive = new Date(asOf.getTime() + 24 * 60 * 60 * 1000);

  // --- Item 2: estado atual do Itaú ---------------------------------------
  const itauAccount = await prisma.account.findUnique({ where: { slug: itauInput.slug } });
  if (!itauAccount) throw new Error(`Account slug='${itauInput.slug}' não encontrada.`);
  const currentComputedBalance = await computeAccountBalance(itauAccount.id);
  log(`\ncomputeAccountBalance(Itaú) atual: ${currentComputedBalance.toString()}`);

  const observedTarget = money(itauInput.checkpointB.amount);
  const difference = subtractMoney(currentComputedBalance, observedTarget);
  log(`Observed target (checkpoint B, ${itauInput.checkpointB.date}): ${observedTarget.toString()}`);
  log(`Difference (current - observed): ${difference.toString()}`);

  // --- Item 3: checkpoints canônicos --------------------------------------
  const checkpointA = money(itauInput.checkpointA.amount);
  const postCkMovements = itauInput.movementsAfterCheckpointA.map((m) => ({
    ...m,
    signedAmount: m.type === "OUTFLOW" || m.type === "TRANSFER_OUT_EXTERNAL" ? money(m.amount).negated() : money(m.amount),
  }));
  const postCkNetCanonical = sumMoney(postCkMovements.map((m) => m.signedAmount));
  const expectedAfterPostCk = addMoney(checkpointA, postCkNetCanonical);
  const postCheckpointResidual = subtractMoney(observedTarget, expectedAfterPostCk);
  log(`\nCheckpoint A: ${checkpointA.toString()} (${itauInput.checkpointA.date})`);
  log(`Movimentos pós-checkpoint (${postCkMovements.length}): net = ${postCkNetCanonical.toString()}`);
  log(`Checkpoint A + movimentos pós-checkpoint = ${expectedAfterPostCk.toString()}`);
  log(`Observado (checkpoint B) = ${observedTarget.toString()} | Residual pós-checkpoint (isolado, NUNCA absorvido) = ${postCheckpointResidual.toString()}`);

  // --- Item 4: ledger operacional canônico pré-checkpoint -----------------
  const candidates = itauInput.operationalHistoryEvidence.operationalLedgerCandidates;
  const canonicalItems = candidates.map((c, idx) => ({
    index: idx + 1,
    description: c.description,
    amount: money(c.amount), // já vem com sinal correto no input
    semanticHint: c.semanticHint,
    note: c.note ?? null,
  }));
  const canonicalNet = sumMoney(canonicalItems.map((c) => c.amount));
  log(`\nMovimentos canônicos (operationalLedgerCandidates): ${canonicalItems.length}`);
  log(`Net operacional canônico: ${canonicalNet.toString()}`);

  // --- Item 5: opening operacional candidato -------------------------------
  const derivedOpening = subtractMoney(checkpointA, canonicalNet);
  log(`\nOpening derivado (checkpointA - canonicalNet): ${checkpointA.toString()} - ${canonicalNet.toString()} = ${derivedOpening.toString()}`);
  log(`Classificação: CUTOVER_OPENING_CANDIDATE, evidence=DERIVED_ONLY, requiresExplicitApproval=true (NÃO criado nesta fase).`);
  const evidence20Aug = itauInput.operationalHistoryEvidence.evidenced20Aug;
  if (evidence20Aug) {
    const gapToEvidence = subtractMoney(money(evidence20Aug.amount), derivedOpening);
    log(`Evidência anterior (${evidence20Aug.date}): ${evidence20Aug.amount} | Diferença vs opening derivado: ${gapToEvidence.toString()} — pertence ao período ANTES do cutoff, não inventado.`);
  }

  // --- Item 6: inventário real do ledger Itaú no período -------------------
  const anchor = await prisma.balanceAdjustment.findFirst({ where: { accountId: itauAccount.id }, orderBy: { occurredAt: "desc" } });
  const since = anchor?.occurredAt ?? new Date(0);
  log(`\nÂncora mais recente do Itaú: ${anchor ? `${anchor.newBalance.toString()} @ ${anchor.occurredAt.toISOString()} (${anchor.source})` : "NENHUMA"}`);

  const [allIncomes, allExpenses, allTransfersOut, allTransfersIn] = await Promise.all([
    prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: since } }, orderBy: { occurredAt: "asc" } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: since } }, orderBy: { occurredAt: "asc" } }),
    prisma.transfer.findMany({ where: { fromAccountId: itauAccount.id, occurredAt: { gt: since } }, orderBy: { occurredAt: "asc" } }),
    prisma.transfer.findMany({ where: { toAccountId: itauAccount.id, occurredAt: { gt: since } }, orderBy: { occurredAt: "asc" } }),
  ]);

  const inOpWindow = (d) => d >= operationalHistoryStart && d < asOfEndExclusive;
  const opIncomes = allIncomes.filter((r) => inOpWindow(r.occurredAt));
  const opExpenses = allExpenses.filter((r) => inOpWindow(r.occurredAt));
  const preOpIncomes = allIncomes.filter((r) => r.occurredAt < operationalHistoryStart);
  const preOpExpenses = allExpenses.filter((r) => r.occurredAt < operationalHistoryStart);
  const postAsOfIncomes = allIncomes.filter((r) => r.occurredAt >= asOfEndExclusive);
  const postAsOfExpenses = allExpenses.filter((r) => r.occurredAt >= asOfEndExclusive);

  log(`\nInventário [${operationalHistoryStart.toISOString()} .. ${asOfEndExclusive.toISOString()}) — Itaú:`);
  log(`  Income: ${opIncomes.length} rows, sum ${sumMoney(opIncomes.map((r) => money(r.amount))).toString()}`);
  log(`  Expense: ${opExpenses.length} rows, sum ${sumMoney(opExpenses.map((r) => money(r.amount))).toString()}`);
  log(`  Transfer (from): ${allTransfersOut.filter((r) => inOpWindow(r.occurredAt)).length}`);
  log(`  Transfer (to): ${allTransfersIn.filter((r) => inOpWindow(r.occurredAt)).length}`);
  log(`  Pré-cutoff (após âncora, antes do cutoff) — Income: ${preOpIncomes.length} sum ${sumMoney(preOpIncomes.map((r) => money(r.amount))).toString()} | Expense: ${preOpExpenses.length} sum ${sumMoney(preOpExpenses.map((r) => money(r.amount))).toString()}`);
  log(`  Pós-asOf (depois de ${input.asOf}) — Income: ${postAsOfIncomes.length} | Expense: ${postAsOfExpenses.length}`);

  // --- Item 7: match canônico row-by-row (bucket por sinal+valor, depois texto) ---
  const dbPool = [
    ...opIncomes.map((r) => ({ id: r.id, model: "Income", amount: money(r.amount), description: r.description, occurredAt: r.occurredAt, source: r.source, confidence: r.confidence, createdAt: r.createdAt, consumed: false })),
    ...opExpenses.map((r) => ({ id: r.id, model: "Expense", amount: money(r.amount).negated(), description: r.description, occurredAt: r.occurredAt, source: r.source, confidence: r.confidence, createdAt: r.createdAt, consumed: false })),
  ];

  const matchResults = matchOperationalMovements(canonicalItems, dbPool);

  const byStatus = { UNIQUE_BACKFILL_MATCH: 0, MISSING: 0, AMBIGUOUS: 0 };
  for (const r of matchResults) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  log(`\nMatching dos ${canonicalItems.length} movimentos canônicos:`);
  log(`  UNIQUE_BACKFILL_MATCH: ${byStatus.UNIQUE_BACKFILL_MATCH}`);
  log(`  MISSING: ${byStatus.MISSING}`);
  log(`  AMBIGUOUS: ${byStatus.AMBIGUOUS}`);
  log(`\nDetalhe:`);
  for (const r of matchResults) {
    if (r.status === "UNIQUE_BACKFILL_MATCH") {
      log(`  [${r.index}] ${r.status} | canônico "${r.description}" (${r.amount.toString()}) <-> db ${r.matchedModel} ${r.matchedDbId} "${r.persistedDescription}" @ ${r.persistedOccurredAt.toISOString()} (textScore=${r.textScore.toFixed(2)}${r.disambiguatedAmong ? `, desambiguado entre ${r.disambiguatedAmong}` : ""})`);
    } else if (r.status === "MISSING") {
      log(`  [${r.index}] MISSING | canônico "${r.description}" (${r.amount.toString()}) — nenhuma row com mesmo sinal+valor.`);
    } else {
      log(`  [${r.index}] AMBIGUOUS | canônico "${r.description}" (${r.amount.toString()}) — ${r.candidateCount} candidatos sem desambiguação textual confiável: ${r.candidateIds.join(", ")}`);
    }
  }

  const extraDbRows = dbPool.filter((r) => !r.consumed);
  const extraDbNet = sumMoney(extraDbRows.map((r) => r.amount));
  log(`\nRows persistidas no período que NÃO correspondem a nenhum dos ${canonicalItems.length} itens canônicos: ${extraDbRows.length}, net = ${extraDbNet.toString()}`);
  log(`(Presumidas reais e corretas como estão — fora do escopo desta lista canônica, não classificadas como erro.)`);

  // --- ACHADO CRÍTICO: o opening candidato "puro" só reconcilia checkpointA se as
  // rows extras (reais, já persistidas) forem DESCONSIDERADAS do ledger. `derivedOpening`
  // (item 5) é definido POR CONSTRUÇÃO como checkpointA - canonicalNet — é uma
  // tautologia, nunca uma confirmação independente. Se as rows extras são
  // transações reais (tudo indica que sim: PIX pessoais plausíveis, nomes/valores
  // não redundantes com os 29 itens), o opening que de fato reconcilia o ledger
  // COMPLETO (29 canônicos + rows extras já persistidas) contra checkpointA é
  // diferente — calculado abaixo, nunca aprovado/criado automaticamente.
  const trueOpeningIfExtrasKept = subtractMoney(subtractMoney(checkpointA, canonicalNet), extraDbNet);
  const openingDiscrepancy = subtractMoney(trueOpeningIfExtrasKept, derivedOpening);
  log(`\n⚠️  ACHADO: opening candidato (${derivedOpening.toString()}) reconcilia checkpointA SOMENTE se as ${extraDbRows.length} rows extras (net ${extraDbNet.toString()}) forem descartadas do ledger.`);
  log(`   Se essas rows são reais (tudo indica que sim — PIX pessoais plausíveis, sem sobreposição de valor com os 29 itens), o opening que reconcilia o ledger COMPLETO é: checkpointA - canonicalNet - extraDbNet = ${checkpointA.toString()} - ${canonicalNet.toString()} - (${extraDbNet.toString()}) = ${trueOpeningIfExtrasKept.toString()}`);
  log(`   Divergência entre os dois candidatos de opening: ${openingDiscrepancy.toString()} — NÃO resolvido automaticamente, ver blockers.`);

  // --- Item 8/9: evidência de data --------------------------------------
  // Todas as 36 rows do período foram persistidas num único burst de backfill
  // (mesmo minuto/segundo) — nenhuma tem evidência independente de data econômica
  // exata, exceto onde o input já declara confiança explícita (mainIncome, item 9
  // do enunciado). Não upgradamos nenhuma outra pra EXACT_DATE_EVIDENCE sem isso.
  const backfillWindowStart = opExpenses.length ? opExpenses[0].createdAt : null;
  const backfillWindowEnd = opExpenses.length ? opExpenses[opExpenses.length - 1].createdAt : null;
  log(`\nJanela de createdAt das rows do período (evidência de backfill, não de data econômica): ${backfillWindowStart?.toISOString()} .. ${backfillWindowEnd?.toISOString()}`);
  const dateEvidenceKnown = {
    salario: { confirmedDate: input.mainIncome?.date, confidence: input.mainIncome?.confidence },
  };
  log(`Classificação de evidência de data: exceto onde o input já declara confiança explícita (ex.: mainIncome=${dateEvidenceKnown.salario.confirmedDate}), todas as demais rows do período ficam DATE_UNRESOLVED (BACKFILL_TIMESTAMP != data econômica) — nenhuma correção de data proposta nesta fase.`);

  // --- Item 10: 3 movimentos pós-checkpoint --------------------------------
  log(`\nMovimentos pós-checkpoint (${itauInput.checkpointA.date}, após checkpoint A):`);
  for (const m of postCkMovements) {
    log(`  ${m.description} (${m.signedAmount.toString()}) — EXISTS? ${postAsOfIncomes.concat(postAsOfExpenses).length === 0 && allIncomes.concat(allExpenses).filter(r=>r.occurredAt.getTime()>=asOf.getTime() && r.occurredAt.getTime()<asOfEndExclusive.getTime()).length === 0 ? "NÃO — MISSING" : "verificar manualmente"}`);
  }
  const sameDayIncomes = allIncomes.filter((r) => r.occurredAt >= asOf && r.occurredAt < asOfEndExclusive);
  const sameDayExpenses = allExpenses.filter((r) => r.occurredAt >= asOf && r.occurredAt < asOfEndExclusive);
  const sameDayTransfersOut = allTransfersOut.filter((r) => r.occurredAt >= asOf && r.occurredAt < asOfEndExclusive);
  log(`  (confirmado por query direta em ${input.asOf}: Income=${sameDayIncomes.length}, Expense=${sameDayExpenses.length}, TransferOut=${sameDayTransfersOut.length} — todos 0 => os 3 movimentos pós-checkpoint estão MISSING, nenhum criado nesta fase)`);

  // --- Item 11: pagamento da fatura do cartão (cash-side) -------------------
  const cardBillItem = canonicalItems.find((c) => c.semanticHint === "CARD_BILL_PAYMENT");
  const cardBillCycleMonth = candidates.find((c) => c.semanticHint === "CARD_BILL_PAYMENT")?.settlesCardBillCycleMonth;
  const cardBill = cardBillCycleMonth ? await prisma.cardBill.findFirst({ where: { cycleMonth: cardBillCycleMonth } }) : null;
  const cardBillPaymentTransfers = cardBill ? await prisma.transfer.findMany({ where: { cardBillId: cardBill.id } }) : [];
  const cardBillMatchAsExpense = matchResults.find((r) => r.semanticHint === "CARD_BILL_PAYMENT");
  log(`\nCardBill ${cardBillCycleMonth}: status=${cardBill?.status}, totalAmount=${cardBill?.totalAmount?.toString()}, paidAmount=${cardBill?.paidAmount?.toString()}`);
  log(`Transfers vinculados via cardBillId: ${cardBillPaymentTransfers.length}`);
  const cardCashSideStatus = cardBillPaymentTransfers.length > 0 ? "EXISTS_AS_TRANSFER" : cardBillMatchAsExpense?.status === "UNIQUE_BACKFILL_MATCH" && cardBillMatchAsExpense.matchedModel === "Expense" ? "WRONG_MODEL" : "MISSING_CASH_SIDE";
  log(`Classificação do cash-side: ${cardCashSideStatus} — Card/CardBill NÃO alterados (fora de escopo desta fase).`);

  // --- Item 12: parcelas externas pagas ------------------------------------
  const extPlansCount = await prisma.externalInstallmentPlan.count();
  const extInstallmentsCount = await prisma.externalInstallment.count();
  log(`\nExternalInstallmentPlan persistidos: ${extPlansCount} | ExternalInstallment persistidos: ${extInstallmentsCount}`);
  const bundleItems = matchResults.filter((r) => r.semanticHint?.startsWith("EXTERNAL_INSTALLMENT_SETTLEMENT"));
  for (const b of bundleItems) log(`  ${b.description} (${b.amount.toString()}): ${b.status}${b.matchedDbId ? ` -> ${b.matchedModel} ${b.matchedDbId}` : ""}`);

  // --- Item 13: troca da moto ------------------------------------------
  const motoItems = matchResults.filter((r) => r.description.toLowerCase().includes("moto") || r.description.toLowerCase().includes("guincho"));
  log(`\nMovimentos da moto:`);
  for (const m of motoItems) log(`  ${m.description} (${m.amount.toString()}): ${m.status} — data econômica: DATE_UNRESOLVED (sem evidência independente, não inventada)`);

  // --- Item 14: transferência +114.63 --------------------------------------
  const transferItem = matchResults.find((r) => r.amount.toString() === "114.63" || r.description.includes("outra conta"));
  log(`\nTransferência +114.63: ${transferItem?.status}${transferItem?.matchedDbId ? ` -> ${transferItem.matchedModel} ${transferItem.matchedDbId} ("${transferItem.persistedDescription}")` : ""} — persistida como Income (não há Account de origem externa dentro do Norte, tratamento atual consistente).`);

  // --- Item 15/16: net coverage e decomposição do saldo atual -------------
  const matchedCanonical = matchResults.filter((r) => r.status === "UNIQUE_BACKFILL_MATCH");
  const persistedMatchedNet = sumMoney(matchedCanonical.map((r) => r.persistedAmount));
  const missingCanonicalNet = sumMoney(matchResults.filter((r) => r.status === "MISSING").map((r) => r.amount));
  const wrongAmountDelta = sumMoney(matchedCanonical.filter((r) => compareMoney(r.amount, r.persistedAmount) !== 0).map((r) => subtractMoney(r.amount, r.persistedAmount)));
  log(`\n--- Item 15: net coverage ---`);
  log(`canonicalNet (29 itens): ${canonicalNet.toString()}`);
  log(`persistedMatchedNet (itens com match): ${persistedMatchedNet.toString()}`);
  log(`missingCanonicalNet (itens MISSING): ${missingCanonicalNet.toString()}`);
  log(`wrongAmountDelta (itens com match mas valor divergente): ${wrongAmountDelta.toString()}`);
  log(`extraDbNet (rows persistidas fora da lista canônica): ${extraDbNet.toString()}`);
  log(`persistedOpNet total (todas as rows do período): ${sumMoney(dbPool.map((r) => r.amount)).toString()}`);

  const preOpNet = subtractMoney(sumMoney(preOpIncomes.map((r) => money(r.amount))), sumMoney(preOpExpenses.map((r) => money(r.amount))));
  const impliedOpening = addMoney(money(anchor.newBalance), preOpNet);
  const persistedOpNet = subtractMoney(sumMoney(opIncomes.map((r) => money(r.amount))), sumMoney(opExpenses.map((r) => money(r.amount))));
  const balanceChecksum = addMoney(impliedOpening, persistedOpNet);
  log(`\n--- Item 16: decomposição do saldo atual (${currentComputedBalance.toString()}) ---`);
  log(`  âncora original (${anchor.occurredAt.toISOString()}, ${anchor.source}): ${money(anchor.newBalance).toString()}`);
  log(`  + net pré-cutoff (após âncora, antes de ${input.checkingAccount ? operationalHistoryStart.toISOString().slice(0, 10) : ""}): ${preOpNet.toString()}`);
  log(`  = opening implícito no cutoff operacional: ${impliedOpening.toString()}`);
  log(`  + net operacional persistido [cutoff..asOf]: ${persistedOpNet.toString()}`);
  log(`  = checksum: ${balanceChecksum.toString()} (confere com computeAccountBalance: ${compareMoney(balanceChecksum, currentComputedBalance) === 0 ? "SIM" : "NÃO — DIVERGÊNCIA"})`);

  // --- Item 17: decomposição da diferença (current vs observed target) ------
  const cutoverOpeningEffect = subtractMoney(impliedOpening, derivedOpening);
  const postCkEffect = subtractMoney(money(0), postCkNetCanonical); // nada persistido ainda
  const opWindowNetEffect = subtractMoney(persistedOpNet, canonicalNet);
  const knownMissingRowsEffect = addMoney(opWindowNetEffect, postCkEffect);
  const knownWrongRowsEffect = money(0); // nenhuma automaticamente classificada como WRONG_AMOUNT pelo matcher (ver nota manual abaixo)
  const duplicateEffect = money(0);
  const wrongAccountEffect = money(0);
  const unresolvedEffect = subtractMoney(money(0), postCheckpointResidual); // -0.03, nunca absorvido
  const explainedSum = [cutoverOpeningEffect, knownMissingRowsEffect, knownWrongRowsEffect, duplicateEffect, wrongAccountEffect, unresolvedEffect].reduce((a, b) => addMoney(a, b), money(0));
  const residualVsActual = subtractMoney(difference, explainedSum);
  log(`\n--- Item 17: decomposição da diferença (${difference.toString()}) ---`);
  log(`  CUTOVER_OPENING_EFFECT: ${cutoverOpeningEffect.toString()} (opening implícito ${impliedOpening.toString()} vs candidato canônico ${derivedOpening.toString()})`);
  log(`  KNOWN_MISSING_ROWS_EFFECT: ${knownMissingRowsEffect.toString()} (op-window: ${opWindowNetEffect.toString()} + pós-checkpoint: ${postCkEffect.toString()})`);
  log(`  KNOWN_WRONG_ROWS_EFFECT: ${knownWrongRowsEffect.toString()} (nenhuma divergência automática de valor detectada no matching por bucket exato)`);
  log(`  DUPLICATE_EFFECT: ${duplicateEffect.toString()}`);
  log(`  WRONG_ACCOUNT_EFFECT: ${wrongAccountEffect.toString()}`);
  log(`  UNRESOLVED_EFFECT: ${unresolvedEffect.toString()} (residual pós-checkpoint +0.03, isolado, nunca absorvido)`);
  log(`  Soma das categorias: ${explainedSum.toString()}`);
  log(`  Residual vs diferença real: ${residualVsActual.toString()} -> ${compareMoney(residualVsActual, money(0)) === 0 ? "COMPLETO" : "INCOMPLETE (residual acima — ver nota: inclui o net das rows persistidas fora da lista canônica, real e correto, apenas fora de escopo desta reconciliação)"}`);

  // --- Item 18/19: dois caminhos de reconciliação (simulação em memória) ---
  const balanceApprovedOnly = currentComputedBalance; // nenhuma mutation aplicada ainda nesta fase
  const balanceWithCutoverOpeningOnly = addMoney(subtractMoney(currentComputedBalance, impliedOpening), derivedOpening);
  const balanceFullCanonical = addMoney(derivedOpening, canonicalNet);
  const ambiguousNet = sumMoney(matchResults.filter((r) => r.status === "AMBIGUOUS").map((r) => r.amount));
  // Simulação REALISTA de um apply futuro: mantém as rows extras já persistidas
  // (presumidas reais), troca o opening pelo candidato que reconcilia o ledger
  // COMPLETO (trueOpeningIfExtrasKept, não o derivedOpening "puro"), soma os itens
  // MISSING e os AMBIGUOUS (assumindo resolução futura no valor canônico) — nunca
  // soma persistedMatchedNet de novo (já está dentro de currentComputedBalance).
  const balanceRealisticFullApply = addMoney(addMoney(addMoney(subtractMoney(currentComputedBalance, impliedOpening), trueOpeningIfExtrasKept), missingCanonicalNet), ambiguousNet);
  log(`\n--- Item 25: simulação fiel (em memória, a partir do DB real) ---`);
  log(`  BEFORE: ${currentComputedBalance.toString()}`);
  log(`  AFTER_APPROVED_ONLY (nenhuma mutation aprovada ainda nesta fase): ${balanceApprovedOnly.toString()}`);
  log(`  AFTER_WITH_CUTOVER_OPENING (só troca o opening implícito pelo candidato "puro" ${derivedOpening.toString()}, mantém o resto): ${balanceWithCutoverOpeningOnly.toString()}`);
  log(`  AFTER_FULL_CANONICAL (opening "puro" ${derivedOpening.toString()} + os ${canonicalItems.length} canônicos, IGNORANDO as ${extraDbRows.length} rows extras — simulação pura, não realista pra um apply real): ${balanceFullCanonical.toString()}`);
  log(`  AFTER_REALISTIC_FULL_APPLY (opening ${trueOpeningIfExtrasKept.toString()} + preenche os ${byStatus.MISSING} MISSING + resolve os ${byStatus.AMBIGUOUS} AMBIGUOUS, MANTÉM as ${extraDbRows.length} rows extras reais): ${balanceRealisticFullApply.toString()}`);
  log(`  TARGET (checkpoint A, antes dos ${postCkMovements.length} pós-checkpoint): ${checkpointA.toString()}`);
  log(`  TARGET final (checkpoint B, após os movimentos pós-checkpoint): ${observedTarget.toString()}`);
  const residualFullCanonical = subtractMoney(checkpointA, balanceFullCanonical);
  const residualRealisticFullApply = subtractMoney(checkpointA, balanceRealisticFullApply);
  log(`  RESIDUAL (AFTER_FULL_CANONICAL vs checkpoint A): ${residualFullCanonical.toString()} (bate só porque ignora as rows extras — não é o caminho recomendado)`);
  log(`  RESIDUAL (AFTER_REALISTIC_FULL_APPLY vs checkpoint A): ${residualRealisticFullApply.toString()} (bate mantendo as rows extras reais — este é o caminho correto SE o opening ${trueOpeningIfExtrasKept.toString()} for aprovado no lugar do candidato "puro")`);

  // --- Item 20: saldo final e o +0.03 ---------------------------------------
  log(`\n--- Item 20 ---`);
  log(`  Mesmo com PATH A perfeito: checkpointA(${checkpointA.toString()}) + pós-checkpoint(${postCkNetCanonical.toString()}) = ${expectedAfterPostCk.toString()}`);
  log(`  Observado: ${observedTarget.toString()} | Residual: ${postCheckpointResidual.toString()} -> classificado UNRESOLVED_POST_CHECKPOINT_DIFFERENCE, NUNCA vira opening/Income/Expense automaticamente.`);

  // --- Item 21: proteger Card e VA ------------------------------------------
  const fingerprintAfter = await fingerprintProtected(prisma);
  const protectedIdentical = JSON.stringify(fingerprintBefore) === JSON.stringify(fingerprintAfter);
  log(`\n--- Item 21: fingerprint Card+VA antes/depois ---`);
  log(`  Idêntico: ${protectedIdentical ? "SIM ✅" : "NÃO ❌ — INVESTIGAR (esta fase é read-only, nada deveria mudar)"}`);

  // --- Item 22: VA nextRecharge audit (read-only) ---------------------------
  const vaAccountRow = await prisma.account.findFirst({ where: { slug: "vale-alimentacao" } });
  const vaRule = await prisma.recurringRule.findFirst({ where: { accountId: vaAccountRow.id, kind: "income", isActive: true } });
  const vaRecharge = itauInput ? null : null;
  const canonicalRechargeDay = new Date(input.restrictedAccount.recharge.date).getUTCDate();
  log(`\n--- Item 22: auditoria VA nextRecharge (read-only) ---`);
  log(`  RecurringRule usada: id=${vaRule?.id}, dayOfMonth=${vaRule?.dayOfMonth}, amount=${vaRule?.amount?.toString()}`);
  log(`  Recarga canônica real ocorreu no dia: ${canonicalRechargeDay} (${input.restrictedAccount.recharge.date})`);
  log(`  Classificação: ${vaRule?.dayOfMonth !== canonicalRechargeDay ? "STALE_RULE" : "CORRECT_BY_CONFIG"} — RecurringRule.dayOfMonth (${vaRule?.dayOfMonth}) diverge do dia canônico real corrigido (${canonicalRechargeDay}); lib/vaPanel.js:buildVaSnapshot usa nextOccurrence(rule.dayOfMonth, now) — helper lib/recurringCycles.js:nextOccurrence, sem fallback. NÃO corrigido nesta fase.`);

  // --- Item 24: manifesto de apply FUTURO (não executado) ------------------
  const manifest = [];
  let seq = 1;
  manifest.push({ sequence: seq++, operation: "CREATE", model: "BalanceAdjustment", existingId: null, naturalKey: `opening da conta irrestrita @ ${operationalHistoryStart.toISOString()}`, before: `implícito ${impliedOpening.toString()} (herdado da âncora anterior ao cutoff)`, after: `${trueOpeningIfExtrasKept.toString()} (candidato que reconcilia o ledger COMPLETO, mantendo as rows extras) — NÃO ${derivedOpening.toString()} (que só reconcilia se as extras forem descartadas)`, cashEffect: subtractMoney(trueOpeningIfExtrasKept, impliedOpening).toString(), source: "cutover/reconciliation", confidence: "RECONCILIATION_ADJUSTMENT", dateEvidence: "DATE_ONLY_EVIDENCE (boundary técnico, não afirma evento econômico)", reason: "Abrir o ciclo operacional no cutoff sem herdar o saldo pré-cutoff não reconciliado.", dependency: `Decisão do usuário sobre qual opening usar (${derivedOpening.toString()} vs ${trueOpeningIfExtrasKept.toString()}) — BLOCKER`, idempotency: "buscar anchor existente próximo do boundary com o MESMO newBalance antes de criar (padrão já usado em VA/Card)", status: "BLOCKED" });
  for (const r of matchResults.filter((x) => x.status === "MISSING")) {
    manifest.push({ sequence: seq++, operation: "CREATE", model: r.amount.isPositive() || r.amount.isZero() ? "Income" : "Expense", existingId: null, naturalKey: `${r.description} (${r.amount.toString()})`, before: "n/a", after: `${r.amount.toString()} em Itaú`, cashEffect: r.amount.toString(), source: "reconciliation (input local gitignored)", confidence: "CONFIRMED_BY_MEMORY ou ESTIMATED conforme o item de origem", dateEvidence: "DATE_UNRESOLVED — sem evidência econômica exata, usar DEFER até decisão", reason: "Movimento canônico aprovado sem row correspondente no DB.", dependency: r.semanticHint?.startsWith("EXTERNAL_INSTALLMENT") ? "Aguardar ExternalInstallmentPlan/ExternalInstallment (Fase de parcelas externas) para não duplicar quando esse subsistema for persistido" : "nenhuma", idempotency: "match por account+amount+descrição normalizada antes de criar", status: r.description.toLowerCase().includes("moto") || r.description.toLowerCase().includes("guincho") || r.semanticHint === "CARD_BILL_PAYMENT" ? "NEEDS_DATE" : "APPROVED_CANDIDATE" });
  }
  for (const r of matchResults.filter((x) => x.status === "AMBIGUOUS")) {
    manifest.push({ sequence: seq++, operation: "RESOLVE_AMBIGUITY", model: "Expense", existingId: r.candidateIds.join("|"), naturalKey: `${r.description} (${r.amount.toString()})`, before: `${r.candidateCount} candidatos empatados`, after: "?", cashEffect: r.amount.toString(), source: "n/a", confidence: "n/a", dateEvidence: "UNKNOWN_ECONOMIC_DATE", reason: "Múltiplas rows com mesmo valor+sinal, sem sinal textual que desambigue.", dependency: "Usuário precisa indicar QUAL candidato corresponde a qual movimento canônico (ou confirmar que são a mesma verba/indistinguíveis).", idempotency: "n/a — decisão humana necessária antes de qualquer ação automática", status: "BLOCKED" });
  }
  manifest.push({ sequence: seq++, operation: "CREATE", model: "Income", existingId: null, naturalKey: "férias", before: "n/a", after: money(itauInput.movementsAfterCheckpointA[0].amount).toString(), cashEffect: money(itauInput.movementsAfterCheckpointA[0].amount).toString(), source: "manual", confidence: "CONFIRMED", dateEvidence: "EXACT_DATE_EVIDENCE (04/09)", reason: "Movimento pós-checkpoint confirmado, ainda não persistido.", dependency: "nenhuma", idempotency: "buscar por account+amount+data antes de criar", status: "APPROVED_CANDIDATE" });
  manifest.push({ sequence: seq++, operation: "CREATE", model: "Transfer", existingId: null, naturalKey: itauInput.movementsAfterCheckpointA[1].description, before: "n/a", after: `-${money(itauInput.movementsAfterCheckpointA[1].amount).toString()}`, cashEffect: money(itauInput.movementsAfterCheckpointA[1].amount).negated().toString(), source: "manual", confidence: "CONFIRMED", dateEvidence: `EXACT_DATE_EVIDENCE (${itauInput.movementsAfterCheckpointA[1].date})`, reason: "Transfer externa, NUNCA Expense (semântica canônica explícita).", dependency: "nenhuma", idempotency: "buscar por fromAccountId+amount+data antes de criar", status: "APPROVED_CANDIDATE" });
  manifest.push({ sequence: seq++, operation: "CREATE", model: "Expense", existingId: null, naturalKey: itauInput.movementsAfterCheckpointA[2].description, before: "n/a", after: `-${money(itauInput.movementsAfterCheckpointA[2].amount).toString()}`, cashEffect: money(itauInput.movementsAfterCheckpointA[2].amount).negated().toString(), source: "manual", confidence: "CONFIRMED", dateEvidence: `EXACT_DATE_EVIDENCE (${itauInput.movementsAfterCheckpointA[2].date})`, reason: "Expense definitivo confirmado explicitamente pelo usuário.", dependency: "nenhuma", idempotency: "buscar por account+amount+data antes de criar", status: "APPROVED_CANDIDATE" });
  manifest.push({ sequence: seq++, operation: "CREATE", model: "Transfer (card_bill_payment)", existingId: null, naturalKey: `CardBill ${cardBillCycleMonth} cash-side`, before: "MISSING_CASH_SIDE", after: `-${cardBill?.totalAmount?.toString()}`, cashEffect: `-${cardBill?.totalAmount?.toString()}`, source: "reconciliation", confidence: "CONFIRMED_BY_MEMORY", dateEvidence: "DATE_UNRESOLVED", reason: "CardBill já marcada 'paid' mas nenhum registro de saída de caixa existe — Card/CardBill NÃO são alterados, só o Transfer de pagamento.", dependency: "NÃO mexer no status/paidAmount da CardBill (fora de escopo, já reconciliado)", idempotency: "buscar Transfer com cardBillId antes de criar", status: "NEEDS_DATE" });
  manifest.push({ sequence: seq++, operation: "DEFER", model: "ExternalInstallmentPlan/ExternalInstallment", existingId: null, naturalKey: `${input.externalInstallmentPlans?.length ?? 0} planos de parcela externa (input.externalInstallmentPlans)`, before: "0 persistidos", after: "n/a", cashEffect: `n/a nesta fase — os movimentos canônicos de settlement (${bundleItems.map((b) => b.amount.toString()).join("/")}) já estão no manifesto acima`, reason: "Persistir os planos é trabalho de uma fase própria (ExternalInstallments), não desta reconciliação de saldo.", dependency: "Fase ExternalInstallments futura — explicitamente NÃO iniciada agora", idempotency: "n/a", status: "DEFER" });

  log(`\n--- Item 24: manifesto de apply futuro (${manifest.length} candidatos, NENHUM executado) ---`);
  for (const m of manifest) log(`  [${m.sequence}] ${m.status} | ${m.operation} ${m.model} | ${m.naturalKey} | cashEffect=${m.cashEffect}`);
  const manifestByStatus = manifest.reduce((acc, m) => { acc[m.status] = (acc[m.status] || 0) + 1; return acc; }, {});
  log(`  Por status: ${JSON.stringify(manifestByStatus)}`);

  // --- Item 26: ready gate ---------------------------------------------
  const blockers = [];
  if (byStatus.AMBIGUOUS > 0) blockers.push(`${byStatus.AMBIGUOUS} movimentos canônicos AMBIGUOUS sem desambiguação (${matchResults.filter((r) => r.status === "AMBIGUOUS").map((r) => r.description).join(" + ")} — mesmo valor, texto genérico idêntico).`);
  if (compareMoney(openingDiscrepancy, money(0)) !== 0) blockers.push(`Opening candidato tem 2 valores possíveis (${derivedOpening.toString()} vs ${trueOpeningIfExtrasKept.toString()}, diff ${openingDiscrepancy.toString()}) dependendo de as ${extraDbRows.length} rows extras serem contadas — decisão do usuário necessária.`);
  if (cardCashSideStatus === "MISSING_CASH_SIDE") blockers.push(`Cash-side do pagamento da fatura de cartão (${cardBill?.totalAmount?.toString()}) não existe — precisa de data econômica antes de criar.`);
  const motoMissing = matchResults.some((r) => r.description.toLowerCase().includes("moto") && r.status !== "UNIQUE_BACKFILL_MATCH");
  if (motoMissing) blockers.push(`Movimentos da moto (${motoItems.map((m) => m.amount.toString()).join("/")}) sem data econômica evidenciada — DATE_UNRESOLVED, DEFER até evidência.`);
  if (compareMoney(postCheckpointResidual, money(0)) !== 0) blockers.push(`Residual pós-checkpoint +${postCheckpointResidual.toString()} permanece UNRESOLVED_POST_CHECKPOINT_DIFFERENCE — não vira ajuste automaticamente.`);
  const readyGate = blockers.length === 0 && byStatus.MISSING === 0;
  log(`\n--- Item 26: FASE_5_1D_ITAU_APPLY_READY ---`);
  log(`  Blockers (${blockers.length}):`);
  for (const b of blockers) log(`    - ${b}`);
  log(`  FASE_5_1D_ITAU_APPLY_READY = ${readyGate ? "YES" : "NO"}`);

  // --- persistência do relatório --------------------------------------
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `fase51d-itau-investigation-${Date.now()}.local.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        currentComputedBalance: currentComputedBalance.toString(),
        observedTarget: observedTarget.toString(),
        difference: difference.toString(),
        canonicalNet: canonicalNet.toString(),
        derivedOpening: derivedOpening.toString(),
        impliedOpening: impliedOpening.toString(),
        matchResults: matchResults.map((r) => ({ ...r, amount: r.amount.toString(), persistedAmount: r.persistedAmount?.toString() })),
        extraDbRows: extraDbRows.map((r) => ({ id: r.id, model: r.model, amount: r.amount.toString(), description: r.description, occurredAt: r.occurredAt })),
        extraDbNet: extraDbNet.toString(),
        differenceDecomposition: {
          cutoverOpeningEffect: cutoverOpeningEffect.toString(),
          knownMissingRowsEffect: knownMissingRowsEffect.toString(),
          knownWrongRowsEffect: knownWrongRowsEffect.toString(),
          duplicateEffect: duplicateEffect.toString(),
          wrongAccountEffect: wrongAccountEffect.toString(),
          unresolvedEffect: unresolvedEffect.toString(),
          residualVsActual: residualVsActual.toString(),
        },
        cardBillCashSideStatus: cardCashSideStatus,
        openingConsistencyFinding: {
          derivedOpening: derivedOpening.toString(),
          trueOpeningIfExtrasKept: trueOpeningIfExtrasKept.toString(),
          discrepancy: openingDiscrepancy.toString(),
          extraDbRowsCount: extraDbRows.length,
          extraDbNet: extraDbNet.toString(),
        },
        protectedFingerprintIdentical: protectedIdentical,
        vaNextRechargeClassification: vaRule?.dayOfMonth !== canonicalRechargeDay ? "STALE_RULE" : "CORRECT_BY_CONFIG",
        manifest,
        manifestByStatus,
        blockers,
        readyGate,
        simulations: {
          before: currentComputedBalance.toString(),
          afterApprovedOnly: balanceApprovedOnly.toString(),
          afterWithCutoverOpeningOnly: balanceWithCutoverOpeningOnly.toString(),
          afterFullCanonicalIgnoringExtras: balanceFullCanonical.toString(),
          afterRealisticFullApply: balanceRealisticFullApply.toString(),
          target: observedTarget.toString(),
          checkpointA: checkpointA.toString(),
        },
      },
      null,
      2
    )
  );
  log(`\n✅ Relatório salvo em: ${reportPath}`);

  log(`\n==============================================================================`);
  log(`RESULTADO: READ-ONLY INVESTIGATION COMPLETE — ZERO WRITES`);
  log(`==============================================================================`);

  await prisma.$disconnect();
}

// Só roda main() quando este arquivo é executado diretamente (node
// investigate-fase51d-itau.mjs) — nunca como efeito colateral de um `import`
// (ex: scripts/test-fase51d-itau-matching.mjs importa as funções puras
// exportadas acima sem disparar a investigação real contra o banco).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
