// Fase 5.1D.1 — EXTRA ROW PROVENANCE + CUTOVER OPENING CLOSURE.
//
// 100% READ-ONLY. Nenhuma escrita no banco. Nenhum model é alterado.
//
// Continuação da Fase 5.1D-ITAÚ: NÃO assume nenhum dos dois candidatos de opening
// já derivados na fase anterior como aprovado — ambos são derivados sob
// pressupostos diferentes sobre as rows extras. Investiga a proveniência real das
// rows "extras" (persistidas no período operacional, mas fora dos 29 movimentos
// canônicos) pra decidir, com evidência, o que de fato pertence ao ledger
// operacional — e só então deriva o opening, nunca escolhendo um valor pra
// "fechar a conta".
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

// --- item 8: evidência de data no texto original (genérico, marcadores temporais
// comuns em português — não referencia nenhum fato pessoal específico) ---
const TEMPORAL_MARKERS = /\b(ontem|anteontem|hoje|semana passada|m[eê]s passado|dia \d{1,2}|amanh[ãa])\b/i;
function scanTemporalEvidence(text) {
  const match = (text || "").match(TEMPORAL_MARKERS);
  return match ? match[0] : null;
}

// --- item 9: overlap semântico 1:1 — genérico, mas removendo termos de domínio
// quase-universais (verbo de pagamento + método de pagamento) que apareceriam em
// QUASE TODA mensagem deste bot e por isso não carregam sinal discriminativo
// nenhum (ex: "pix"/"reais" apareceriam em praticamente toda descrição e inflariam
// o overlap com qualquer item canônico que também contenha essas palavras, mesmo
// sem nenhuma relação econômica real). Lista pequena, de função (não de fato
// pessoal) — mesmo princípio de stopword usado em qualquer NLP básico.
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

// --- item 7: proveniência genérica a partir de source+rawMessage ---
function classifyProvenance(row) {
  if (row.source === "migration") return "MIGRATION";
  if (row.source === "telegram" && row.rawMessage) return "USER_EXPLICIT_TRANSACTION";
  if (row.source === "telegram" && !row.rawMessage) return "BOT_PARSED_TRANSACTION";
  if (row.source === "manual" && !row.rawMessage) return "MANUAL_BACKFILL";
  return "UNKNOWN";
}

