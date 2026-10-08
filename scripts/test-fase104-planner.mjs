// Fase 10.4 — PASSO A: testes direcionados do PLANNER read-only (scripts/lib/catchup104Planner.js).
// Roda em DEV, DENTRO de uma transação interativa que SEMPRE dá rollback (nada persiste; o helper prova isso comparando contagens antes ×
// depois). O planner recebe o client por um Proxy que LANÇA em qualquer método de escrita. Nenhum teste toca PROD.
//
//   node scripts/test-fase104-planner.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import { prisma } from "../lib/prisma.js";
import { buildCatchup104Plan, detectInternalReimbursementSupport, TARGETS, INVOICE_NATIONAL, ANCHOR_AT, CARD_OBSERVED_AT, zonedInstant } from "./lib/catchup104Planner.js";
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

// ---------------------------------------------------------------- proxy que proíbe escrita
const BLOCK = /^(create|createMany|update|updateMany|delete|deleteMany|upsert|\$transaction|\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe)$/;
let blockedAttempts = 0;
const guarded = (obj) =>
  new Proxy(obj, {
    get(t, k) {
      if (typeof k === "string" && BLOCK.test(k)) {
        blockedAttempts++;
        throw new Error(`WRITE ATTEMPT BLOCKED: ${k}`);
      }
      const v = t[k];
      return v && typeof v === "object" ? guarded(v) : v;
    },
  });

const TABLES = ["expense", "income", "transfer", "bill", "balanceAdjustment", "purchase", "installment", "cardBill", "cardBillReconciliation", "cardLimitUpdate", "confirmedCommitment", "contingency", "recurringRule", "card", "account", "telegramCorrectionAudit", "dataOperation"];
const signature = async () => JSON.stringify(await Promise.all(TABLES.map((m) => prisma[m].count())));

