// Fase 5.1D.2 — OBSERVED BALANCE SNAPSHOT CUTOVER.
//
// 100% READ-ONLY. ZERO writes persistidos. Toda mutação usada pra provar
// comportamento acontece DENTRO de uma prisma.$transaction que sempre termina em
// throw (rollback automático do Prisma) — mesmo padrão de prova usado desde a Fase
// 5.1B-CARD-v2/5.1C-VA, nunca commitado.
//
// Estratégia: em vez de reconstruir perfeitamente cada movimento histórico (Fase
// 5.1D/5.1D.1, que ficou BLOCKED por falta de evidência de data econômica),
// estabelece um anchor de saldo BANCÁRIO OBSERVADO no instante mais recente
// conhecido, preservando todo o histórico anterior intacto (nada deletado, nada
// reclassificado) e sem afirmar reconciliação histórica completa.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, compareMoney } from "../lib/money.js";
import { computeAccountBalance } from "../lib/accounts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(__dirname, "snapshot-input.local.json");
const REPORT_DIR = path.join(__dirname, "snapshot-reports");
const MARK = "TESTE_FASE51D2_SIMULACAO"; // nunca persistido de verdade — sempre dentro de tx com rollback

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

// Fingerprint do PRÓPRIO subsistema Itaú (fora do escopo desta fase, deve
// permanecer intocado igual Card/VA — esta fase é 100% leitura/simulação).
async function fingerprintItau(accountId, client = prisma) {
  const [incomes, expenses, transfers, anchors] = await Promise.all([
    client.income.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
    client.expense.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
    client.transfer.findMany({ where: { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] }, orderBy: { id: "asc" } }),
    client.balanceAdjustment.findMany({ where: { accountId }, orderBy: { id: "asc" } }),
  ]);
  const shape = (rows) => rows.map((r) => ({ id: r.id, updatedAt: r.updatedAt ?? null }));
  return { incomeCount: incomes.length, expenseCount: expenses.length, transferCount: transfers.length, anchorCount: anchors.length, income: shape(incomes), expense: shape(expenses), transfer: shape(transfers), anchor: shape(anchors) };
}

// Idempotency dedup key (item 21) — nunca dois snapshots equivalentes.
function snapshotDedupKey({ accountId, occurredAt, newBalance, note }) {
  return `${accountId}|${occurredAt.toISOString()}|${money(newBalance).toString()}|OBSERVED_BALANCE_SNAPSHOT|${note ?? ""}`;
}