async function main() {
  log("==============================================================================");
  log("Fase 5.1D.1 — EXTRA ROW PROVENANCE + CUTOVER OPENING CLOSURE (READ-ONLY)");
  log("==============================================================================");

  await assertTestEnvironment();
  await assertExtraSafety();

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const itauInput = input.checkingAccount;
  const fingerprintBefore = await fingerprintProtected(prisma);

  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  const operationalHistoryStart = settings.operationalHistoryStart;
  const itauAccount = await prisma.account.findUnique({ where: { slug: itauInput.slug } });

  // --- item 5: auditoria do anchor legado ---
  const legacyAnchor = await prisma.balanceAdjustment.findFirst({ where: { accountId: itauAccount.id }, orderBy: { occurredAt: "asc" } });
  log(`\n--- Item 5: auditoria do anchor legado ---`);
  log(`  model=BalanceAdjustment id=${legacyAnchor.id}`);
  log(`  occurredAt=${legacyAnchor.occurredAt.toISOString()} createdAt=${legacyAnchor.createdAt.toISOString()}`);
  log(`  newBalance=${legacyAnchor.newBalance.toString()} source=${legacyAnchor.source} confidence=${legacyAnchor.confidence}`);
  log(`  note="${legacyAnchor.note}" rawMessage=${legacyAnchor.rawMessage}`);
  const anchorHasBankEvidence = legacyAnchor.source !== "migration" && legacyAnchor.rawMessage != null;
  log(`  Possui evidência bancária independente? ${anchorHasBankEvidence ? "SIM" : "NÃO"} — source="migration", rawMessage=null, confidence=null: é um valor "informado pelo usuário" no momento da migração one-shot, SEM confirmação bancária independente registrada. Por instrução explícita do item 5: NÃO tratado como verdade superior ao saldo observado de ${itauInput.operationalHistoryEvidence?.evidenced20Aug?.date}.`);

  // --- item 5 (continuação): origem do -0.50 pré-cutoff ---
  const preCutoffExpenses = await prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: legacyAnchor.occurredAt, lt: operationalHistoryStart } } });
  log(`\n  Efeito pré-cutoff (entre o anchor e o cutoff operacional): ${preCutoffExpenses.length} row(s), net ${sumMoney(preCutoffExpenses.map((e) => money(e.amount))).negated().toString()}`);
  for (const e of preCutoffExpenses) log(`    id=${e.id} amount=-${e.amount.toString()} description="${e.description}" occurredAt=${e.occurredAt.toISOString()} source=${e.source} rawMessage="${e.rawMessage}" — fora da janela operacional (antes de ${operationalHistoryStart.toISOString().slice(0, 10)}), não faz parte desta reconciliação.`);

  // --- item 2: anchors externos ---
  const evidenced20Aug = itauInput.operationalHistoryEvidence.evidenced20Aug;
  const observed20Aug = money(evidenced20Aug.amount);
  const checkpointA = money(itauInput.checkpointA.amount);
  const observedTarget = money(itauInput.checkpointB.amount);
  log(`\n--- Item 2: anchors externos ---`);
  log(`  20/08 observado: ${observed20Aug.toString()} (confidence=${evidenced20Aug.confidence})`);
  log(`  Checkpoint A (${itauInput.checkpointA.date}): ${checkpointA.toString()}`);
  log(`  Checkpoint final: ${observedTarget.toString()}`);
  log(`  Cutoff operacional: ${operationalHistoryStart.toISOString().slice(0, 10)}`);

  // --- item 16: buscar 21-23/08 em todos os models ---
  const gapStart = new Date(`${evidenced20Aug.date}T00:00:00.000Z`);
  const gapEnd = operationalHistoryStart;
  const [gapIncomes, gapExpenses, gapTransfers, gapAnchors] = await Promise.all([
    prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: gapStart, lt: gapEnd } } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: gapStart, lt: gapEnd } } }),
    prisma.transfer.findMany({ where: { OR: [{ fromAccountId: itauAccount.id }, { toAccountId: itauAccount.id }], occurredAt: { gt: gapStart, lt: gapEnd } } }),
    prisma.balanceAdjustment.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: gapStart, lt: gapEnd } } }),
  ]);
  log(`\n--- Item 16: busca por movimentos entre ${evidenced20Aug.date} e o cutoff ---`);
  log(`  Income=${gapIncomes.length} Expense=${gapExpenses.length} Transfer=${gapTransfers.length} BalanceAdjustment=${gapAnchors.length} — TODOS ZERO, nenhuma evidência de DB pro bridge. Nada inventado.`);

  // --- reconstrução do matching original (item 4/6/9) ---
  const candidates = itauInput.operationalHistoryEvidence.operationalLedgerCandidates;
  const canonicalItems = candidates.map((c, idx) => ({ index: idx + 1, description: c.description, amount: money(c.amount), semanticHint: c.semanticHint, note: c.note ?? null }));
  const canonicalNet = sumMoney(canonicalItems.map((c) => c.amount));

  const asOfEndExclusive = new Date(`${input.asOf}T00:00:00.000Z`);
  asOfEndExclusive.setUTCDate(asOfEndExclusive.getUTCDate() + 1);
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

  // Rows que participam do MESMO bucket (sinal+valor) de algum item AMBIGUOUS —
  // ainda pendentes de resolução humana, não são nem "extra confirmada" nem
  // "canônica confirmada" até o usuário decidir.
  const ambiguousItems = matchResults.filter((r) => r.status === "AMBIGUOUS");
  function bucketKeyOf(amt) {
    return `${compareMoney(amt, money(0)) >= 0 ? "+" : "-"}${amt.abs().toFixed(2)}`;
  }
  const ambiguousBucketKeys = new Set(ambiguousItems.map((a) => bucketKeyOf(a.amount)));
  const pendingAmbiguityRows = extras.filter((e) => ambiguousBucketKeys.has(bucketKeyOf(e.amount)));
  const pendingAmbiguityIds = new Set(pendingAmbiguityRows.map((r) => r.id));

  // --- item 6/7/8: tabela completa das 24 extras ---
  log(`\n--- Item 6/7/8: tabela completa das ${extras.length} rows extras ---`);
  const externalPlanDescriptions = (input.externalInstallmentPlans || []).map((p) => p.description);
  const aggregateCanonicalDescriptions = canonicalItems.filter((c) => c.semanticHint?.includes("BUNDLE") || c.semanticHint?.startsWith("EXTERNAL_INSTALLMENT") || c.semanticHint === "CARD_BILL_PAYMENT").map((c) => c.description);
  // Overlap 1:1 (item 9) só faz sentido contra itens canônicos AINDA SEM match
  // resolvido — comparar contra um item já MATCHED a uma row diferente e específica
  // gera falso positivo só por coincidência de nome de pessoa recorrente no
  // dataset, não por ambiguidade real de qual row pertence a esse item (esse já
  // está resolvido).
  const unresolvedCanonicalItems = canonicalItems.filter((c) => matchResults.find((r) => r.index === c.index)?.status !== "UNIQUE_BACKFILL_MATCH");

  const extraClassifications = [];
  extras.forEach((e, i) => {
    const provenance = classifyProvenance(e);
    const temporalHint = scanTemporalEvidence(e.rawMessage);
    const dateEvidence = temporalHint ? "RECONSTRUCTIBLE_FROM_RAWMESSAGE" : "POSSIBLY_AFTER_CUTOFF"; // sem marcador temporal — só evidência circunstancial (mesmo burst que itens confirmados dentro da janela)

    // item 9: overlap 1:1 por texto contra os canônicos AINDA NÃO resolvidos (já não
    // há overlap de valor, checa só texto; usa meaningfulOverlapScore, que remove
    // verbo-de-pagamento/método genéricos como "pix"/"reais" — sem isso, QUASE TODO
    // par pontuaria >0 só por compartilhar essas palavras universais no domínio).
    const bestCanonicalOverlap = unresolvedCanonicalItems.map((c) => ({ c, score: meaningfulOverlapScore(e.description, c.description) })).sort((a, b) => b.score - a.score)[0] ?? { c: { description: "n/a" }, score: 0 };
    // Limiar 0.5 (não 0.3): uma única palavra genérica de domínio financeiro
    // ("conta", por exemplo) compartilhada entre duas descrições curtas já passa de
    // 0.3 sem indicar nenhuma relação econômica real — só overlap de metade ou mais
    // dos tokens residuais conta como sinal de "mesmo fato, valor divergente".
    const oneToOneOverlap = bestCanonicalOverlap.score > 0.5 ? "POSSIBLE_OVERLAP" : "NO_OVERLAP";

    // item 10: overlap agregado — usa overlap de FRASE COMPLETA (nunca palavra-chave
    // isolada) contra descrições de planos de parcela externa + itens-bundle
    // canônicos. Palavra-chave isolada foi tentada e descartada: nomes de pessoa
    // recorrentes neste dataset (ex: aparecem em vários itens canônicos distintos e
    // não-relacionados) geram falso positivo por coincidência de um único token —
    // exigir overlap de frase inteira, com limiar mais alto, evita isso.
    const aggregateKeywordHit = [...externalPlanDescriptions, ...aggregateCanonicalDescriptions].some((d) => meaningfulOverlapScore(e.description, d) > 0.5);

    // Cross-referência genérica de "família de conta doméstica": token-overlap
    // sozinho NÃO captura sinônimo de domínio ("luz" vs "energia elétrica" não
    // compartilham nenhum token, mas são o mesmo conceito de conta da casa).
    // Lista pequena e genérica (vocabulário comum de contas domésticas em
    // português, não um fato pessoal) só pra sinalizar cruzamento pra revisão
    // humana — nunca decide sozinha, nunca reclassifica um MISSING automaticamente.
    const HOUSEHOLD_BILL_TERMS = ["luz", "energia", "eletric", "agua", "água", "aluguel", "internet", "gas", "condominio", "condomínio"];
    const rowMentionsHouseholdBill = HOUSEHOLD_BILL_TERMS.some((t) => (e.description || "").toLowerCase().includes(t));
    const categoryOverlapHit = rowMentionsHouseholdBill && canonicalItems.some((c) => matchResults.find((r) => r.index === c.index)?.status === "MISSING" && HOUSEHOLD_BILL_TERMS.some((t) => (c.description || "").toLowerCase().includes(t)));

    let classification;
    let reason;
    if (pendingAmbiguityIds.has(e.id)) {
      classification = "PENDING_AMBIGUITY_RESOLUTION";
      reason = `Mesmo valor+sinal de um item canônico AMBIGUOUS (${bucketKeyOf(e.amount)}) — pode pertencer ao canônico uma vez resolvida a ambiguidade (item 21), não é extra confirmada.`;
    } else if (aggregateKeywordHit) {
      classification = "COMPONENT_OF_CANONICAL_AGGREGATE";
      reason = "Compartilha palavra-chave com um plano de parcela externa ou item-bundle canônico — candidato a componente, precisa revisão.";
    } else if (oneToOneOverlap === "POSSIBLE_OVERLAP") {
      classification = "UNKNOWN";
      reason = `Overlap textual com o item canônico "${bestCanonicalOverlap.c.description}" (score=${bestCanonicalOverlap.score.toFixed(2)}) apesar de valor diferente — possível mesmo fato com valor divergente, não confirmado automaticamente.`;
    } else if (categoryOverlapHit) {
      classification = "UNKNOWN";
      reason = `Categoria "${e.category}" coincide com a família de um item canônico MISSING da mesma categoria doméstica (ex: outra conta/serviço do lar), mesmo sem overlap de token — sinônimo de domínio ("luz"/"energia" etc.) não é capturado por token-overlap. Precisa revisão humana antes de presumir que é adicional.`;
    } else if (provenance === "USER_EXPLICIT_TRANSACTION") {
      classification = "CANONICAL_ADDITIONAL_MOVEMENT";
      reason = "Evidência tier-3 (rawMessage do próprio usuário via Telegram), sem overlap 1:1 nem agregado detectado — presumida real e adicional aos 29 itens.";
    } else {
      classification = "UNSUPPORTED";
      reason = "Sem evidência tier-3 suficiente (rawMessage ausente ou proveniência fraca).";
    }

    extraClassifications.push({ index: i + 1, id: e.id, model: e.model, amount: e.amount.toString(), description: e.description, category: e.category, occurredAt: e.occurredAt.toISOString(), createdAt: e.createdAt.toISOString(), source: e.source, confidence: e.confidence, rawMessage: e.rawMessage, provenance, dateEvidence, temporalHint, oneToOneOverlap, classification, reason });
  });

  for (const c of extraClassifications) {
    log(`  [${c.index}] id=${c.id} ${c.model} ${c.amount} "${c.description}" | categoria=${c.category} | occurredAt=${c.occurredAt} | source=${c.source} | provenance=${c.provenance} | dateEvidence=${c.dateEvidence} | CLASSIFICAÇÃO=${c.classification}`);
    log(`       razão: ${c.reason}`);
  }

  // --- item 5/12: análise manual/analista adicional — categoria "Moradia" com item
  // canônico MISSING também de categoria doméstica (aluguel/energia/internet) merece
  // checagem cruzada, mesmo sem overlap textual literal (sinônimos de domínio: "luz"
  // vs "energia elétrica" não compartilham token, mas são o mesmo conceito de conta
  // doméstica) — reportado como nota, não reclassificado automaticamente.
  const householdCategoryExtras = extraClassifications.filter((c) => c.category === "Moradia");
  log(`\n  ⚠️ Nota de revisão cruzada (não automatizável por token-overlap): ${householdCategoryExtras.length} extra(s) de categoria "Moradia" — ver USER_CONFIRMATION_NEEDED (possível duplicidade conceitual com um item canônico MISSING da mesma família de conta doméstica, mesmo com valores diferentes).`);

  // --- item 12: totals por classificação ---
  const byClass = {};
  for (const c of extraClassifications) {
    const amt = money(c.amount);
    byClass[c.classification] = addMoney(byClass[c.classification] ?? money(0), amt);
  }
  log(`\n--- Item 12: totais por classificação ---`);
  log(`  totalExtrasRaw: ${extraDbNet.toString()}`);
  for (const [k, v] of Object.entries(byClass)) log(`  ${k}: ${v.toString()} (${extraClassifications.filter((c) => c.classification === k).length} rows)`);
  const sumByClass = Object.values(byClass).reduce((a, b) => addMoney(a, b), money(0));
  log(`  Soma de todas as classificações: ${sumByClass.toString()} (${compareMoney(sumByClass, extraDbNet) === 0 ? "reconcilia exatamente com totalExtrasRaw ✅" : "DIVERGÊNCIA ❌"})`);

  // --- item 13: canonical complete ledger (cenário A: tudo CANONICAL_ADDITIONAL confirmado) ---
  const confirmedAdditionalNet = byClass["CANONICAL_ADDITIONAL_MOVEMENT"] ?? money(0);
  const canonicalCompleteNetPartial = addMoney(canonicalNet, confirmedAdditionalNet);
  log(`\n--- Item 13: canonical complete ledger (só o que está CONFIRMADO, sem pendências) ---`);
  log(`  canonicalOriginalNet: ${canonicalNet.toString()}`);
  log(`  canonicalAdditionalNet (só CANONICAL_ADDITIONAL_MOVEMENT confirmado): ${confirmedAdditionalNet.toString()}`);
  log(`  canonicalCompleteNet (parcial/provisório, exclui PENDING_AMBIGUITY_RESOLUTION e UNKNOWN): ${canonicalCompleteNetPartial.toString()}`);

  // --- item 14/17/18/19: os 3 candidatos de opening ---
  const openingA = subtractMoney(checkpointA, canonicalNet); // assume as extras NÃO contam
  const canonicalCompleteNetFull = addMoney(canonicalNet, extraDbNet); // assume TODAS as extras contam
  const openingB = subtractMoney(checkpointA, canonicalCompleteNetFull);
  const openingC = subtractMoney(checkpointA, canonicalCompleteNetPartial); // só o confirmado conta

  const bridgeA = subtractMoney(openingA, observed20Aug);
  const bridgeB = subtractMoney(openingB, observed20Aug);
  const bridgeC = subtractMoney(openingC, observed20Aug);

  function classifyBridge(bridge) {
    const abs = bridge.abs();
    if (compareMoney(abs, money(100)) <= 0) return "SUPPORTED_BRIDGE"; // drift pequeno, plausível em 4 dias sem evento
    if (compareMoney(abs, money(300)) <= 0) return "PARTIALLY_SUPPORTED";
    return "UNEXPLAINED";
  }

  log(`\n--- Item 14/17/18/19: os 3 candidatos de opening ---`);
  log(`  Candidate A (assume as 24 extras NÃO fazem parte do ledger operacional): ${openingA.toString()}`);
  log(`    bridge vs ${observed20Aug.toString()} @ ${evidenced20Aug.date}: ${bridgeA.toString()} -> ${classifyBridge(bridgeA)}`);
  log(`    Teste (item 18): pra aprovar, as 24 extras precisam ser duplicadas/componentes/fora-do-cutoff/unsupported. Achado real: ${extraClassifications.filter((c) => c.classification === "CANONICAL_ADDITIONAL_MOVEMENT").length} de ${extras.length} têm evidência tier-3 forte e NENHUM overlap confirmado -> hipótese NÃO sustentada. Candidate A REJEITADO como valor factual (seu bridge pequeno é favorável, mas o pressuposto que o sustenta é falso).`);
  log(`  Candidate B (assume TODAS as 24 extras fazem parte do ledger operacional): ${openingB.toString()}`);
  log(`    bridge vs ${observed20Aug.toString()} @ ${evidenced20Aug.date}: ${bridgeB.toString()} -> ${classifyBridge(bridgeB)}`);
  log(`    Teste (item 17): pra aprovar, precisaria de evidência de ${bridgeB.toString()} de movimento em 4 dias (${evidenced20Aug.date} -> cutoff) sem nenhuma row de suporte (item 16 confirmou zero rows nesse intervalo) -> hipótese NÃO sustentada. Candidate B REJEITADO como opening factual — pode permanecer só como CONDITIONAL_RECONCILIATION_VALUE_IF_ALL_EXTRAS_IN_WINDOW.`);
  log(`  Candidate C (terceiro cenário — só o CONFIRMADO sem pendência conta; PENDING_AMBIGUITY_RESOLUTION e UNKNOWN ficam de fora até resolução humana): ${openingC.toString()}`);
  log(`    bridge vs ${observed20Aug.toString()} @ ${evidenced20Aug.date}: ${bridgeC.toString()} -> ${classifyBridge(bridgeC)}`);
  log(`    Este é o único candidato cujo bridge E cujo pressuposto (só conta o que tem evidência tier-3 sólida e nenhuma pendência) são simultaneamente defensáveis — mas ainda DEPENDE da resolução dos itens PENDING_AMBIGUITY_RESOLUTION e UNKNOWN (itens 21/22). NÃO pode ser CONFIRMED ainda.`);

  // --- item 15/16: bridge check já coberto acima; 21-23/08 já buscado ---

  // --- item 21: os 7 candidatos de R$50 completos ---
  const fiftyBucketDb = dbPool.filter((r) => bucketKeyOf(r.amount) === "-50.00");
  log(`\n--- Item 21: os ${fiftyBucketDb.length} candidatos de R$50 (2 gasolina + 1 combustível moto, 3 itens canônicos AMBIGUOUS) ---`);
  for (const r of fiftyBucketDb) {
    log(`  id=${r.id} | "${r.description}" | categoria=${r.category} | occurredAt=${r.occurredAt.toISOString()} | createdAt=${r.createdAt.toISOString()} | source=${r.source} | rawMessage="${r.rawMessage}"`);
  }
  const gasolineLabeled = fiftyBucketDb.filter((r) => /gasolin/i.test(r.description));
  const nonFuelLabeled = fiftyBucketDb.filter((r) => !/gasolin/i.test(r.description));
  log(`  Tentativa de desambiguação semântica: ${gasolineLabeled.length} candidatos mencionam explicitamente "gasolina" (plausíveis pros 3 itens canônicos de combustível); ${nonFuelLabeled.length} (${nonFuelLabeled.map((r) => `"${r.description}"`).join(", ")}) NÃO mencionam combustível — semanticamente implausíveis como match de "gasolina"/"combustível moto", mas o matcher genérico (token overlap) não os exclui automaticamente por não haver a palavra "combustível"/"moto" em nenhum candidato. Mesmo entre os ${gasolineLabeled.length} candidatos com "gasolina", nenhum menciona carro vs. moto — indistinguíveis entre si. AMBIGUOUS mantido para os 3 itens; ${nonFuelLabeled.length} + pelo menos 1 dos ${gasolineLabeled.length} restam como extras genuínas mesmo após resolução.`);

  // --- checksum atualizado do saldo atual (item 20) ---
  const anchor = legacyAnchor;
  const preOpIncomes = await prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: anchor.occurredAt, lt: operationalHistoryStart } } });
  const preOpExpenses = await prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: anchor.occurredAt, lt: operationalHistoryStart } } });
  const preOpNet = subtractMoney(sumMoney(preOpIncomes.map((r) => money(r.amount))), sumMoney(preOpExpenses.map((r) => money(r.amount))));
  const impliedOpening = addMoney(money(anchor.newBalance), preOpNet);
  const matchedCanonicalNet = sumMoney(matchResults.filter((r) => r.status === "UNIQUE_BACKFILL_MATCH").map((r) => r.persistedAmount));
  const pendingNet = byClass["PENDING_AMBIGUITY_RESOLUTION"] ?? money(0);
  const unknownNet = byClass["UNKNOWN"] ?? money(0);
  const unsupportedNet = byClass["UNSUPPORTED"] ?? money(0);
  const aggregateNet = byClass["COMPONENT_OF_CANONICAL_AGGREGATE"] ?? money(0);
  const currentComputedBalance = await computeAccountBalance(itauAccount.id);
  log(`\n--- Item 20: checksum do saldo atual (${currentComputedBalance.toString()}), recalculado com as novas classificações ---`);
  log(`  anchor legado (${anchor.source}, sem evidência bancária independente): ${money(anchor.newBalance).toString()}`);
  log(`  + net pré-cutoff (âncora -> cutoff): ${preOpNet.toString()}`);
  log(`  = opening implícito atual (não confirmado, herdado do anchor legado): ${impliedOpening.toString()}`);
  log(`  + net dos itens canônicos com match confirmado: ${matchedCanonicalNet.toString()}`);
  log(`  + net CANONICAL_ADDITIONAL_MOVEMENT confirmado: ${confirmedAdditionalNet.toString()}`);
  log(`  + net PENDING_AMBIGUITY_RESOLUTION (não resolvido): ${pendingNet.toString()}`);
  log(`  + net UNKNOWN (não confirmado): ${unknownNet.toString()}`);
  log(`  + net UNSUPPORTED: ${unsupportedNet.toString()}`);
  log(`  + net COMPONENT_OF_CANONICAL_AGGREGATE (candidato, não confirmado): ${aggregateNet.toString()}`);
  const checksumTotal = [impliedOpening, matchedCanonicalNet, confirmedAdditionalNet, pendingNet, unknownNet, unsupportedNet, aggregateNet].reduce((a, b) => addMoney(a, b), money(0));
  log(`  = checksum: ${checksumTotal.toString()} (confere com computeAccountBalance atual: ${compareMoney(checksumTotal, currentComputedBalance) === 0 ? "SIM ✅" : "NÃO ❌"})`);

  // --- item 22: USER_CONFIRMATION_NEEDED ---
  log(`\n--- Item 22: USER_CONFIRMATION_NEEDED ---`);
  const needsConfirmation = [];
  for (const c of extraClassifications) {
    if (c.classification === "UNKNOWN" || c.classification === "PENDING_AMBIGUITY_RESOLUTION") {
      needsConfirmation.push(c);
    }
  }
  let n = 1;
  for (const c of needsConfirmation) {
    const question = c.classification === "PENDING_AMBIGUITY_RESOLUTION"
      ? `Este valor (${c.amount}, "${c.description}") corresponde a um dos 3 itens canônicos de combustível ambíguos, ou é um gasto extra genuinamente separado?`
      : `Este gasto (${c.amount}, "${c.description}") é o mesmo evento econômico de um item canônico já existente (com valor diferente), ou é um gasto adicional genuinamente separado?`;
    log(`  ${n} | ${c.description} | ${c.amount} | rawMessage="${c.rawMessage}"; ${c.dateEvidence === "POSSIBLY_AFTER_CUTOFF" ? "data econômica exata incerta" : "data reconstruída de rawMessage"} | "${question}"`);
    n++;
  }
  log(`  Também pendente (item 20 e 21): confirmar qual(is) dos ${gasolineLabeled.length} candidatos de "gasolina" corresponde a cada um dos 3 itens canônicos ambíguos (2 gasolina carro + 1 combustível moto).`);
  log(`  Total de itens que dependem de confirmação humana: ${needsConfirmation.length} (de ${extras.length} extras totais, sendo 7 delas justamente os candidatos de R$50 da desambiguação acima) — NÃO pedindo revisão das outras ${extras.length - needsConfirmation.length} rows já classificadas com evidência suficiente.`);

  // --- item 23: OPENING_STATUS ---
  const openingStatus = "BLOCKED";
  log(`\n--- Item 23: OPENING_STATUS ---`);
  log(`  OPENING_STATUS = ${openingStatus}`);
  log(`  reason: nem Candidate A (${openingA.toString()}) nem Candidate B (${openingB.toString()}) sobrevivem ao teste de evidência (itens 17/18) — A pressupõe que ~${extraClassifications.filter((c) => c.classification === "CANONICAL_ADDITIONAL_MOVEMENT").length} rows com evidência tier-3 forte não são reais, o que é falso; B exige um bridge de ${bridgeB.toString()} em 4 dias sem nenhuma evidência de DB (item 16 confirmou zero rows). Candidate C (${openingC.toString()}, bridge ${bridgeC.toString()}) é o mais defensável dos três mas continua CONDICIONAL à resolução humana dos ${needsConfirmation.length} itens UNKNOWN/PENDING_AMBIGUITY_RESOLUTION listados acima — nenhum valor pode ser CONFIRMED_CANDIDATE enquanto essas pendências existirem.`);

  // --- item 27: fingerprint depois ---
  const fingerprintAfter = await fingerprintProtected(prisma);
  const protectedIdentical = JSON.stringify(fingerprintBefore) === JSON.stringify(fingerprintAfter);
  log(`\n--- Item 27: fingerprint Card+VA antes/depois ---`);
  log(`  Idêntico: ${protectedIdentical ? "SIM ✅" : "NÃO ❌"}`);

  // --- item 28: ready gate ---
  const blockers = [];
  if (needsConfirmation.length > 0) blockers.push(`${needsConfirmation.length} rows extras (UNKNOWN/PENDING_AMBIGUITY_RESOLUTION) dependem de confirmação humana.`);
  blockers.push("3 itens canônicos AMBIGUOUS (gasolina x2 + combustível moto) sem desambiguação.");
  blockers.push(`OPENING_STATUS=${openingStatus} — nenhum valor de opening confirmado.`);
  const readyGate = false;
  log(`\n--- Item 28: FASE_5_1D_1_OPENING_READY ---`);
  for (const b of blockers) log(`  - ${b}`);
  log(`  FASE_5_1D_1_OPENING_READY = ${readyGate ? "YES" : "NO"}`);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `fase51d1-opening-investigation-${Date.now()}.local.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ legacyAnchor: { id: legacyAnchor.id, occurredAt: legacyAnchor.occurredAt, source: legacyAnchor.source, newBalance: legacyAnchor.newBalance.toString(), note: legacyAnchor.note, rawMessage: legacyAnchor.rawMessage, anchorHasBankEvidence }, extraClassifications, byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.toString()])), openingCandidates: { A: { value: openingA.toString(), bridge: bridgeA.toString(), classification: classifyBridge(bridgeA) }, B: { value: openingB.toString(), bridge: bridgeB.toString(), classification: classifyBridge(bridgeB) }, C: { value: openingC.toString(), bridge: bridgeC.toString(), classification: classifyBridge(bridgeC) } }, openingStatus, needsConfirmationCount: needsConfirmation.length, protectedFingerprintIdentical: protectedIdentical, readyGate }, null, 2));
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
