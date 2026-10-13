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

const ANCHOR_T = new Date("2026-10-13T17:00:00Z"); // 14:00 em Brasília — instante REAL da observação (não "fim do dia")
const NOW = new Date("2026-10-13T18:00:00Z"); // MESMO DIA CIVIL, depois da âncora
// mundo pós-catch-up: Caju 248,46 e Itaú 12,28 observados em ANCHOR_T; repasses 29,50 + 71,00 PENDENTES
async function seedWorld(tx, w) {
  await tx.balanceAdjustment.create({ data: { accountId: w.caju.id, newBalance: "248.46", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: ANCHOR_T } });
  await tx.balanceAdjustment.create({ data: { accountId: w.itau.id, newBalance: "12.28", confidence: "RECONCILIATION_ADJUSTMENT", occurredAt: ANCHOR_T } });
  const a = await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "29.50", description: "Lazari", sourceLabel: "Lanche Lazari", client: tx });
  const b = await createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "71.00", description: "Rei do Pernil", client: tx });
  return { a, b };
}

async function main() {
  const before = JSON.stringify(await Promise.all(["internalReimbursement", "transfer", "income", "expense"].map((m) => prisma[m].count())));
  await inWorld(async (tx, w) => {
    const { a, b } = await seedWorld(tx, w);
    const incomes0 = await tx.income.count();
    const expenses0 = await tx.expense.count();
    const s = await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx });
    check("[Z] PENDENTE: Caju 248,46 (inalterado); pendente 100,50; após repasses 147,96", s.accountBalance === 248.46 && s.pendingTotal === 100.5 && s.availableAfterPending === 147.96 && (await bal(tx, w.itau.id)) === "12.28");
    check("[Z] PENDENTE não cria Transfer/Income/Expense", (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 0);

    // ---- MESMO DIA da âncora: o repasse liquidado depois da âncora ALTERA o saldo imediatamente
    const r1 = await settleInternalReimbursement({ id: a.id, now: NOW, client: tx });
    check("[D1] mesmo dia: Lazari 29,50 ⇒ SETTLED, Caju 248,46 → 218,96 e Itaú 12,28 → 41,78 imediatamente", r1.status === SETTLE_RESULT.SETTLED && r1.changed && (await bal(tx, w.caju.id)) === "218.96" && (await bal(tx, w.itau.id)) === "41.78", `${await bal(tx, w.caju.id)} / ${await bal(tx, w.itau.id)}`);
    const t = await tx.transfer.findFirst({ where: { kind: "internal_reimbursement" } });
    check("[D1] Transfer de INSTANTE real (18:00Z, depois da âncora 17:00Z), Caju → Itaú, 29,50", t.occurredAt.toISOString() === NOW.toISOString() && t.fromAccountId === w.caju.id && t.toAccountId === w.itau.id && t.amount.toFixed(2) === "29.50");
    const r2 = await settleInternalReimbursement({ id: b.id, now: new Date("2026-10-13T19:00:00Z"), client: tx });
    check("[D1] mesmo dia: Rei do Pernil 71,00 ⇒ Caju 147,96 e Itaú 112,78", r2.status === SETTLE_RESULT.SETTLED && (await bal(tx, w.caju.id)) === "147.96" && (await bal(tx, w.itau.id)) === "112.78");
    const repasses = await tx.internalReimbursement.findMany({ orderBy: { amount: "asc" } });
    check("[D1] os 2 repasses SETTLED (100,50), 0 PENDING; 2 Transfers (um por obrigação); 0 Income e 0 Expense criados; Itaú +100,50", repasses.every((r) => r.status === "SETTLED" && r.transferId) && (await tx.transfer.count({ where: { kind: "internal_reimbursement" } })) === 2 && (await tx.income.count()) === incomes0 && (await tx.expense.count()) === expenses0 && (await summarizeInternalReimbursements({ fromAccountId: w.caju.id, client: tx })).pendingTotal === 0 && Math.round((Number(await bal(tx, w.itau.id)) - 12.28) * 100) === 10050);

    // ---- IDEMPOTÊNCIA
    const sigT = await tx.transfer.count();
    const i1 = await settleInternalReimbursement({ id: a.id, now: new Date("2026-10-13T20:00:00Z"), client: tx });
    const i2 = await settleInternalReimbursement({ id: b.id, now: new Date("2026-10-13T20:00:00Z"), client: tx });
    check("[I] liquidar de novo ⇒ ALREADY_SETTLED, nenhuma Transfer nova, nenhum delta de saldo", i1.status === SETTLE_RESULT.ALREADY_SETTLED && i2.status === SETTLE_RESULT.ALREADY_SETTLED && !i1.changed && (await tx.transfer.count()) === sigT && (await bal(tx, w.caju.id)) === "147.96" && (await bal(tx, w.itau.id)) === "112.78");
    check("[I] auditoria da liquidação: 1 por repasse", (await tx.telegramCorrectionAudit.count({ where: { action: "settle_internal_reimbursement" } })) === 2);
  });

  // ---- MOVIMENTO ANTERIOR À ÂNCORA não é contado de novo (sem double count); posterior conta
  await inWorld(async (tx, w) => {
    await seedWorld(tx, w);
    await tx.expense.create({ data: { amount: "10", description: "já refletido no saldo observado (instante antes da âncora)", category: "Alimentação", accountId: w.caju.id, occurredAt: new Date("2026-10-13T16:00:00Z") } });
    await tx.expense.create({ data: { amount: "5", description: "data-calendário 13/10 (já refletido)", category: "Alimentação", accountId: w.caju.id, occurredAt: new Date("2026-10-13T00:00:00Z") } });
    check("[B] movimento ANTERIOR à âncora (instante 16:00Z e data-calendário 13/10) NÃO altera o saldo observado (sem double count)", (await bal(tx, w.caju.id)) === "248.46");
    await tx.expense.create({ data: { amount: "10", description: "depois da âncora", category: "Alimentação", accountId: w.caju.id, occurredAt: new Date("2026-10-13T17:30:00Z") } });
    check("[B] movimento POSTERIOR à âncora (17:30Z, mesmo dia) altera o saldo", (await bal(tx, w.caju.id)) === "238.46");
  });

  // ---- INVARIANTE: liquidação cujo instante não é posterior à âncora é RECUSADA (nunca SETTLED sem mexer no saldo)
  await inWorld(async (tx, w) => {
    const { a } = await seedWorld(tx, w);
    const e = await err(settleInternalReimbursement({ id: a.id, now: new Date("2026-10-13T16:30:00Z"), client: tx }));
    check("[V] liquidação com instante ≤ âncora ⇒ DomainError INVALID (o saldo não mudaria), nunca sucesso silencioso", e?.code === "INVALID" && /não é posterior/.test(e.message), String(e?.message));
  });
  // a falha propaga e ABORTA a transação envolvente (é o que o client raiz faz): nada persiste, nem o claim do repasse
  {
    const sig = async () => JSON.stringify(await Promise.all(["internalReimbursement", "transfer", "account"].map((m) => prisma[m].count())));
    const s0 = await sig();
    let e = null;
    try {
      await prisma.$transaction(async (tx) => {
        await wipe(tx);
        const w = await seedBefore106(tx);
        const { a } = await seedWorld(tx, w);
        await settleInternalReimbursement({ id: a.id, now: new Date("2026-10-13T16:30:00Z"), client: tx });
      }, { timeout: 120000, maxWait: 30000 });
    } catch (x) {
      e = x;
    }
    check("[V] a recusa propaga e reverte a transação envolvente (repasse segue PENDING, 0 Transfer — DEV intacto)", e?.code === "INVALID" && (await sig()) === s0, String(e?.message));
  }

  await inWorld(async (tx, w) => {
    const { a, b } = await seedWorld(tx, w);
    const e5 = await err(createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.caju.id, amount: "10", description: "x", client: tx }));
    const e6 = await err(createInternalReimbursement({ fromAccountId: w.caju.id, toAccountId: w.itau.id, amount: "0", description: "x", client: tx }));
    check("[Z] validações: mesma conta ⇒ INVALID; valor ≤ 0 ⇒ INVALID", e5?.code === "INVALID" && e6?.code === "INVALID");
    check("[Z] id inexistente ⇒ NOT_FOUND", (await err(settleInternalReimbursement({ id: "inexistente", now: NOW, client: tx })))?.code === "NOT_FOUND");
    await cancelInternalReimbursement({ id: b.id, client: tx });
    check("[Z] repasse CANCELADO não liquida; só pendente cancela; listagem de pendentes", (await err(settleInternalReimbursement({ id: b.id, now: NOW, client: tx })))?.code === "INVALID" && (await listInternalReimbursements({ status: REIMBURSEMENT_STATUS.PENDING, client: tx })).length === 1 && a.status === "PENDING");
    const m = await buildCajuModel({ now: NOW, client: tx, accountId: w.caju.id });
    check("[V] buildCajuModel expõe repasses pendentes (29,50) e saldo 'após repasses' (218,96)", m.reimbursements && m.reimbursements.pendingTotal === 29.5 && m.reimbursements.availableAfterPending === 218.96, JSON.stringify(m.reimbursements));
  });

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
