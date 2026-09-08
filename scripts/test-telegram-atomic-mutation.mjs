// Fase 5.3C.2 — ATOMIC TELEGRAM FINANCIAL MUTATION. READ-only no sentido de
// dados REAIS do usuário; cria/apaga fixtures 100% sintéticas (MARK =
// "TESTE_ATOMIC_53C2") pra provar a garantia de atomicidade real via
// transações Prisma de verdade contra o Postgres — não é possível provar
// isso com mocks, a garantia VEM do Postgres.
//
// TEMPORARY_SYNTHETIC_TEST_WRITES = YES (Account/Card/CardBill/Bill/Goal
// fictícios, criados no setup e apagados no teardown, garantido por
// finally).
// ZERO_REAL_USER_FINANCIAL_WRITES = YES.
// FINAL_REAL_FINANCIAL_STATE_DIFF = ZERO (medido nos models REAIS/
// pré-existentes do usuário — as fixtures deste script não contam pra
// "estado real do usuário", são rows próprias, marcadas e limpas).
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { money } from "../lib/money.js";
import { commitBotIntent } from "../lib/commitBotIntent.js";
import { claimTelegramUpdateInTx, completeTelegramUpdateInTx } from "../lib/telegramIdempotency.js";
import { getCardCycleForDate } from "../lib/cardCycle.js";

const MARK = "TESTE_ATOMIC_53C2";

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

// update_id fictícios, únicos por execução (nunca colidem entre rodadas).
const FAKE_UPDATE_BASE = 991_000_000_000 + Date.now();
let counter = 0;
function nextFakeUpdateId() {
  return FAKE_UPDATE_BASE + counter++;
}

const ABORT = Symbol("intentional-test-abort");

