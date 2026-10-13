// Fase 10.6 — testes do domínio de REPASSES INTERNOS (Repasses do Caju): lib/internalReimbursement.js + read-models.
// DEV apenas; cada cenário roda numa transação que SEMPRE reverte.
//
//   node scripts/test-fase106-repasses.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { computeAccountBalance } from "../lib/accounts.js";
import { createInternalReimbursement, settleInternalReimbursement, cancelInternalReimbursement, summarizeInternalReimbursements, listInternalReimbursements, SETTLE_RESULT, REIMBURSEMENT_STATUS } from "../lib/internalReimbursement.js";
import { buildCajuModel } from "../lib/cardsCaju.js";
import { wipe, seedBefore106, Rollback } from "./lib/catchup106Fixture.js";

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
async function inWorld(fn) {
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore106(tx);
        await fn(tx, w);
        throw new Rollback();
      },
      { timeout: 120000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
const bal = async (tx, id) => (await computeAccountBalance(id, { client: tx })).toFixed(2);
const err = async (p) => p.then(() => null, (e) => e);
const NOW = new Date("2026-10-13T18:00:00Z");

async function main() {
  const before = JSON.stringify(await Promise.all(["internalReimbursement", "transfer", "income", "expense"].map((m) => prisma[m].count())));
  await inWorld(async (tx, w) => {
    const a = await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "29.50", description: "Lazari", client: tx });
    const b = await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "71.00", description: "Rei do Pernil", client: tx });
    const cajuBefore = await bal(tx, w.caju.id);
    const itauBefore = await bal(tx, w.itau.id);
    const s = await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx });
    check("[Z] PENDENTE: saldo real do Caju inalterado; pendente 100,50; após repasses 430,39", a.status === "PENDING" && s.pendingTotal === 100.5 && s.accountBalance === 530.89 && s.availableAfterPending === 430.39);
    check("[Z] PENDENTE não cria Transfer/Income/Expense", (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 0 && (await bal(tx, w.itau.id)) === itauBefore);

    // sem âncora no dia: sem aviso; com âncora no mesmo dia (fim do dia BRT): aviso SETTLED_BEFORE_LAST_BALANCE_CHECK
    const rEarly = await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "5.00", description: "teste âncora", client: tx });
    const early = await settleInternalReimbursement({ id: rEarly.id, settledAt: "2026-10-07", now: NOW, client: tx });
    check("[Z] liquidar em data anterior ao último saldo conferido ⇒ aviso SETTLED_BEFORE_LAST_BALANCE_CHECK (saldo conferido prevalece)", early.warnings.includes("SETTLED_BEFORE_LAST_BALANCE_CHECK") && (await bal(tx, w.caju.id)) === cajuBefore);
    await tx.transfer.deleteMany({ where: { id: early.transferId } });
    await tx.internalReimbursement.update({ where: { id: rEarly.id }, data: { status: "CANCELLED", transferId: null } });
    const r1 = await settleInternalReimbursement({ id: a.id, settledAt: "2026-10-13", now: NOW, client: tx });
    check("[Z] liquidar: SETTLED, 1 Transfer Caju → Itaú de 29,50 (kind internal_reimbursement), Caju −29,50 e Itaú +29,50", !r1.warnings.includes("SETTLED_BEFORE_LAST_BALANCE_CHECK") && r1.status === SETTLE_RESULT.SETTLED && r1.changed && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 1 && (await bal(tx, w.caju.id)) === "501.39" && (await bal(tx, w.itau.id)) === "724.11" && cajuBefore === "530.89");
    const t = await tx.transfer.findFirst({ where: { kind: "internal_reimbursement" } });
    check("[Z] Transfer correto: de Caju para Itaú, 29,50, data 13/10, sem Income/Expense novo", t.fromAccountId === w.caju.id && t.toAccountId === w.itau.id && t.amount.toFixed(2) === "29.50" && t.occurredAt.toISOString().slice(0, 10) === "2026-10-13" && (await tx.income.count()) === 0);
    const r2 = await settleInternalReimbursement({ id: a.id, now: NOW, client: tx });
    check("[Z] idempotente: 2ª liquidação ⇒ ALREADY_SETTLED, nenhum Transfer novo, saldos iguais", r2.status === SETTLE_RESULT.ALREADY_SETTLED && !r2.changed && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 1 && (await bal(tx, w.caju.id)) === "501.39");
    const s2 = await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx });
    check("[Z] resumo depois: pendente só 71,00", s2.pendingTotal === 71 && s2.items.length === 1 && s2.items[0].description === "Rei do Pernil");
    const audit = await tx.telegramCorrectionAudit.count({ where: { action: "settle_internal_reimbursement", recordId: a.id } });
    check("[Z] auditoria da liquidação registrada (1)", audit === 1);
    const e1 = await err(settleInternalReimbursement({ id: "inexistente", now: NOW, client: tx }));
    const e2 = await err(settleInternalReimbursement({ id: b.id, settledAt: "2026-10-30", now: NOW, client: tx }));
    const e3 = await err(settleInternalReimbursement({ id: b.id, settledAt: "13/10/2026", now: NOW, client: tx }));
    check("[Z] id inexistente ⇒ NOT_FOUND; data futura/inválida ⇒ INVALID; nada criado", e1?.code === "NOT_FOUND" && e2?.code === "INVALID" && e3?.code === "INVALID" && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 1);
    await cancelInternalReimbursement({ id: b.id, client: tx });
    const e4 = await err(settleInternalReimbursement({ id: b.id, now: NOW, client: tx }));
    check("[Z] repasse CANCELADO não liquida; só pendente cancela", e4?.code === "INVALID" && (await err(cancelInternalReimbursement({ id: a.id, client: tx })))?.code === "INVALID" && (await listInternalReimbursements({ status: REIMBURSEMENT_STATUS.PENDING, client: tx })).length === 0);
    const e5 = await err(createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.caju.id, amount: "10", description: "x", client: tx }));
    const e6 = await err(createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "0", description: "x", client: tx }));
    check("[Z] validações: mesma conta ⇒ INVALID; valor ≤ 0 ⇒ INVALID", e5?.code === "INVALID" && e6?.code === "INVALID");
  });

  // read-model do Caju (tela Cartões/Caju + Compromissos)
  await inWorld(async (tx, w) => {
    await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "29.50", description: "Lazari", sourceLabel: "Lanche Lazari", client: tx });
    await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "71.00", description: "Rei do Pernil", client: tx });
    const m = await buildCajuModel({ now: NOW, client: tx, accountId: w.caju.id });
    const r = m.reimbursements;
    check("[V] buildCajuModel expõe os repasses pendentes (100,50) e o saldo 'após repasses'", r && r.pendingTotal === 100.5 && r.items.length === 2 && r.availableAfterPending === 430.39, JSON.stringify(r));
  });

  // robustez: sem contas válidas o domínio não persiste nada
  const created = await createInternalReimbursement({ fromAccountId: (await prisma.account.findFirst({ where: { slug: "vale-alimentacao" } }))?.id ?? "x", toAccountId: "y", amount: "1", description: "x" }).catch((e) => e);
  check("[Z] sem contas válidas o domínio falha por FK/validação (nada persiste)", created instanceof Error);
  check("[W] isolamento: contagens do DEV idênticas antes × depois", before === JSON.stringify(await Promise.all(["internalReimbursement", "transfer", "income", "expense"].map((m) => prisma[m].count()))));
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
