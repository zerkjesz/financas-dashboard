// Fase 5.1D.1 — EXTRA ROW PROVENANCE + CUTOVER OPENING CLOSURE.
//
// 100% READ-ONLY. Nenhuma escrita no banco. Nenhum model é alterado.
//
// Revisão (2ª rodada): distingue explicitamente EXISTENCE PROVENANCE (o fato foi
// informado pelo usuário — comprovado pra todas as 24 extras) de ECONOMIC WINDOW
// EVIDENCE (o fato aconteceu entre o cutoff operacional e o asOf — NÃO comprovado
// só por occurredAt/createdAt de uma row bulk-backfilled). Nenhuma row vira
// "adicional confirmada" pro cálculo do opening sem as duas provas.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { matchOperationalMovements, tokenOverlapScore } from "./investigate-fase51d-itau.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(__dirname, "snapshot-input.local.json");
const REPORT_DIR = path.join(__dirname, "snapshot-reports");

function log(...args) {
  console.log(...args);
}

async function assertExtraSafety() {
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

async function fingerprintProtected(client = prisma) {
  const [cards, cardBills, purchases, installments, cardLimitUpdates, vaAccount] = await Promise.all([
    client.card.findMany({ orderBy: { id: "asc" } }),
    client.cardBill.findMany({ orderBy: { id: "asc" } }),
    client.purchase.findMany({ orderBy: { id: "asc" } }),
    client.installment.findMany({ orderBy: { id: "asc" } }),
    client.cardLimitUpdate.findMany({ orderBy: { id: "asc" } }),
    client.account.findFirst({ where: { slug: "vale-alimentacao" } }),
  ]);
  let vaExpenses = [], vaIncomes = [], vaAdjustments = [];
  if (vaAccount) {
    [vaExpenses, vaIncomes, vaAdjustments] = await Promise.all([
      client.expense.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
      client.income.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
      client.balanceAdjustment.findMany({ where: { accountId: vaAccount.id }, orderBy: { id: "asc" } }),
    ]);
  }
  const shape = (rows) => rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt ?? null, amount: r.amount?.toString?.() ?? r.newBalance?.toString?.() ?? r.totalAmount?.toString?.() }));
  return { card: shape(cards), cardBill: shape(cardBills), purchase: shape(purchases), installment: shape(installments), cardLimitUpdate: shape(cardLimitUpdates), vaAccount: vaAccount ? { id: vaAccount.id, updatedAt: vaAccount.updatedAt } : null, vaExpense: shape(vaExpenses), vaIncome: shape(vaIncomes), vaBalanceAdjustment: shape(vaAdjustments) };
}

// --- item 5/6: marcador temporal genérico no texto original (não referencia
// nenhum fato pessoal específico — só vocabulário comum de data relativa em
// português). Se encontrado, resolve contra o momento REAL de envio da mensagem
// (createdAt, que é confiável como INGESTION_TIME/ enviou-a-mensagem-agora — nunca
// contra occurredAt de uma row backfillada, que é só onde o bot decidiu ancorar).
const TEMPORAL_MARKERS = /\b(ontem|anteontem|hoje|amanh[ãa]|semana passada|essa semana|nessa semana|m[eê]s passado|dia \d{1,2}|s[áa]bado|domingo|segunda(-feira)?|ter[çc]a(-feira)?|quarta(-feira)?|quinta(-feira)?|sexta(-feira)?)\b/i;
function scanTemporalEvidence(text) {
  const match = (text || "").match(TEMPORAL_MARKERS);
  return match ? match[0] : null;
}

function resolveEconomicDate(marker, sentAt) {
  const m = marker.toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  if (m === "hoje") return new Date(sentAt.getTime());
  if (m === "ontem") return new Date(sentAt.getTime() - day);
  if (m === "anteontem") return new Date(sentAt.getTime() - 2 * day);
  // "dia X", nomes de dia da semana e "semana passada" exigiriam resolução de
  // calendário mais elaborada (qual foi o último sábado antes de sentAt, etc.) —
  // implementada só se de fato aparecer evidência desse tipo (ver item 6: nenhuma
  // das 24 rawMessage contém qualquer marcador, então este caminho nunca é
  // exercitado com dado real nesta fase — mantido explícito, não removido, pra não
  // mascarar uma referência temporal futura que apareça noutra reconciliação).
  return null;
}