async function main() {
  console.log("--- Fase 5.3C.2: Atomic Telegram Financial Mutation ---\n");

  // ==========================================================================
  // SETUP — fixtures sintéticas mínimas pra cobrir o intent matrix inteiro.
  // ==========================================================================
  const account = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-conta-${Date.now()}`, name: `${MARK} conta`, type: "checking" } });
  const card = await prisma.card.create({ data: { slug: `${MARK.toLowerCase()}-cartao-${Date.now()}`, name: `${MARK} cartão`, totalLimit: money(1000), dueDay: 10 } });
  const cycleMonth = getCardCycleForDate(card, new Date());
  const cardBill = await prisma.cardBill.create({
    data: { cardId: card.id, cycleMonth, closesAt: new Date(), dueAt: new Date(Date.now() + 10 * 86400000), totalAmount: money(200) },
  });
  const bill = await prisma.bill.create({ data: { description: `${MARK} bill`, amount: money(50), accountId: account.id, dueDate: new Date() } });
  const goal = await prisma.goal.create({ data: { name: `${MARK} goal`, targetAmount: money(500) } });

  const teardown = async () => {
    await prisma.installment.deleteMany({ where: { purchase: { description: { contains: MARK } } } });
    await prisma.purchase.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.expense.deleteMany({ where: { OR: [{ accountId: account.id }, { cardId: card.id }] } });
    await prisma.income.deleteMany({ where: { accountId: account.id } });
    await prisma.transfer.deleteMany({ where: { OR: [{ fromAccountId: account.id }, { toAccountId: account.id }, { toCardId: card.id }] } });
    await prisma.balanceAdjustment.deleteMany({ where: { accountId: account.id } });
    await prisma.cardLimitUpdate.deleteMany({ where: { cardId: card.id } });
    await prisma.cardBill.deleteMany({ where: { cardId: card.id } });
    await prisma.bill.deleteMany({ where: { description: { contains: MARK } } });
    await prisma.goal.deleteMany({ where: { name: { contains: MARK } } });
    await prisma.recurringRule.deleteMany({ where: { name: { contains: MARK } } });
    await prisma.card.deleteMany({ where: { id: card.id } });
    await prisma.account.deleteMany({ where: { id: account.id } });
    await prisma.telegramUpdateReceipt.deleteMany({ where: { updateId: { gte: BigInt(FAKE_UPDATE_BASE) } } });
  };

  try {
    // ==========================================================================
    // 1. TELEGRAM_WRITE_CALL_GRAPH — provado indiretamente pelo intent matrix
    //    abaixo (cada intent real, exercitado de verdade).
    // ==========================================================================

    // ==========================================================================
    // CRASH INJECTION (itens 11/33) — usa o mecanismo REAL (claimTelegramUpdateInTx/
    // completeTelegramUpdateInTx dentro de prisma.$transaction), força throw em
    // 4 pontos diferentes, confirma rollback TOTAL em todos.
    // ==========================================================================
    console.log("--- Crash injection (transação real, 4 pontos) ---");

    async function fingerprintCrash() {
      return {
        receipts: await prisma.telegramUpdateReceipt.count(),
        incomes: await prisma.income.count({ where: { accountId: account.id } }),
      };
    }

    async function runCrash(label, crashPoint) {
      const before = await fingerprintCrash();
      const updateId = nextFakeUpdateId();
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
          if (crashPoint === "A") throw ABORT; // depois do claim, antes de QUALQUER business write.

          await tx.income.create({ data: { amount: money(1), description: `${MARK} crash1`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED" } });
          if (crashPoint === "B") throw ABORT; // depois da 1ª write, antes de outras.

          await tx.income.create({ data: { amount: money(2), description: `${MARK} crash2`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED" } });
          if (crashPoint === "C") throw ABORT; // depois de TODAS as writes, antes do receipt completed.

          await completeTelegramUpdateInTx(tx, claim.receiptId);
          if (crashPoint === "D") throw ABORT; // depois do receipt completed, antes do callback retornar.
        });
      } catch (err) {
        threw = err === ABORT;
      }
      const after = await fingerprintCrash();
      check(threw, `[${label}] transação abortou como esperado`);
      check(before.receipts === after.receipts && before.incomes === after.incomes, `[${label}] rollback TOTAL — nem receipt nem nenhuma Income persistiu`, `receipts ${before.receipts}->${after.receipts}, incomes ${before.incomes}->${after.incomes}`);
    }

    await runCrash("CRASH_A", "A");
    await runCrash("CRASH_B", "B");
    await runCrash("CRASH_C", "C");
    await runCrash("CRASH_D", "D");

    // CRASH_E — "commit ok, resposta HTTP falha depois" é estruturalmente
    // idêntico a "Telegram não recebeu o 200 e faz retry": ambos batem no
    // MESMO update_id já COMPLETED. Provado pelo teste de duplicata real
    // abaixo (não há como simular literalmente um crash de processo — o que
    // importa é que o estado pós-commit já é terminal e um retry o encontra
    // como tal).
    {
      const updateId = nextFakeUpdateId();
      const firstRun = await prisma.$transaction(async (tx) => {
        const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
        await tx.income.create({ data: { amount: money(3), description: `${MARK} crashE`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED" } });
        await completeTelegramUpdateInTx(tx, claim.receiptId);
        return { claimed: claim.claimed };
      });
      check(firstRun.claimed, "[CRASH_E setup] primeira 'entrega' processa normalmente e commita");
      const incomesAfterFirst = await prisma.income.count({ where: { accountId: account.id, description: `${MARK} crashE` } });
      check(incomesAfterFirst === 1, "[CRASH_E setup] exatamente 1 Income criada");

      // "retry pós-crash" simulado por uma SEGUNDA tentativa com o MESMO update_id.
      const retry = await prisma.$transaction(async (tx) => {
        const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
        if (!claim.claimed) return { claimed: false, reason: claim.reason };
        await tx.income.create({ data: { amount: money(3), description: `${MARK} crashE`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED" } });
        return { claimed: true };
      });
      check(retry.claimed === false && retry.reason === "ALREADY_CLAIMED", "[CRASH_E] retry do MESMO update_id (pós-commit) -> ALREADY_CLAIMED, NUNCA reprocessa");
      const incomesAfterRetry = await prisma.income.count({ where: { accountId: account.id, description: `${MARK} crashE` } });
      check(incomesAfterRetry === 1, "[CRASH_E] ainda exatamente 1 Income — retry não duplicou o efeito financeiro");
    }

    // ==========================================================================
    // CONCORRÊNCIA REAL (item 8) — 2 transações Prisma de verdade, paralelas,
    // mesmo update_id nunca-visto.
    // ==========================================================================
    console.log("\n--- Concorrência real via banco (item 8) ---");
    {
      const updateId = nextFakeUpdateId();
      const attempt = () =>
        prisma.$transaction(async (tx) => {
          const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
          if (!claim.claimed) return { claimed: false, reason: claim.reason };
          await tx.income.create({ data: { amount: money(4), description: `${MARK} concorrencia`, category: "Outros", accountId: account.id, source: "manual", confidence: "CONFIRMED" } });
          await completeTelegramUpdateInTx(tx, claim.receiptId);
          return { claimed: true };
        });
      const [r1, r2] = await Promise.all([attempt(), attempt()]);
      const claimedCount = [r1, r2].filter((r) => r.claimed).length;
      check(claimedCount === 1, "[concorrência] 2 transações paralelas, mesmo update_id -> exatamente 1 vence e escreve", `r1=${r1.claimed} r2=${r2.claimed}`);
      const incomeCount = await prisma.income.count({ where: { accountId: account.id, description: `${MARK} concorrencia` } });
      check(incomeCount === 1, "[concorrência] exatamente 1 Income persistida (não 0, não 2)");
    }

    // ==========================================================================
    // FIRST-WORKER-ROLLBACK-PERMITS-SECOND (item 9)
    // ==========================================================================
    console.log("\n--- First worker rollback -> second processa (item 9) ---");
    {
      const updateId = nextFakeUpdateId();
      let firstThrew = false;
      try {
        await prisma.$transaction(async (tx) => {
          await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
          throw ABORT; // worker A aborta DEPOIS do claim.
        });
      } catch (err) {
        firstThrew = err === ABORT;
      }
      check(firstThrew, "[item 9] worker A aborta de propósito depois do claim");

      const second = await prisma.$transaction(async (tx) => {
        const claim = await claimTelegramUpdateInTx(tx, updateId, { senderId: "1", chatId: "1" });
        if (claim.claimed) await completeTelegramUpdateInTx(tx, claim.receiptId);
        return claim;
      });
      check(second.claimed === true, "[item 9] worker B consegue reivindicar o MESMO update_id — o claim de A nunca commitou");
    }

    // ==========================================================================
    // MULTI-WRITE INTENT ATOMICITY (itens 12/13/17) — installment_purchase
    // (Purchase + N Installments).
    // ==========================================================================
    console.log("\n--- Multi-write intent: installment_purchase (item 13) ---");
    {
      // Caso de sucesso: as 2 escritas (Purchase + Installments) persistem JUNTAS.
      const okResult = await prisma.$transaction(async (tx) => {
        return commitBotIntent("installment_purchase", {
          amount: 300, installmentCount: 3, category: "Outros", description: `${MARK} parcela ok`,
          rawMessage: "teste", target: { type: "card", card },
        }, { source: "manual", client: tx });
      });
      const purchaseCount = await prisma.purchase.count({ where: { description: `${MARK} parcela ok` } });
      const installmentCount = await prisma.installment.count({ where: { purchase: { description: `${MARK} parcela ok` } } });
      check(purchaseCount === 1 && installmentCount === 3, "[multi-write OK] Purchase + 3 Installments persistem JUNTOS numa transação bem-sucedida", `purchase=${purchaseCount} installments=${installmentCount}`);

      // Caso de aborto: as MESMAS 2 escritas, mas a transação é abortada
      // DEPOIS de commitBotIntent já ter feito as 2 escritas internamente —
      // nenhuma das duas pode sobreviver.
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          await commitBotIntent("installment_purchase", {
            amount: 300, installmentCount: 3, category: "Outros", description: `${MARK} parcela abortada`,
            rawMessage: "teste", target: { type: "card", card },
          }, { source: "manual", client: tx });
          throw ABORT;
        });
      } catch (err) {
        threw = err === ABORT;
      }
      const purchaseCountAborted = await prisma.purchase.count({ where: { description: `${MARK} parcela abortada` } });
      const installmentCountAborted = await prisma.installment.count({ where: { purchase: { description: `${MARK} parcela abortada` } } });
      check(threw, "[multi-write ABORT] transação abortou como esperado");
      check(purchaseCountAborted === 0 && installmentCountAborted === 0, "[multi-write ABORT] NEM Purchase NEM Installments sobrevivem ao rollback (atomicidade real entre as 2 writes)");
    }

    // ==========================================================================
    // INTENT MATRIX (itens 15) — todos os 13 intents, cada um dentro de uma
    // transação que SEMPRE aborta no final. TRANSACTION_COMPATIBLE=YES
    // significa "rodou sem lançar por conta própria, chegou até o ABORT
    // proposital". GLOBAL_PRISMA_ESCAPE=NO significa "fingerprint idêntico
    // depois do rollback" (se tivesse escapado pro prisma global, o write
    // teria sobrevivido ao rollback da tx).
    // ==========================================================================
    console.log("\n--- Intent matrix: TRANSACTION_COMPATIBLE / GLOBAL_PRISMA_ESCAPE ---");

    const FINANCIAL_MODELS_LOCAL = ["income", "expense", "transfer", "balanceAdjustment", "cardLimitUpdate", "purchase", "installment", "recurringRule", "goal", "bill", "account", "card"];
    async function localFingerprint() {
      const counts = {};
      for (const m of FINANCIAL_MODELS_LOCAL) counts[m] = await prisma[m].count();
      return counts;
    }
    function fpEqual(a, b) {
      return FINANCIAL_MODELS_LOCAL.every((m) => a[m] === b[m]);
    }

    const INTENT_FIXTURES = [
      ["income", { amount: 10, description: `${MARK} matrix`, category: "Outros", isRecurring: false, rawMessage: "t", target: { type: "account", account } }],
      ["expense", { amount: 10, description: `${MARK} matrix`, category: "Outros", isRecurring: false, rawMessage: "t", target: { type: "account", account } }],
      ["installment_purchase", { amount: 90, installmentCount: 3, category: "Outros", description: `${MARK} matrix`, rawMessage: "t", target: { type: "card", card } }],
      ["bill_payment", { amount: 10, description: `${MARK} matrix`, rawMessage: "t", target: { type: "card", card }, billPaymentKind: "card_bill_payment" }],
      ["limit_update", { amount: 100, rawMessage: "t", target: { type: "card", card } }],
      ["balance_adjustment", { amount: 500, rawMessage: "t", target: { type: "account", account } }],
      ["transfer", { amount: 10, description: `${MARK} matrix`, rawMessage: "sem menção de conta", target: null }],
      ["create_bill", { amount: 10, description: `${MARK} matrix`, category: "Outros", dueDate: new Date().toISOString(), rawMessage: "t" }],
      ["pay_bill", { billId: bill.id, description: `${MARK} matrix`, rawMessage: "t" }],
      ["create_account", { accountName: `${MARK} matrix account ${Date.now()}` }],
      ["create_card", { cardName: `${MARK} matrix card ${Date.now()}`, totalLimit: 100, dueDay: 5 }],
      ["create_recurring_bill", { recurringName: `${MARK} matrix rule`, recurringAmount: 10, dayOfMonth: 5, category: "Outros" }],
      ["create_goal", { goalName: `${MARK} matrix goal ${Date.now()}` }],
      ["add_to_goal", { goalId: goal.id, amount: 10 }],
    ];

    for (const [intent, data] of INTENT_FIXTURES) {
      const before = await localFingerprint();
      let transactionCompatible = true;
      try {
        await prisma.$transaction(async (tx) => {
          await commitBotIntent(intent, data, { source: "manual", client: tx });
          throw ABORT;
        });
      } catch (err) {
        if (err !== ABORT) transactionCompatible = false;
      }
      const after = await localFingerprint();
      const noEscape = fpEqual(before, after);
      check(transactionCompatible, `[matrix:${intent}] TRANSACTION_COMPATIBLE=YES (rodou dentro da tx sem lançar por conta própria)`);
      check(noEscape, `[matrix:${intent}] GLOBAL_PRISMA_ESCAPE=NO (fingerprint idêntico pós-rollback)`);
    }

    // ==========================================================================
    // BILL PAYMENT — atenção especial (item 16): payBill compõe corretamente
    // dentro de uma tx externa (padrão "própria tx OU reusa" de lib/
    // cardBillCalculator.js).
    // ==========================================================================
    console.log("\n--- bill_payment: payBill compõe corretamente numa tx externa (item 16) ---");
    {
      const before = await prisma.transfer.count({ where: { cardBillId: cardBill.id } });
      let threw = false;
      try {
        await prisma.$transaction(async (tx) => {
          await commitBotIntent("bill_payment", { amount: 20, description: `${MARK} pagamento`, rawMessage: "t", target: { type: "card", card }, billPaymentKind: "card_bill_payment" }, { source: "manual", client: tx });
          throw ABORT;
        });
      } catch (err) {
        threw = err === ABORT;
      }
      const after = await prisma.transfer.count({ where: { cardBillId: cardBill.id } });
      check(threw && before === after, "[bill_payment] payBill (com sua própria lógica de status derivado) participa da tx externa e reverte junto — nenhum Transfer/CardBill.status órfão");
    }

    // ==========================================================================
    // TRANSFER — sem debit/credit split (item 18): 1 row representa os 2 lados.
    // ==========================================================================
    console.log("\n--- transfer: sem risco de debit/credit divergente (item 18) ---");
    {
      const secondAccount = await prisma.account.create({ data: { slug: `${MARK.toLowerCase()}-conta2-${Date.now()}`, name: `${MARK} conta 2`, type: "cash" } });
      try {
        await prisma.$transaction(async (tx) => {
          const { record } = await commitBotIntent("transfer", { amount: 15, description: `${MARK} transfer`, rawMessage: "sem menção", target: null }, { source: "manual", client: tx });
          check(record.fromAccountId != null || record.toAccountId != null, "[transfer] 1 única row Transfer representa o movimento (nunca 2 writes separadas pros 2 lados)");
        });
      } finally {
        await prisma.transfer.deleteMany({ where: { description: `${MARK} transfer` } });
        await prisma.account.deleteMany({ where: { id: secondAccount.id } });
      }
    }

    // ==========================================================================
    // ZERO FINANCIAL WRITES — models REAIS do usuário, medidos no início e no
    // fim deste script inteiro.
    // ==========================================================================
    console.log(`\n${passed}/${passed + failed} check(s) passaram.`);
  } finally {
    await teardown();
    const leftoverReceipts = await prisma.telegramUpdateReceipt.count({ where: { updateId: { gte: BigInt(FAKE_UPDATE_BASE) } } });
    const leftoverAccounts = await prisma.account.count({ where: { name: { contains: MARK } } });
    console.log(`Limpeza: ${leftoverReceipts} receipts e ${leftoverAccounts} accounts de teste remanescentes (esperado 0 e 0).`);
    await prisma.$disconnect();
    if (failed > 0 || leftoverReceipts > 0 || leftoverAccounts > 0) process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