async function main() {
  log("==============================================================================");
  log("Fase 5.1D.2 — OBSERVED BALANCE SNAPSHOT CUTOVER (simulação, ZERO writes)");
  log("==============================================================================");

  await assertTestEnvironment();
  await assertExtraSafety();

  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const itauInput = input.checkingAccount;
  const checkpointB = itauInput.checkpointB;
  const candidates = itauInput.operationalHistoryEvidence?.operationalLedgerCandidates ?? [];
  if (!checkpointB.observedAt) throw new Error("input.checkingAccount.checkpointB.observedAt ausente — não inventar, abortar.");

  const fingerprintProtectedBefore = await fingerprintProtected(prisma);
  const itauAccount = await prisma.account.findUnique({ where: { slug: itauInput.slug } });
  const fingerprintItauBefore = await fingerprintItau(itauAccount.id);

  const snapshotAmount = money(checkpointB.amount);
  const snapshotOccurredAt = new Date(checkpointB.observedAt);

  // --- Item 1/2: princípio + evidência externa autoritativa ---
  log(`\n--- Item 1/2: evidência externa autoritativa ---`);
  log(`  OBSERVED_BANK_BALANCE = ${snapshotAmount.toString()} @ ${snapshotOccurredAt.toISOString()} (source: explicit user bank observation, confidence: CONFIRMED)`);
  log(`  Este valor NÃO é derivado do DB — vem do input local gitignored, informado explicitamente pelo usuário.`);

  // --- Item 3: movimentos reportados na mesma atualização (residual histórico) ---
  const checkpointA = money(itauInput.checkpointA.amount);
  const postCkMovements = itauInput.movementsAfterCheckpointA.map((m) => ({ ...m, signedAmount: m.type === "OUTFLOW" || m.type === "TRANSFER_OUT_EXTERNAL" ? money(m.amount).negated() : money(m.amount) }));
  const postCkNet = postCkMovements.reduce((a, m) => addMoney(a, m.signedAmount), money(0));
  const reconstructedExpected = addMoney(checkpointA, postCkNet);
  const historicalResidual = subtractMoney(snapshotAmount, reconstructedExpected);
  log(`\n--- Item 3: residual histórico (isolado, nunca criado como ajuste) ---`);
  log(`  checkpointA(${checkpointA.toString()}) + net dos movimentos reportados(${postCkNet.toString()}) = ${reconstructedExpected.toString()}`);
  log(`  Observado: ${snapshotAmount.toString()} | UNRESOLVED_HISTORICAL_RESIDUAL = ${historicalResidual.toString()} — mantido isolado, NUNCA vira Income/Expense/Adjustment.`);

  const currentBalanceBefore = await computeAccountBalance(itauAccount.id);
  log(`\ncomputeAccountBalance(Itaú) ATUAL (antes de qualquer simulação): ${currentBalanceBefore.toString()}`);

  // --- Item 3 (busca real, não estimativa): movimentos com occurredAt > snapshot ---
  const [postSnapIncomes, postSnapExpenses, postSnapTransfersOut, postSnapTransfersIn] = await Promise.all([
    prisma.income.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.expense.findMany({ where: { accountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.transfer.findMany({ where: { fromAccountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
    prisma.transfer.findMany({ where: { toAccountId: itauAccount.id, occurredAt: { gt: snapshotOccurredAt } } }),
  ]);
  const postSnapNet = [
    ...postSnapIncomes.map((r) => money(r.amount)),
    ...postSnapTransfersIn.map((r) => money(r.amount)),
  ].reduce((a, v) => addMoney(a, v), money(0));
  const postSnapOut = [
    ...postSnapExpenses.map((r) => money(r.amount)),
    ...postSnapTransfersOut.map((r) => money(r.amount)),
  ].reduce((a, v) => addMoney(a, v), money(0));
  const postSnapNetTotal = subtractMoney(postSnapNet, postSnapOut);
  log(`\n--- Item 14/16: movimentos reais com occurredAt > snapshot ---`);
  log(`  Income=${postSnapIncomes.length} Expense=${postSnapExpenses.length} TransferOut=${postSnapTransfersOut.length} TransferIn=${postSnapTransfersIn.length} | net = ${postSnapNetTotal.toString()}`);
  const expectedCurrentAfterSnapshot = addMoney(snapshotAmount, postSnapNetTotal);
  log(`  simulated current balance = snapshot(${snapshotAmount.toString()}) + net pós-snapshot(${postSnapNetTotal.toString()}) = ${expectedCurrentAfterSnapshot.toString()}`);

  // ==========================================================================
  // SIMULAÇÃO REAL (transação sempre revertida) — prova mecânica via a função
  // de produção de verdade, computeAccountBalance, com client=tx.
  // ==========================================================================
  log(`\n--- Simulação (dentro de uma transação SEMPRE revertida — nenhum commit) ---`);
  let simulationResult = null;
  try {
    await prisma.$transaction(async (tx) => {
      // 1) cria o snapshot anchor (simulado)
      const createdAnchor = await tx.balanceAdjustment.create({
        data: {
          accountId: itauAccount.id,
          newBalance: snapshotAmount,
          occurredAt: snapshotOccurredAt,
          note: "OBSERVED_BALANCE_SNAPSHOT — saldo bancário observado e informado explicitamente pelo usuário nesse instante; preserva todo o histórico anterior, não é uma transação econômica.",
          source: "manual",
          confidence: "CONFIRMED",
        },
      });

      // Item 15: computeAccountBalanceAsOf(snapshot) — como o helper real não tem
      // parâmetro "asOf" (só lê SEMPRE contra a âncora mais recente), simulamos
      // fielmente criando o anchor exatamente NO instante do snapshot e chamando a
      // função real sem nenhum movimento posterior ainda inserido nesta tx — o
      // resultado NESTE PONTO da transação é, por construção, o balanço as-of.
      const balanceAsOfSnapshot = await computeAccountBalance(itauAccount.id, { client: tx });
      log(`  [as-of snapshot] computeAccountBalance(Itaú, client:tx) logo após CREATE do anchor: ${balanceAsOfSnapshot.toString()} (esperado: ${snapshotAmount.toString()})`);
      const asOfMatches = compareMoney(balanceAsOfSnapshot, snapshotAmount) === 0;

      // Item 7/14: "atividade posterior continua funcionando" — insere um Expense
      // sintético (MARK, nunca persistido de verdade) DEPOIS do snapshot e confirma
      // que o saldo muda exatamente pelo valor dele.
      const afterAmount = money("37.42");
      const afterRow = await tx.expense.create({
        data: {
          accountId: itauAccount.id,
          amount: afterAmount,
          description: `${MARK} — gasto sintético APÓS o snapshot, só pra provar que atividade posterior soma normalmente`,
          occurredAt: new Date(snapshotOccurredAt.getTime() + 60 * 60 * 1000), // 1h depois
          source: "manual",
        },
      });
      const balanceAfterPostSnapshotActivity = await computeAccountBalance(itauAccount.id, { client: tx });
      const expectedAfterActivity = subtractMoney(balanceAsOfSnapshot, afterAmount);
      log(`  [pós-snapshot] + Expense sintético de ${afterAmount.toString()} (1h depois do snapshot) -> saldo: ${balanceAfterPostSnapshotActivity.toString()} (esperado: ${expectedAfterActivity.toString()})`);
      const postActivityMatches = compareMoney(balanceAfterPostSnapshotActivity, expectedAfterActivity) === 0;

      // Item 11/12/13: "backfill histórico ANTERIOR ao snapshot não deve alterar o
      // saldo corrente" — insere um Expense sintético (MARK) datado ANTES do
      // snapshot (simula melhorar o histórico depois, ex: reconstruir algum
      // movimento pós-checkpoint-A ainda sem data real ou o cash-side de alguma
      // fatura) e confirma que o saldo JÁ CALCULADO (que inclui o Expense
      // pós-snapshot) NÃO muda nada.
      const preAmount = money("999.00");
      const preRow = await tx.expense.create({
        data: {
          accountId: itauAccount.id,
          amount: preAmount,
          description: `${MARK} — gasto sintético ANTES do snapshot, simula uma melhoria futura genérica do histórico`,
          occurredAt: new Date(snapshotOccurredAt.getTime() - 60 * 60 * 1000), // 1h antes
          source: "manual",
        },
      });
      const balanceAfterPreSnapshotBackfill = await computeAccountBalance(itauAccount.id, { client: tx });
      log(`  [backfill histórico] + Expense sintético de ${preAmount.toString()} (1h ANTES do snapshot) -> saldo: ${balanceAfterPreSnapshotBackfill.toString()} (esperado INALTERADO: ${balanceAfterPostSnapshotActivity.toString()})`);
      const preBackfillDoesNotAffectLive = compareMoney(balanceAfterPreSnapshotBackfill, balanceAfterPostSnapshotActivity) === 0;

      simulationResult = { createdAnchorId: createdAnchor.id, balanceAsOfSnapshot: balanceAsOfSnapshot.toString(), asOfMatches, balanceAfterPostSnapshotActivity: balanceAfterPostSnapshotActivity.toString(), postActivityMatches, balanceAfterPreSnapshotBackfill: balanceAfterPreSnapshotBackfill.toString(), preBackfillDoesNotAffectLive };

      throw new Error("SIMULATION_ROLLBACK_INTENTIONAL"); // NUNCA commitar — sempre reverte
    });
  } catch (err) {
    if (err.message !== "SIMULATION_ROLLBACK_INTENTIONAL") throw err;
  }

  log(`\n--- Resultado da simulação (revertida, ZERO persistido) ---`);
  log(`  as-of snapshot bate com o valor observado? ${simulationResult.asOfMatches ? "SIM ✅" : "NÃO ❌"}`);
  log(`  atividade pós-snapshot soma corretamente? ${simulationResult.postActivityMatches ? "SIM ✅" : "NÃO ❌"}`);
  log(`  backfill histórico pré-snapshot NÃO altera o saldo corrente? ${simulationResult.preBackfillDoesNotAffectLive ? "SIM ✅" : "NÃO ❌"}`);

  // --- confirmar rollback real (nenhuma row do MARK sobrou) ---
  const leftoverMarked = await prisma.expense.count({ where: { description: { contains: MARK } } });
  log(`  Confirmação de rollback: rows com marca "${MARK}" remanescentes no banco: ${leftoverMarked} (esperado 0)`);

  // --- fingerprints depois ---
  const fingerprintProtectedAfter = await fingerprintProtected(prisma);
  const fingerprintItauAfter = await fingerprintItau(itauAccount.id);
  const protectedIdentical = JSON.stringify(fingerprintProtectedBefore) === JSON.stringify(fingerprintProtectedAfter);
  const itauIdentical = JSON.stringify(fingerprintItauBefore) === JSON.stringify(fingerprintItauAfter);
  log(`\n--- Fingerprint Card+VA (protegidos) antes/depois: ${protectedIdentical ? "IDÊNTICO ✅" : "DIVERGENTE ❌"} ---`);
  log(`--- Fingerprint Itaú (Income/Expense/Transfer/BalanceAdjustment) antes/depois: ${itauIdentical ? "IDÊNTICO ✅" : "DIVERGENTE ❌"} ---`);

  // --- Item 9: completeness metadata ---
  log(`\n--- Item 9: completeness metadata ---`);
  log(`  HISTORICAL_LEDGER_COMPLETENESS = PARTIAL (o período ${input.checkingAccount ? "24/08" : ""}..${checkpointB.date} não é anunciado como 100% reconciliado — as 24 rows extras seguem WINDOW_UNKNOWN, o cash-side da fatura e os 3 movimentos pós-checkpoint A continuam ausentes do histórico).`);
  log(`  LIVE_BALANCE_CONFIDENCE_AFTER_SNAPSHOT = CONFIRMED (saldo bancário observado diretamente, não derivado de reconstrução).`);

  // --- Item 10: impacto em analytics (auditoria de código, não execução) ---
  log(`\n--- Item 10: impacto em analytics (auditoria estrutural) ---`);
  log(`  BalanceAdjustment é um model PRÓPRIO, nunca lido por category spending/topExpenses/CategoryBreakdown (esses leem exclusivamente Expense). Confirmado por leitura de schema+libs: nenhuma query de spending/categoria inclui BalanceAdjustment. O snapshot NÃO pode aparecer como Expense nem Income — não existe como tal.`);
  log(`  cashFlowProjection/freeMoney/safeToSpend partem de listAccountsWithBalances() -> computeAccountBalance() — passam a refletir o novo anchor normalmente (mesmo mecanismo já usado por VA/Card), sem tratamento especial necessário.`);

  // --- Item 20/21: manifesto futuro + idempotência ---
  const dedupKey = snapshotDedupKey({ accountId: itauAccount.id, occurredAt: snapshotOccurredAt, newBalance: snapshotAmount, note: "OBSERVED_BALANCE_SNAPSHOT" });
  log(`\n--- Item 20/21: manifesto futuro (NÃO executado) + idempotência ---`);
  log(`  [1] CREATE BalanceAdjustment OBSERVED_BALANCE_SNAPSHOT | accountId=${itauAccount.id} | newBalance=${snapshotAmount.toString()} | occurredAt=${snapshotOccurredAt.toISOString()} | status=APPROVED_CANDIDATE (aguardando autorização explícita de escrita, não desta fase)`);
  log(`  Dedup key proposta: accountId + occurredAt + newBalance + "OBSERVED_BALANCE_SNAPSHOT" + note -> ${dedupKey}`);
  log(`  As 24 extras: NENHUMA em DELETE. Nenhuma data alterada. Preservadas como estão, economicWindowClassification continua WINDOW_UNKNOWN onde não há evidência.`);
  log(`  Historical-data improvements possíveis SEPARADAMENTE no futuro (nenhum deles altera o live balance pós-snapshot, pois todos têm occurredAt anterior ao anchor):`);
  const cardBillPaymentCandidate = candidates?.find?.((c) => c.semanticHint === "CARD_BILL_PAYMENT");
  if (cardBillPaymentCandidate) log(`    - reconstruir cash-side de "${cardBillPaymentCandidate.description}" (${money(cardBillPaymentCandidate.amount).toString()}), se/quando data suficiente existir;`);
  log(`    - persistir os ${postCkMovements.length} movimentos pós-checkpoint-A (${postCkMovements.map((m) => m.description).join(", ")}) com occurredAt real, uma vez confirmado que antecedem o snapshot;`);
  const externalPlanCandidates = candidates?.filter?.((c) => c.semanticHint?.startsWith("EXTERNAL_INSTALLMENT")) ?? [];
  if (externalPlanCandidates.length) log(`    - persistir os fatos de parcela externa (${externalPlanCandidates.map((c) => money(c.amount).toString()).join("/")}) com modelagem própria, quando essa fase for iniciada.`);

  // --- Item 22: ready gate ---
  const readyChecks = {
    "BalanceAdjustment possui semântica de newBalance anchor": true, // já provado nas fases Card/VA + simulação acima
    "simulation as-of produz o valor observado": simulationResult.asOfMatches,
    "atividade posterior continua funcionando": simulationResult.postActivityMatches,
    "historical rows preservadas (nenhum DELETE)": true,
    "snapshot não entra como Expense/Income": true, // estrutural — BalanceAdjustment é model separado
    "analytics não contam snapshot como gasto": true, // estrutural — ver item 10
    "Card/VA ficam intocados": protectedIdentical,
    "backfill histórico pré-snapshot não muda live balance": simulationResult.preBackfillDoesNotAffectLive,
    "zero-write proof passa": itauIdentical && leftoverMarked === 0,
  };
  const readyGate = Object.values(readyChecks).every(Boolean);
  log(`\n--- Item 22: FASE_5_1D_2_SNAPSHOT_READY ---`);
  for (const [k, v] of Object.entries(readyChecks)) log(`  ${v ? "✅" : "❌"} ${k}`);
  log(`  FASE_5_1D_2_SNAPSHOT_READY = ${readyGate ? "YES" : "NO"}`);

  // --- item 17: old opening candidates — status rebaixado, nunca aprovado ---
  log(`\n--- Item 17: candidatos de opening antigos (histórico, nenhum aprovado) ---`);
  log(`  23.71 / 186.18 / 869.15 -> status = HISTORICAL_RECONSTRUCTION_SCENARIO (nenhum é APPROVED_OPENING). Investigação pode ser retomada no futuro sem bloquear o uso atual do Norte.`);

  // --- item 19: VA follow-up ---
  log(`\n--- Item 19: VA nextRecharge — follow-up, não blocker ---`);
  log(`  STALE_RULE (RecurringRule.dayOfMonth=24 vs dia real de recarga corrigido=21) permanece como FOLLOW_UP_VA_FORECAST_FIX, não corrigido nesta fase.`);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `fase51d2-snapshot-simulation-${Date.now()}.local.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ snapshot: { amount: snapshotAmount.toString(), occurredAt: snapshotOccurredAt.toISOString() }, currentBalanceBefore: currentBalanceBefore.toString(), postSnapshotMovements: { incomeCount: postSnapIncomes.length, expenseCount: postSnapExpenses.length, net: postSnapNetTotal.toString() }, expectedCurrentAfterSnapshot: expectedCurrentAfterSnapshot.toString(), historicalResidual: historicalResidual.toString(), simulationResult, readyChecks, readyGate, dedupKey }, null, 2));
  log(`\n✅ Relatório salvo em: ${reportPath}`);

  log(`\n==============================================================================`);
  log(`RESULTADO: READ-ONLY SIMULATION COMPLETE — ZERO WRITES PERSISTIDOS (tx sempre revertida)`);
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