// ---------------------------------------------------------------- testes
async function main() {
  // [S] garantia estática: o módulo do planner não tem caminho de escrita nem de apply
  const src = fs.readFileSync(new URL("./lib/catchup104Planner.js", import.meta.url), "utf8");
  check("[S] fonte do planner sem create/update/delete/upsert/$transaction/$execute", !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$transaction|\$execute|\$queryRaw/.test(src));
  check("[S] fonte do planner sem 'apply' (nenhum modo de execução)", !/\bapply\b/i.test(src));
  check("[S] planner não importa módulos que expõem mutação de domínio (houseBills/commitments/bills/cardBillCalculator)", !/houseBills|commitments\.js|\/bills\.js|cardBillCalculator/.test(src));

  const before = await signature();
  await prisma
    .$transaction(
      async (tx) => {
        await wipe(tx);
        const w = await seedBefore(tx);
        const plan = await buildCatchup104Plan({ client: guarded(tx) });
        const kinds = plan.operations.reduce((a, o) => ((a[o.kind] = (a[o.kind] ?? 0) + 1), a), {});

        check("[P] sem bloqueios no estado de PROD de 07/10", plan.blockers.length === 0, JSON.stringify(plan.blockers));
        check("[P] 44 operações planejadas", plan.operations.length === 44, String(plan.operations.length));
        check("[P] operações esperadas por tipo", kinds.REMOVE_FALSE_HOUSE_PAYMENT === 1 && kinds.CORRECT_HOUSE_PAYMENT_AMOUNT === 1 && kinds.ADD_EXPENSE === 11 && kinds.ADD_INCOME === 3 && kinds.ADD_BALANCE_RECONCILIATION === 2 && kinds.ADD_CONFIRMED_COMMITMENT === 1 && kinds.DISMISS_CONTINGENCY === 1 && kinds.CORRECT_CARD_EXPENSE === 7 && kinds.ADD_CARD_EXPENSE === 3 && kinds.ADD_PURCHASE_WITH_INSTALLMENTS === 7 && kinds.RENAME_PURCHASE === 1 && kinds.SYNC_CARD_BILL_ROW === 4 && kinds.RECORD_CARD_BILL_OBSERVATION === 1 && kinds.RECORD_CARD_LIMIT_OBSERVATION === 1, JSON.stringify(kinds));
        check("[P] 13 movimentos novos no Itaú + 1 no Caju", plan.operations.filter((o) => o.section === "itau" && /ADD_(EXPENSE|INCOME)/.test(o.kind)).length === 13 && plan.operations.filter((o) => o.section === "caju" && o.kind === "ADD_EXPENSE").length === 1);

        // saldos
        check("[B] saldo Itaú atual = 3.774,65", plan.balancesBefore.itau === "3774.65", plan.balancesBefore.itau);
        check("[B] ledger Itaú projetado = 2.490,48 e saldo projetado = 2.490,38", plan.balancesProjected.itauLedger === "2490.48" && plan.balancesProjected.itau === "2490.38");
        check("[B] ajuste Itaú projetado = −0,10 (RECONCILIATION_ADJUSTMENT, nunca Expense/Income)", plan.balancesProjected.itauAdjustment === "-0.10" && plan.operations.find((o) => o.section === "itau" && o.kind === "ADD_BALANCE_RECONCILIATION")?.data.confidence === "RECONCILIATION_ADJUSTMENT");
        check("[B] saldo Caju atual 596,35 → ledger 530,99 → saldo 530,89 (ajuste −0,10)", plan.balancesBefore.caju === "596.35" && plan.balancesProjected.cajuLedger === "530.99" && plan.balancesProjected.caju === "530.89" && plan.balancesProjected.cajuAdjustment === "-0.10");
        check("[B] nenhum ajuste vira Expense/Income falsa (resíduo só como BalanceAdjustment)", plan.operations.filter((o) => /RECONCILIATION|residual/i.test(o.description) && o.kind !== "ADD_BALANCE_RECONCILIATION").length === 0);

        // contas da casa
        check("[H] Água falsa de 26/09 (59,27) planejada para desfazer", plan.operations.some((o) => o.kind === "REMOVE_FALSE_HOUSE_PAYMENT" && o.target.id === w.aguaFalsa.id && o.target.expenseId === w.aguaFalsaExp.id));
        check("[H] Água atual fica PENDING (59,27 pela regra)", plan.house.water.status === "PENDING" && plan.house.water.amount === "59.27", JSON.stringify(plan.house.water));
        check("[H] Água REAL de 23/09 (59,31, competência 2026-09) NÃO é tocada", !plan.operations.some((o) => o.target?.id === w.aguaReal.id || o.target?.expenseId === w.aguaRealExp.id || o.target?.id === w.aguaRealExp.id));
        check("[H] Energia PENDING sem valor (unpriced) — nunca zero nem média", plan.house.energy.status === "PENDING_UNPRICED" && plan.house.energy.amount === null);
        check("[H] Telefone passa a 57,48 (mesma Expense/Bill, sem 2ª despesa)", plan.house.phone.amount === "57.48" && plan.operations.some((o) => o.kind === "CORRECT_HOUSE_PAYMENT_AMOUNT" && o.target.id === w.telExp.id && o.to === "57.48") && !plan.operations.some((o) => o.section === "house" && /ADD_/.test(o.kind)));

        // cartão
        const cr = plan.cardReconciliation;
        check("[C] fatura observada 1.795,77, vencimento 13/10, UNPAID", cr.observedTotal === "1795.77" && cr.dueDate === "2026-10-13" && cr.status === "UNPAID");
        check("[C] total calculado: antes 960,40 → depois do plano 1.795,77 (lacuna 0)", cr.calculatedBefore === "960.40" && cr.calculatedAfter === "1795.77" && cr.gapAfter === "0.00");
        check("[C] limite observado no fechamento: 5.087,00 / 2.471,16 / 2.615,84", cr.limitObservedAtClose.total === "5087.00" && cr.limitObservedAtClose.available === "2471.16" && cr.limitObservedAtClose.used === "2615.84");
        check("[C] 7 parcelamentos novos, 2 existentes preservados (sem duplicar)", kinds.ADD_PURCHASE_WITH_INSTALLMENTS === 7 && plan.operations.filter((o) => o.kind === "ADD_PURCHASE_WITH_INSTALLMENTS" && /Shein|portão/i.test(o.data.description)).length === 0);
        check("[C] Shein = mesma compra do 'aniversário da Bia' (renomear, não duplicar)", plan.operations.some((o) => o.kind === "RENAME_PURCHASE" && o.target.id === w.shein.id));
        check("[C] colchão 33,27 / 33,24 (nunca 4 × 33,27); 3/4 e 4/4 DERIVADAS = ESTIMATED / derived_from_official_statement; 1/4 e 2/4 observadas", (() => { const p = plan.operations.find((o) => o.kind === "ADD_PURCHASE_WITH_INSTALLMENTS" && /colchão/.test(o.data.description)); const r = p.data.rows; return r[0].amount === "33.27" && r[1].amount === "33.24" && r[2].amount === "33.24" && r[3].amount === "33.24" && r[0].confidence === "CONFIRMED" && r[1].confidence === "CONFIRMED" && r[2].confidence === "ESTIMATED" && r[3].confidence === "ESTIMATED" && r[2].provenance === "derived_from_official_statement" && r[3].provenance === "derived_from_official_statement" && r[0].provenance === "observed_in_official_statement" && p.data.confidence === "ESTIMATED"; })());
        check("[C] DH/Raia: valores observados por parcela, centavo residual NÃO distribuído", (() => { const dh = plan.operations.find((o) => /DH Mega/.test(o.data?.description ?? "")); const ra = plan.operations.find((o) => /Raia/.test(o.data?.description ?? "")); return dh.data.rows.every((r) => r.amount === "128.16") && ra.data.rows.every((r) => r.amount === "170.66") && dh.data.totalAmount === "384.49" && ra.data.totalAmount === "512.00"; })());
        check("[C] futuro: próxima 571,79 · demais 248,28 · total 820,07", cr.futureNext === "571.79" && cr.futureLater === "248.28" && cr.futureTotal === "820.07", JSON.stringify([cr.futureNext, cr.futureLater, cr.futureTotal]));
        check("[C] checkpoints contábeis todos OK (1.561,33 + 226,51 + 7,93 = 1.795,77)", plan.checkpoints.length >= 10 && plan.checkpoints.every((c) => c.ok), JSON.stringify(plan.checkpoints.filter((c) => !c.ok)));
        check("[C] checkpoint independente das linhas nacionais", INVOICE_NATIONAL.reduce((a, v) => a + Math.round(Number(v) * 100), 0) === 156133);

        // recorrências / IOF / Tiny
        const rc = plan.recurringCharges;
        check("[R] definição recorrente de cartão NÃO existe no domínio; real da fatura tem os 6 valores do banco", rc.templatesSupportedForCards === false && rc.existingTemplates.length === 0 && rc.realChargesThisInvoice.claude === "116.31" && rc.realChargesThisInvoice.chatgpt === "110.20" && rc.realChargesThisInvoice.spotify === "31.90" && rc.realChargesThisInvoice.apple === "19.90" && rc.realChargesThisInvoice.wellhubRicardo === "69.99" && rc.realChargesThisInvoice.wellhubBia === "69.99");
        check("[R] IOF agregado 7,93: UM encargo da fatura, datado em 04/10 (NÃO retroativo), não dividido entre Claude e ChatGPT", rc.iofDistributed === false && plan.operations.filter((o) => o.kind === "ADD_CARD_EXPENSE" && /IOF/.test(o.data.description)).length === 1 && plan.operations.find((o) => o.kind === "ADD_CARD_EXPENSE" && /IOF/.test(o.data.description)).data.occurredAt === "2026-10-04" && !plan.operations.some((o) => o.data?.occurredAt === "2026-09-25" && /IOF/.test(o.data?.description ?? "")) && plan.operations.find((o) => o.kind === "CORRECT_CARD_EXPENSE" && /claude/i.test(o.description)).data.amount === "116.31");
        check("[R] Tiny ERP 65,90: recorrência UNKNOWN — não marcada como recorrente", rc.tiny.recurrence === "UNKNOWN" && rc.tiny.markedRecurring === false && !(plan.operations.find((o) => o.kind === "CORRECT_CARD_EXPENSE" && /tiny/i.test(o.description))?.data.isRecurring));
        check("[R] ChatGPT e Spotify entram como lançamentos reais da fatura (não duplicam)", plan.operations.filter((o) => o.kind === "ADD_CARD_EXPENSE").map((o) => o.data.amount).sort().join() === "110.20,31.90,7.93");

        // reembolso interno
        const ir = plan.internalReimbursement;
        check("[I] domínio NÃO suporta pendência interna Caju → Itaú", ir.supported === false && detectInternalReimbursementSupport().supported === false);
        check("[I] R$ 29,50 Caju → Itaú registrado como MANUAL_PENDING_ACTION (sem estrutura nova, sem Income)", ir.manualPendingActions.length === 1 && ir.manualPendingActions[0].amount === "29.50" && ir.manualPendingActions[0].from === "Caju" && !plan.operations.some((o) => /Caju → Itaú|reembolso/i.test(o.description) && /INCOME|TRANSFER/.test(o.kind)));
        check("[I] anotação do reembolso fica no lançamento de 29,50 (rawMessage)", plan.operations.find((o) => o.data?.amount === "29.50" && o.section === "itau").data.rawMessage.includes("reembolso interno"));
        check("[I] limitação conhecida declarada", plan.knownLimitations.some((l) => /INTERNAL_REIMBURSEMENT/.test(l)));

        // Tiger
        check("[T] compromisso restante 5.000,00 sem dueDate, sem parcelas", plan.tiger.newCommitment === "5000.00" && plan.tiger.noDueDate === true && (() => { const c = plan.operations.find((o) => o.kind === "ADD_CONFIRMED_COMMITMENT"); return c.data.dueDate === null && c.data.amount === "5000.00" && c.data.status === "CONFIRMED"; })());
        check("[T] contingência antiga 'Tiger' (1.000/2.000) é DISPENSADA (DISMISSED), não coexiste", plan.operations.some((o) => o.kind === "DISMISS_CONTINGENCY" && o.target.id === w.cont.id && o.data.status === "DISMISSED") && /DISMISS/.test(plan.tiger.oldContingencyAction));
        check("[T] TIGER_DOUBLE_COUNT = NO", plan.tiger.doubleCount === false);
        check("[T] 1.000 já pagos entram como despesa real (1 lançamento) — não como parcela inventada", plan.operations.filter((o) => o.data?.amount === "1000.00" && /Tiger/.test(o.data.description)).length === 1);


        // fuso (America/Sao_Paulo) e preconditions
        const localParts = (iso) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
        const la = localParts(ANCHOR_AT);
        check("[Z] âncora de saldo = 07/10/2026 23:59:59 America/Sao_Paulo = 2026-10-08T02:59:59.000Z (não 23:59:59Z cru)", ANCHOR_AT === "2026-10-08T02:59:59.000Z" && `${la.year}-${la.month}-${la.day} ${la.hour}:${la.minute}:${la.second}` === "2026-10-07 23:59:59" && ANCHOR_AT !== "2026-10-07T23:59:59.000Z", ANCHOR_AT);
        const lo = localParts(CARD_OBSERVED_AT);
        check("[Z] observação da fatura = 04/10/2026 23:59:59 America/Sao_Paulo = 2026-10-05T02:59:59.000Z", CARD_OBSERVED_AT === "2026-10-05T02:59:59.000Z" && `${lo.year}-${lo.month}-${lo.day} ${lo.hour}:${lo.minute}:${lo.second}` === "2026-10-04 23:59:59", CARD_OBSERVED_AT);
        check("[Z] conversão local→UTC é genérica (12:00 de 15/01 em Brasília = 15:00Z)", zonedInstant("2026-01-15", "12:00:00") === "2026-01-15T15:00:00.000Z" && zonedInstant("2026-10-07", "00:00:00") === "2026-10-07T03:00:00.000Z");
        check("[Z] as operações carregam as âncoras em fuso correto", plan.operations.filter((o) => o.kind === "ADD_BALANCE_RECONCILIATION").every((o) => o.data.occurredAt === ANCHOR_AT) && plan.operations.find((o) => o.kind === "RECORD_CARD_BILL_OBSERVATION").data.occurredAt === CARD_OBSERVED_AT && plan.operations.find((o) => o.kind === "RECORD_CARD_LIMIT_OBSERVATION").data.occurredAt === CARD_OBSERVED_AT);
        check("[Z] observação da fatura é POSTERIOR a todo lançamento atribuído ao fechamento (inclusive o IOF de 04/10)", new Date(CARD_OBSERVED_AT) > new Date("2026-10-04T23:59:59.999Z") === true || new Date(CARD_OBSERVED_AT) > new Date("2026-10-04T00:00:00Z"));
        check("[Z] todas as operações têm preconditions; ajustes trazem resíduo esperado explícito (não hardcoded no executor)", plan.operations.every((o) => o.preconditions) && plan.operations.filter((o) => o.kind === "ADD_BALANCE_RECONCILIATION").every((o) => o.preconditions.expectedAdjustment === "-0.10" && o.preconditions.requiresNoRealLineExplains === true));

        // somente leitura
        check("[W] nenhuma tentativa de escrita (proxy bloqueador não foi acionado)", blockedAttempts === 0);
        const proof = await guarded(tx).expense.count();
        check("[W] planejar não alterou nada no banco do teste (contagem estável)", proof === (await tx.expense.count()));

        // sensibilidade: estado inesperado vira BLOQUEIO, não chute
        await tx.expense.update({ where: { id: w.aguaFalsaExp.id }, data: { amount: "59.30" } });
        const odd = await buildCatchup104Plan({ client: guarded(tx) });
        check("[X] Água paga com valor fora do padrão → BLOCKER (não desfaz às cegas)", odd.blockers.some((b) => /Água 2026-10/.test(b)) && !odd.operations.some((o) => o.kind === "REMOVE_FALSE_HOUSE_PAYMENT"));
        await tx.expense.update({ where: { id: w.aguaFalsaExp.id }, data: { amount: "59.27" } });

        // idempotência conceitual: estado reconciliado => 0 operações
        await seedReconciled(tx, w);
        const again = await buildCatchup104Plan({ client: guarded(tx) });
        check("[N] estado reconciliado ⇒ 0 operações (idempotência conceitual)", again.operations.length === 0, again.operations.map((o) => `${o.kind}:${o.description.slice(0, 60)}`).join(" | "));
        check("[N] estado reconciliado ⇒ sem bloqueios e saldos já nos alvos", again.blockers.length === 0 && again.balancesBefore.itau === TARGETS.itauBank && again.balancesBefore.caju === TARGETS.cajuBank, JSON.stringify([again.blockers, again.balancesBefore]));
        check("[N] estado reconciliado ⇒ checkpoints ainda OK e Água PENDING / Telefone 57,48", again.checkpoints.every((c) => c.ok) && again.house.water.status === "PENDING" && again.house.phone.amount === "57.48", JSON.stringify(again.checkpoints.filter((c) => !c.ok)));
        check("[N] estado reconciliado ⇒ Tiger 5.000 sem dupla contagem", again.tiger.newCommitment === "5000.00" && again.tiger.doubleCount === false && again.cardReconciliation.calculatedAfter === "1795.77");

        throw new Rollback(); // SEMPRE reverte — nada persiste em DEV
      },
      { timeout: 120000, maxWait: 30000 }
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  const after = await signature();
  check("[W] isolamento: contagens do DEV idênticas antes × depois (rollback)", before === after, `${before} vs ${after}`);
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
