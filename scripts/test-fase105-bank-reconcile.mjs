// Fase 10.5 — CONCILIAÇÃO DO PAGAMENTO DA FATURA COM O EXTRATO pelo fluxo REAL de import do Data Hub
// (XLSX → parseImportFile → planImport → applyImportBatch → undoImportBatch), nunca chamando só reconcileBankLineWithCardBillPayment.
// DEV apenas; cada cenário numa transação que SEMPRE reverte.
//
//   node scripts/test-fase105-bank-reconcile.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { parseImportFile } from "../lib/dataHub/parse.js";
import { planImport } from "../lib/dataHub/plan.js";
import { applyImportBatch } from "../lib/dataHub/apply.js";
import { undoImportBatch } from "../lib/dataHub/undo.js";
import { payCardBillInFull, undoCardBillPayment } from "../lib/cardBillPayment.js";
import { buildItauModel } from "../lib/cardsItau.js";
import { DomainError } from "../lib/domainErrors.js";
import { wipe, seedBefore, seedReconciled, Rollback } from "./lib/catchup104Fixture.js";

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? " — " + detail : ""}`);
  }
}
const d = (s) => new Date(s);
const NOW = d("2026-10-08T15:00:00Z");
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore(tx);
        await seedReconciled(tx, w);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 180000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
// applyImportBatch/undoImportBatch abrem a PRÓPRIA transação (prisma.$transaction): dentro do teste, ela participa da transação com rollback.
const asRoot = (tx) => new Proxy(tx, { get: (t, k) => (k === "$transaction" ? (fn) => fn(t) : t[k]) });

const HEADERS = ["ID", "Valor", "Descrição", "Conta origem", "Conta destino", "Cartão destino", "Tipo", "Origem", "Data"];
async function sheetBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Transferências");
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow([r.id ?? null, r.amount, r.description, r.from ?? null, r.toAccount ?? null, r.toCard ?? null, r.kind ?? null, "extrato", r.date]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const parseRows = async (rows) => (await parseImportFile(await sheetBuffer(rows), { fileName: "extrato.xlsx" })).rowsBySheet;
const PAY_LINE = { amount: 1795.77, description: "PAGAMENTO FATURA CARTAO ITAU", from: "Itaú", toCard: "Itaú", date: d("2026-10-09T00:00:00Z") };
const counts = async (tx) => Object.fromEntries(await Promise.all(["expense", "income", "transfer", "cardBill", "purchase", "installment"].map(async (m) => [m, await tx[m].count()])));
async function importFile(tx, rowsBySheet, name) {
  const root = asRoot(tx);
  const plan = await planImport({ prisma: tx, mode: "add", datasets: ["transfers"], rowsBySheet });
  const batch = await tx.importBatch.create({ data: { fileName: name, fileHash: `${name}-${Math.random()}`, mode: "add", datasets: ["transfers"], rows: rowsBySheet, plan: {}, planFingerprint: plan.fingerprint, status: "PENDING_APPLY", expiresAt: new Date(Date.now() + 900000) } });
  const applied = await applyImportBatch(root, { id: batch.id, mode: "add", datasets: ["transfers"], rows: rowsBySheet, resolutions: {}, planFingerprint: plan.fingerprint, fileName: batch.fileName, fileHash: batch.fileHash });
  return { plan, batch, applied };
}

async function main() {
  const before = JSON.stringify(await Promise.all(["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "importBatch", "dataOperation", "telegramCorrectionAudit"].map((m) => prisma[m].count())));

  // ================================================================= cenário principal (os 11 passos do pedido)
  await inWorld(async (tx, w) => {
    // 1-3. fatura 1.795,77 UNPAID → marcar como paga manualmente → saldo cai UMA vez
    const balStart = (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2);
    const r = await payCardBillInfull(tx, w);
    const balPaid = (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2);
    check("[1-3] fatura 1.795,77 paga manualmente: Itaú 2.490,38 → 694,61 (cai uma vez)", balStart === "2490.38" && balPaid === "694.61" && r.status === "PAID");
    const c0 = await counts(tx);

    // 4. importa a linha bancária real do pagamento — pelo fluxo REAL (XLSX → parse → plan → apply)
    const rows = await parseRows([PAY_LINE]);
    check("[4] a linha do extrato chega parseada pelo parser real do Data Hub", rows.transfers?.length === 1 && Number(rows.transfers[0].amount) === 1795.77 && rows.transfers[0].toCardName === "Itaú");
    const { plan, applied, batch } = await importFile(tx, rows, "extrato-1.xlsx");
    // 5. o import reconhece o settlement existente
    check("[5] preview do import: 0 criações, 1 CONCILIAÇÃO (tag 'Concilia'), 0 inválidas", plan.summary.creates === 0 && plan.summary.reconciles === 1 && plan.summary.invalid === 0 && plan.sampleDiffRows.some((x) => x.tag === "Concilia"), JSON.stringify(plan.summary));
    // 6-9. vincula a referência; saldo NÃO cai de novo; nenhuma Expense/Transfer nova; CardBill segue PAID
    const pay = await tx.transfer.findFirst({ where: { kind: "card_bill_payment", cardBillId: r.bill.id } });
    check("[6] apply: 1 reconciliado, 0 criados; a referência bancária fica gravada no pagamento", applied.counts.reconciled === 1 && applied.counts.created === 0 && pay.rawMessage.includes("|bank=PAGAMENTO FATURA CARTAO ITAU @2026-10-09 1795.77|bankDay=2026-10-09"), pay.rawMessage);
    check("[7] SEGUNDO DÉBITO = NO: saldo do Itaú continua 694,61", (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2) === "694.61");
    const c1 = await counts(tx);
    check("[8] nenhuma Expense/Transfer/Income nova depois do import", JSON.stringify(c1) === JSON.stringify(c0));
    check("[9] a CardBill continua PAGA (paidAmount 1.795,77)", (await tx.cardBill.findUnique({ where: { id: r.bill.id } })).status === "paid");
    // 10. pagamento RECONCILED (modelo/UI)
    const model = await buildItauModel({ now: NOW, client: tx });
    check("[10] pagamento RECONCILED: read-model marca 'conferido com o extrato' e não oferece desfazer", model.paidBill.reconciledWithBank === true && model.paidBill.undoable === false);
    // 11. undo (API) recusado
    let e = null;
    try {
      await undoCardBillPayment({ cardBillId: r.bill.id, now: NOW, client: tx });
    } catch (x) {
      e = x;
    }
    check("[11] undo via API (lib que a rota chama) ⇒ BLOCKED_RECONCILED_PAYMENT; nada alterado", e instanceof DomainError && e.code === "BLOCKED_RECONCILED_PAYMENT" && JSON.stringify(await counts(tx)) === JSON.stringify(c1) && (await tx.cardBill.findUnique({ where: { id: r.bill.id } })).status === "paid");

    // reimportar a MESMA linha: não duplica, não reconcilia de novo
    const again = await importFile(tx, rows, "extrato-1-de-novo.xlsx");
    check("[+] reimportar a MESMA linha ⇒ 0 criações, 0 conciliações novas (já existe/conciliada), nenhum débito", again.plan.summary.creates === 0 && again.plan.summary.reconciles === 0 && again.applied.counts.created === 0 && (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2) === "694.61");

    // desfazer o LOTE de import restaura o estado "não conciliado" (e só a anotação — nunca o pagamento)
    const undoneBatch = await undoImportBatch(asRoot(tx), await tx.importBatch.findUnique({ where: { id: batch.id } }));
    const payAfterBatchUndo = await tx.transfer.findFirst({ where: { cardBillId: r.bill.id, kind: "card_bill_payment" } });
    check("[+] desfazer o lote do import só remove a anotação bancária; o pagamento e o saldo permanecem", !payAfterBatchUndo.rawMessage.includes("|bank=") && (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2) === "694.61" && undoneBatch.restored >= 1);
  });

  // ================================================================= ambiguidade: nunca reconcilia sozinho
  await inWorld(async (tx, w) => {
    const r = await payCardBillInfull(tx, w);
    // 2º pagamento manual compatível (mesma conta, mesmo valor, mesma janela) — situação ambígua
    const bill11 = await tx.cardBill.findUnique({ where: { cardId_cycleMonth: { cardId: w.card.id, cycleMonth: "2026-11" } } });
    await tx.transfer.create({ data: { amount: "1795.77", description: "pagamento duplicado de teste", fromAccountId: w.itau.id, toCardId: w.card.id, cardBillId: bill11.id, kind: "card_bill_payment", source: "manual", rawMessage: `CARD_BILL_PAYMENT|v1|bill=${bill11.id}|cycle=2026-11|amount=1795.77|acct=${w.itau.id}|day=2026-10-08`, occurredAt: d("2026-10-08T00:00:00Z") } });
    const c0 = await counts(tx);
    const rows = await parseRows([PAY_LINE]);
    const { plan, applied } = await importFile(tx, rows, "extrato-ambiguo.xlsx");
    check("[A] 2 pagamentos compatíveis ⇒ NÃO reconcilia sozinho: vai para revisão (inválida com aviso), 0 criações", plan.summary.reconciles === 0 && plan.summary.creates === 0 && plan.summary.invalid === 1 && /ambiguidade/.test(plan.perDataset.transfers.invalid[0].reason) && plan.perDataset.transfers.invalid[0].candidateIds.length === 2, JSON.stringify(plan.perDataset.transfers.invalid));
    check("[A] nada foi gravado (sem referência bancária, sem 2º débito)", applied.counts.reconciled === 0 && applied.counts.created === 0 && JSON.stringify(await counts(tx)) === JSON.stringify(c0) && !(await tx.transfer.findMany({ where: { kind: "card_bill_payment" } })).some((t) => t.rawMessage.includes("|bank=")));
    void r;
  });

  // ================================================================= outras linhas não são afetadas
  await inWorld(async (tx, w) => {
    await payCardBillInfull(tx, w);
    // (a) linha com valor diferente: não concilia (segue o comportamento de sempre: criaria a transferência)
    const rowsDiff = await parseRows([{ ...PAY_LINE, amount: 1795.0 }]);
    const planDiff = await planImport({ prisma: tx, mode: "add", datasets: ["transfers"], rowsBySheet: rowsDiff });
    check("[N] linha de valor diferente NÃO concilia (0 conciliações)", planDiff.summary.reconciles === 0 && planDiff.summary.creates === 1);
    // (b) transferência comum entre contas continua criando normalmente
    const rowsPlain = await parseRows([{ amount: 50, description: "Pix para a Caju", from: "Itaú", toAccount: "Vale Alimentação", date: d("2026-10-09T00:00:00Z") }]);
    const planPlain = await planImport({ prisma: tx, mode: "add", datasets: ["transfers"], rowsBySheet: rowsPlain });
    check("[N] transferência comum (sem cartão/fatura) segue o fluxo normal: 1 criação, 0 conciliações", planPlain.summary.creates === 1 && planPlain.summary.reconciles === 0);
    // (c) fora da janela (30 dias depois) não concilia
    const rowsLate = await parseRows([{ ...PAY_LINE, date: d("2026-11-20T00:00:00Z") }]);
    const planLate = await planImport({ prisma: tx, mode: "add", datasets: ["transfers"], rowsBySheet: rowsLate });
    check("[N] linha fora da janela de ±5 dias NÃO concilia", planLate.summary.reconciles === 0);
    // (d) round-trip de exportação do próprio Norte (a linha traz o ID do pagamento) ⇒ já existe, nunca reconcilia nem duplica
    const pay = await tx.transfer.findFirst({ where: { kind: "card_bill_payment" } });
    const rowsRound = await parseRows([{ id: pay.id, amount: 1795.77, description: pay.description, from: "Itaú", toCard: "Itaú", kind: "card_bill_payment", date: d("2026-10-08T00:00:00Z") }]);
    const planRound = await planImport({ prisma: tx, mode: "add", datasets: ["transfers"], rowsBySheet: rowsRound });
    check("[N] linha vinda de uma exportação do próprio Norte (mesmo ID) ⇒ 'já existe': 0 criações, 0 conciliações", planRound.summary.creates === 0 && planRound.summary.reconciles === 0 && planRound.summary.skips === 1);
  });

  // ================================================================= desfazer ANTES da conciliação funciona (outro fixture)
  await inWorld(async (tx, w) => {
    const r = await payCardBillInfull(tx, w);
    const u = await undoCardBillPayment({ cardBillId: r.bill.id, now: NOW, client: tx });
    check("[U] ANTES de conciliar: desfazer funciona (UNDONE) e o saldo volta a 2.490,38", u.status === "UNDONE" && (await computeAccountBalance(w.itau.id, { client: tx })).toFixed(2) === "2490.38");
  });

  const after = JSON.stringify(await Promise.all(["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "importBatch", "dataOperation", "telegramCorrectionAudit"].map((m) => prisma[m].count())));
  check("[W] isolamento: contagens do DEV idênticas antes × depois (rollback em todos os cenários)", before === after, `${before} vs ${after}`);
}

async function payCardBillInfull(tx, w) {
  return payCardBillInFull({ cardId: w.card.id, cycleMonth: "2026-10", now: NOW, client: tx });
}

try {
  await main();
} catch (e) {
  fail++;
  console.log("❌ erro inesperado:", e);
} finally {
  await prisma.$disconnect();
}
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail === 0 ? 0 : 1);