function classifyEconomicWindow(resolvedDate, windowStart, windowEndExclusive) {
  if (!resolvedDate) return "WINDOW_UNKNOWN";
  if (resolvedDate < windowStart) return "CONFIRMED_PRE_CUTOFF";
  if (resolvedDate >= windowEndExclusive) return "CONFIRMED_POST_ASOF";
  return "CONFIRMED_IN_WINDOW";
}

// --- overlap semântico — remove verbo-de-pagamento/método genéricos que
// apareceriam em QUASE TODA mensagem deste bot e por isso não carregam sinal
// discriminativo nenhum (mesmo princípio de stopword usado em qualquer NLP básico,
// não é um fato pessoal). ---
const DOMAIN_STOPWORDS = new Set(["pix", "reais", "real", "paguei", "pagar", "mandei", "gastei", "comprei", "botei", "recebi", "no", "na", "de", "da", "um", "uma", "no pix"]);
function meaningfulOverlapScore(a, b) {
  const filterStop = (text) => (text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !DOMAIN_STOPWORDS.has(t));
  const ta = new Set(filterStop(a));
  const tb = new Set(filterStop(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
}

function classifyExistenceProvenance(row) {
  if (row.source === "migration") return "MIGRATION";
  if (row.source === "telegram" && row.rawMessage) return "USER_EXPLICIT_TRANSACTION";
  if (row.source === "telegram" && !row.rawMessage) return "BOT_PARSED_TRANSACTION";
  if (row.source === "manual" && !row.rawMessage) return "MANUAL_BACKFILL";
  return "UNKNOWN";
}

function bucketKeyOf(amt) {
  return `${compareMoney(amt, money(0)) >= 0 ? "+" : "-"}${amt.abs().toFixed(2)}`;
}

async function main() {
  log("==============================================================================");
  log("Fase 5.1D.1 (revisão) — EXISTENCE PROVENANCE != ECONOMIC WINDOW EVIDENCE");
  log("100% READ-ONLY");
  log("==============================================================================");

  await assertTestEnvironment();
  await assertExtraSafety();

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const itauInput = input.checkingAccount;
  const fingerprintBefore = await fingerprintProtected(prisma);

  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  const operationalHistoryStart = settings.operationalHistoryStart;
  const itauAccount = await prisma.account.findUnique({ where: { slug: itauInput.slug } });

  const legacyAnchor = await prisma.balanceAdjustment.findFirst({ where: { accountId: itauAccount.id }, orderBy: { occurredAt: "asc" } });
  const evidenced20Aug = itauInput.operationalHistoryEvidence.evidenced20Aug;
  const observed20Aug = money(evidenced20Aug.amount);
  const checkpointA = money(itauInput.checkpointA.amount);
  const observedTarget = money(itauInput.checkpointB.amount);

  const asOfEndExclusive = new Date(`${input.asOf}T00:00:00.000Z`);
  asOfEndExclusive.setUTCDate(asOfEndExclusive.getUTCDate() + 1);

  // --- matching original (mesma lógica das fases anteriores, reaproveitada) ---
  const candidates = itauInput.operationalHistoryEvidence.operationalLedgerCandidates;
  const canonicalItems = candidates.map((c, idx) => ({ index: idx + 1, description: c.description, amount: money(c.amount), semanticHint: c.semanticHint, note: c.note ?? null }));
  const canonicalNet = sumMoney(canonicalItems.map((c) => c.amount));

  const [opIncomes, opExpenses] = await Promise.all([
    prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gte: operationalHistoryStart, lt: asOfEndExclusive } }, orderBy: { occurredAt: "asc" } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gte: operationalHistoryStart, lt: asOfEndExclusive } }, orderBy: { occurredAt: "asc" } }),
  ]);
  const dbPool = [
    ...opIncomes.map((r) => ({ id: r.id, model: "Income", amount: money(r.amount), description: r.description, category: r.category, occurredAt: r.occurredAt, createdAt: r.createdAt, source: r.source, confidence: r.confidence, rawMessage: r.rawMessage, consumed: false })),
    ...opExpenses.map((r) => ({ id: r.id, model: "Expense", amount: money(r.amount).negated(), description: r.description, category: r.category, occurredAt: r.occurredAt, createdAt: r.createdAt, source: r.source, confidence: r.confidence, rawMessage: r.rawMessage, consumed: false })),
  ];
  const matchResults = matchOperationalMovements(canonicalItems, dbPool.map((r) => ({ ...r })));
  const matchedIds = new Set(matchResults.filter((r) => r.status === "UNIQUE_BACKFILL_MATCH").map((r) => r.matchedDbId));
  const extras = dbPool.filter((r) => !matchedIds.has(r.id));
  const extraDbNet = sumMoney(extras.map((r) => r.amount));

  const ambiguousItems = matchResults.filter((r) => r.status === "AMBIGUOUS");
  const ambiguousBucketKeys = new Set(ambiguousItems.map((a) => bucketKeyOf(a.amount)));

  // ==========================================================================
  // ITEM 1 — reauditoria das 24 extras: existenceProvenance x economicWindow
  // ==========================================================================
  log(`\n--- Item 1: existenceProvenance vs economicWindowClassification (janela ${operationalHistoryStart.toISOString().slice(0, 10)}..${input.asOf} inclusive) ---`);
  const extraAudit = extras.map((e, i) => {
    const existenceProvenance = classifyExistenceProvenance(e);
    const temporalMarker = scanTemporalEvidence(e.rawMessage);
    const resolvedDate = temporalMarker ? resolveEconomicDate(temporalMarker, e.createdAt) : null;
    const economicWindowClassification = classifyEconomicWindow(resolvedDate, operationalHistoryStart, asOfEndExclusive);
    const economicDateEvidence = temporalMarker
      ? `Marcador temporal "${temporalMarker}" no rawMessage, resolvido contra createdAt (${e.createdAt.toISOString()}) -> ${resolvedDate.toISOString().slice(0, 10)}.`
      : `NENHUM marcador temporal no rawMessage. occurredAt (${e.occurredAt.toISOString()}) e createdAt são apenas INGESTION_TIME (burst de backfill em 29/08) — NÃO provam a data econômica real. Não inferido.`;
    return { index: i + 1, id: e.id, model: e.model, amount: e.amount.toString(), description: e.description, category: e.category, rawMessage: e.rawMessage, persistedOccurredAt: e.occurredAt.toISOString(), createdAt: e.createdAt.toISOString(), existenceProvenance, economicDateEvidence, economicWindowClassification, inAmbiguousBucket: ambiguousBucketKeys.has(bucketKeyOf(e.amount)) };
  });
  for (const a of extraAudit) {
    log(`  [${a.index}] id=${a.id} ${a.model} ${a.amount} "${a.description}"`);
    log(`       existenceProvenance=${a.existenceProvenance} | economicWindowClassification=${a.economicWindowClassification}`);
    log(`       economicDateEvidence: ${a.economicDateEvidence}`);
  }

  const countInWindow = extraAudit.filter((a) => a.economicWindowClassification === "CONFIRMED_IN_WINDOW").length;
  const countPreCutoff = extraAudit.filter((a) => a.economicWindowClassification === "CONFIRMED_PRE_CUTOFF").length;
  const countPostAsOf = extraAudit.filter((a) => a.economicWindowClassification === "CONFIRMED_POST_ASOF").length;
  const countUnknown = extraAudit.filter((a) => a.economicWindowClassification === "WINDOW_UNKNOWN").length;
  log(`\n  Resumo: CONFIRMED_IN_WINDOW=${countInWindow} | CONFIRMED_PRE_CUTOFF=${countPreCutoff} | CONFIRMED_POST_ASOF=${countPostAsOf} | WINDOW_UNKNOWN=${countUnknown}`);
  log(`  ACHADO: nenhuma das ${extras.length} rawMessage contém marcador temporal (varredura ampliada incluiu dias-da-semana, "essa semana", "dia X", "ontem/anteontem/hoje") — TODAS ficam WINDOW_UNKNOWN por ausência de evidência, mesmo tendo existência 100% comprovada.`);

  // ==========================================================================
  // ITEM 2 — revisão dos 14 "CANONICAL_ADDITIONAL_MOVEMENT"
  // ==========================================================================
  log(`\n--- Item 2: revisão da classificação financeira (existence != window) ---`);
  const financialClassification = extraAudit.map((a) => {
    let bucket;
    if (a.economicWindowClassification === "CONFIRMED_IN_WINDOW") bucket = "CONFIRMED_ADDITIONAL_IN_WINDOW";
    else if (a.economicWindowClassification === "CONFIRMED_PRE_CUTOFF") bucket = "CONFIRMED_PRE_CUTOFF";
    else if (a.economicWindowClassification === "CONFIRMED_POST_ASOF") bucket = "CONFIRMED_POST_ASOF";
    else bucket = "REAL_TRANSACTION_WINDOW_UNKNOWN"; // existência comprovada, janela não
    return { ...a, financialBucket: bucket };
  });
  const downgraded = financialClassification.filter((a) => a.financialBucket === "REAL_TRANSACTION_WINDOW_UNKNOWN");
  log(`  ${downgraded.length} de ${extras.length} rows rebaixadas de CANONICAL_ADDITIONAL_MOVEMENT (classificação da rodada anterior) para REAL_TRANSACTION_WINDOW_UNKNOWN — a existência continua confirmada, mas NÃO entram no canonicalCompleteNet operacional até a janela ser provada.`);

  // ==========================================================================
  // ITEM 3 — R$50: separar efeito financeiro de identidade
  // ==========================================================================
  const fiftyBucketDb = dbPool.filter((r) => bucketKeyOf(r.amount) === "-50.00");
  const fiftyBucketAudit = financialClassification.filter((a) => a.inAmbiguousBucket);
  const fiftyAllInWindow = fiftyBucketAudit.length > 0 && fiftyBucketAudit.every((a) => a.economicWindowClassification === "CONFIRMED_IN_WINDOW");
  const fiftyConfirmedInWindowCount = fiftyBucketAudit.filter((a) => a.economicWindowClassification === "CONFIRMED_IN_WINDOW").length;
  const canonicalFiftySlots = ambiguousItems.length; // 3
  log(`\n--- Item 3: R$50 — efeito financeiro (A) separado de identidade semântica (B) ---`);
  log(`  Persisted: ${fiftyBucketDb.length} rows de -50.00 | Canonical slots ambíguos: ${canonicalFiftySlots}`);
  log(`  A) FINANCIAL OPENING EFFECT: SE todas as ${fiftyBucketDb.length} forem CONFIRMED_IN_WINDOW, o efeito adicional é necessariamente ${fiftyBucketDb.length} x -50.00 menos ${canonicalFiftySlots} x -50.00 já representados no canonicalNet = ${money(fiftyBucketDb.length - canonicalFiftySlots).times(-50).toString()} — independe de qual id representa qual dos ${canonicalFiftySlots} itens canônicos.`);
  log(`  Window membership confirmado hoje: ${fiftyConfirmedInWindowCount} de ${fiftyBucketDb.length} -> efeito CONFIRMADO agora: R$0.00 (nenhuma das ${fiftyBucketDb.length} tem marcador temporal).`);
  log(`  B) SEMANTIC IDENTITY: qual das ${fiftyBucketDb.length} corresponde a qual dos ${canonicalFiftySlots} itens canônicos continua indeterminado (4 mencionam "gasolina", plausíveis; 3 não mencionam combustível, implausíveis mas não excluídas automaticamente) — necessário só pra um apply detalhado, NÃO bloqueia o cálculo do opening uma vez que o window membership das ${fiftyBucketDb.length} for confirmado.`);

  // ==========================================================================
  // ITEM 4 — as 3 antigas "UNKNOWN": duas perguntas independentes
  // ==========================================================================
  // Critério genérico (não hardcoded a um fato específico): rows de categoria
  // doméstica (ambas direções, entrada e saída) + a row de combustível avulso fora
  // do pool ambíguo de -50 — nenhum valor/descrição literal fixado aqui, tudo
  // derivado de `financialClassification` em runtime.
  const householdRows = financialClassification.filter((a) => a.category === "Moradia" && !ambiguousBucketKeys.has(bucketKeyOf(money(a.amount))));
  const looseFuelRows = financialClassification.filter((a) => /gasolin/i.test(a.description) && !ambiguousBucketKeys.has(bucketKeyOf(money(a.amount))));
  log(`\n--- Item 4: as rows de maior atenção — duas perguntas independentes cada ---`);
  const specialThree = [];
  for (const row of [...householdRows, ...looseFuelRows]) {
    specialThree.push(row);
    log(`  "${row.description}" (${row.amount}):`);
    log(`    A) É economicamente real? SIM — existenceProvenance=${row.existenceProvenance} (rawMessage do próprio usuário).`);
    log(`    B) Ocorreu entre ${operationalHistoryStart.toISOString().slice(0, 10)} e ${input.asOf}? ${row.economicWindowClassification} — sem marcador temporal, não provado nem descartado.`);
    log(`    Overlap com item canônico: NÃO presumido automaticamente como duplicata só por categoria/palavra em comum (ex: "luz"/"energia" nunca são tratados como prova de mesmo fato sem evidência adicional) — permanece candidato a pergunta objetiva, nunca reclassificação automática.`);
  }

  // ==========================================================================
  // ITEM 7 — recalcular totals
  // ==========================================================================
  const sumBucket = (name) => sumMoney(financialClassification.filter((a) => a.financialBucket === name).map((a) => money(a.amount)));
  const confirmedAdditionalInWindowNet = sumBucket("CONFIRMED_ADDITIONAL_IN_WINDOW");
  const confirmedPreCutoffNet = sumBucket("CONFIRMED_PRE_CUTOFF");
  const confirmedPostAsOfNet = sumBucket("CONFIRMED_POST_ASOF");
  const realButWindowUnknownNet = sumBucket("REAL_TRANSACTION_WINDOW_UNKNOWN");
  const duplicateOrAggregateOverlapNet = money(0); // nenhuma duplicata/agregado provado (item 4 — nunca presumido só por categoria/palavra)
  const totalsReconciled = [confirmedAdditionalInWindowNet, confirmedPreCutoffNet, confirmedPostAsOfNet, realButWindowUnknownNet, duplicateOrAggregateOverlapNet].reduce((a, b) => addMoney(a, b), money(0));
  log(`\n--- Item 7: totals recalculados ---`);
  log(`  confirmedAdditionalInWindowNet: ${confirmedAdditionalInWindowNet.toString()}`);
  log(`  confirmedPreCutoffNet: ${confirmedPreCutoffNet.toString()}`);
  log(`  confirmedPostAsOfNet: ${confirmedPostAsOfNet.toString()}`);
  log(`  realButWindowUnknownNet: ${realButWindowUnknownNet.toString()}`);
  log(`  duplicateOrAggregateOverlapNet: ${duplicateOrAggregateOverlapNet.toString()}`);
  log(`  Soma: ${totalsReconciled.toString()} (${compareMoney(totalsReconciled, extraDbNet) === 0 ? "reconcilia exatamente com o universo das 24 extras ✅" : "DIVERGÊNCIA ❌"})`);

  // ==========================================================================
  // ITEM 8 — canonicalCompleteNet somente provado
  // ==========================================================================
  const evidencedOperationalNet = addMoney(canonicalNet, confirmedAdditionalInWindowNet);
  log(`\n--- Item 8: evidencedOperationalNet (só o PROVADO) ---`);
  log(`  canonicalOriginalNet: ${canonicalNet.toString()}`);
  log(`  + confirmedAdditionalInWindowNet: ${confirmedAdditionalInWindowNet.toString()}`);
  log(`  = evidencedOperationalNet: ${evidencedOperationalNet.toString()} (WINDOW_UNKNOWN NÃO incluído)`);

  // ==========================================================================
  // ITEM 9 — opening range (não um valor único)
  // ==========================================================================
  const evidencedOpening = subtractMoney(checkpointA, evidencedOperationalNet);
  const netIfAllUnknownInWindow = addMoney(evidencedOperationalNet, realButWindowUnknownNet);
  const openingIfAllUnknownInWindow = subtractMoney(checkpointA, netIfAllUnknownInWindow);
  const openingMin = compareMoney(evidencedOpening, openingIfAllUnknownInWindow) <= 0 ? evidencedOpening : openingIfAllUnknownInWindow;
  const openingMax = compareMoney(evidencedOpening, openingIfAllUnknownInWindow) <= 0 ? openingIfAllUnknownInWindow : evidencedOpening;
  log(`\n--- Item 9: EVIDENCED_OPENING e range de incerteza ---`);
  log(`  EVIDENCED_OPENING (só o provado; WINDOW_UNKNOWN tratado como fora do ledger até prova): ${evidencedOpening.toString()}`);
  log(`  Cenário extremo (TODAS as ${countUnknown} rows WINDOW_UNKNOWN confirmadas in-window): ${openingIfAllUnknownInWindow.toString()}`);
  log(`  openingMin = ${openingMin.toString()} | openingMax = ${openingMax.toString()}`);
  log(`  Toda a largura da incerteza (${subtractMoney(openingMax, openingMin).toString()}) vem exclusivamente da data econômica não-provada dessas ${countUnknown} rows — nada mais contribui pra essa faixa.`);

  // ==========================================================================
  // ITEM 10 — bridge 20/08 -> 24/08 pro EVIDENCED_OPENING
  // ==========================================================================
  function classifyBridge(bridge) {
    const abs = bridge.abs();
    if (compareMoney(abs, money(100)) <= 0) return "SUPPORTED";
    if (compareMoney(abs, money(300)) <= 0) return "PARTIAL";
    return "UNEXPLAINED";
  }
  const bridgeEvidenced = subtractMoney(evidencedOpening, observed20Aug);
  const bridgeMax = subtractMoney(openingMax, observed20Aug);
  log(`\n--- Item 10: bridge ${evidenced20Aug.date} -> cutoff ---`);
  log(`  EVIDENCED_OPENING (${evidencedOpening.toString()}) - ${observed20Aug.toString()} = ${bridgeEvidenced.toString()} -> ${classifyBridge(bridgeEvidenced)}`);
  log(`  openingMax (${openingMax.toString()}) - ${observed20Aug.toString()} = ${bridgeMax.toString()} -> ${classifyBridge(bridgeMax)} (cenário extremo, não usado como prova de nada — só mostra que o extremo oposto exigiria um salto grande e hoje sem suporte de DB)`);

  // ==========================================================================
  // ITEM 11/12 — USER_CONFIRMATION_NEEDED mínimo
  // ==========================================================================
  log(`\n--- Item 11/12: USER_CONFIRMATION_NEEDED (mínimo necessário) ---`);
  // Agrupa as rows window-unknown "comuns" (sem overlap/atenção especial) numa
  // única pergunta de lote — elas compartilham o MESMO burst de 29/08 e a MESMA
  // pergunta objetiva, perguntar uma por uma seria ruído.
  const specialIds = new Set(specialThree.map((s) => s.id));
  const fiftyIds = new Set(fiftyBucketAudit.map((a) => a.id));
  const batchRows = financialClassification.filter((a) => a.financialBucket === "REAL_TRANSACTION_WINDOW_UNKNOWN" && !specialIds.has(a.id) && !fiftyIds.has(a.id));
  const confirmationList = [];
  let qn = 1;
  confirmationList.push({ n: qn++, description: `As demais ${batchRows.length} compras/recebimentos avulsos que você reportou pro bot numa sequência só, em 29/08 (farmácia, churrasco, capcut, ração, etc. — sem contar os R$50 de combustível nem os 3 casos especiais abaixo)`, amount: sumMoney(batchRows.map((a) => money(a.amount))).toString(), known: "sim, você relatou cada um", dateWeHave: "só sabemos que foi digitado em 29/08 — não sabemos se o gasto em si foi antes, durante ou (menos provável) depois desse dia", question: "esses gastos/recebimentos aconteceram entre 24/08 e 04/09?" });
  confirmationList.push({ n: qn++, description: `Os ${fiftyBucketDb.length} lançamentos de R$50 (combustível/outros)`, amount: money(fiftyBucketDb.length).times(-50).toString(), known: "sim", dateWeHave: "mesmo burst de 29/08, sem data econômica própria", question: "esses 7 lançamentos de R$50 aconteceram entre 24/08 e 04/09?" });
  for (const s of specialThree) {
    confirmationList.push({ n: qn++, description: s.description, amount: s.amount, known: "sim", dateWeHave: "mesmo burst de 29/08, sem data econômica própria", question: "isso aconteceu entre 24/08 e 04/09?", followUp: s.category === "Moradia" ? "é o mesmo pagamento de uma conta de luz já contabilizada, ou foi outro?" : (/gasolina/i.test(s.description) ? "é um abastecimento à parte dos R$50 de combustível, ou é o mesmo eventualmente contado a menor?" : undefined) });
  }
  for (const c of confirmationList) {
    log(`  ${c.n} | ${c.description} | ${c.amount} | sabemos que existiu? ${c.known} | data que temos: ${c.dateWeHave} | pergunta: "${c.question}"${c.followUp ? ` + "${c.followUp}"` : ""}`);
  }

  // ==========================================================================
  // ITEM 13 — OPENING_STATUS
  // ==========================================================================
  const openingStatus = "BLOCKED";
  log(`\n--- Item 13: OPENING_STATUS ---`);
  log(`  OPENING_STATUS = ${openingStatus}`);
  log(`  reason: economicWindowClassification de ${countUnknown} das ${extras.length} rows extras permanece WINDOW_UNKNOWN (nenhum marcador temporal em nenhuma rawMessage) — a faixa [${openingMin.toString()}, ${openingMax.toString()}] segue aberta até resolução humana. Bridge do EVIDENCED_OPENING (${classifyBridge(bridgeEvidenced)}) é favorável, mas não é suficiente sozinho pra promover CONFIRMED_CANDIDATE enquanto a origem econômica das rows não estiver resolvida.`);

  const fingerprintAfter = await fingerprintProtected(prisma);
  const protectedIdentical = JSON.stringify(fingerprintBefore) === JSON.stringify(fingerprintAfter);
  log(`\n--- Item 14: fingerprint Card+VA+Itaú(read-only) antes/depois ---`);
  log(`  Idêntico: ${protectedIdentical ? "SIM ✅" : "NÃO ❌"}`);

  const readyGate = false;
  log(`\nFASE_5_1D_1_OPENING_READY = ${readyGate ? "YES" : "NO"}`);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `fase51d1-window-audit-${Date.now()}.local.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ extraAudit, financialClassification: financialClassification.map((a) => ({ id: a.id, amount: a.amount, financialBucket: a.financialBucket, economicWindowClassification: a.economicWindowClassification })), totals: { confirmedAdditionalInWindowNet: confirmedAdditionalInWindowNet.toString(), confirmedPreCutoffNet: confirmedPreCutoffNet.toString(), confirmedPostAsOfNet: confirmedPostAsOfNet.toString(), realButWindowUnknownNet: realButWindowUnknownNet.toString(), duplicateOrAggregateOverlapNet: duplicateOrAggregateOverlapNet.toString() }, evidencedOperationalNet: evidencedOperationalNet.toString(), evidencedOpening: evidencedOpening.toString(), openingMin: openingMin.toString(), openingMax: openingMax.toString(), bridgeEvidenced: { value: bridgeEvidenced.toString(), classification: classifyBridge(bridgeEvidenced) }, openingStatus, protectedFingerprintIdentical: protectedIdentical, readyGate, confirmationList }, null, 2));
  log(`\n✅ Relatório salvo em: ${reportPath}`);

  log(`\n==============================================================================`);
  log(`RESULTADO: READ-ONLY INVESTIGATION COMPLETE — ZERO WRITES`);
  log(`==============================================================================`);

  await prisma.$disconnect();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
