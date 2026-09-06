// ============================================================================
// Fase 5.1B-CARD — PRIMEIRA escrita real desta reconciliação inteira.
//
// Escopo ESTRITAMENTE limitado a Card + CardBill. Nenhum outro model é
// tocado (verificado por fingerprint antes/depois, ver item 19 do pedido).
//
// Genérico de propósito: os valores canônicos (totalLimit/closingDay/dueDay/
// bills por cycleMonth) vêm do MESMO input gitignored já usado pela Fase
// 5.1A (scripts/snapshot-input.local.json, seção `card`) — nunca hardcoded
// aqui. A decisão de DELETE da CardBill legada é DERIVADA na hora, por
// execução real de investigateLegacyCardBillArtifact (mesma função da Fase
// 5.1A), nunca por um id fixo escrito à mão.
//
// assertTestEnvironment() é a primeira linha (antes até do import do Prisma,
// como a própria guarda documenta) — fail-closed: aborta se o ambiente não
// for inequivocamente dev/test.
// ============================================================================
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.js";
import { money, addMoney, subtractMoney, sumMoney, compareMoney, isPositive } from "../lib/money.js";
import { getCardBillClosesAt, getCardBillDueDate } from "../lib/cardCycle.js";
import { listCardBillsView, computeExpectedCardBillTotal } from "../lib/cardBillCalculator.js";
import { resolveCurrentRelevantCardBillCycleMonth } from "../lib/freeMoney.js";
import { classifyCardBill, OBLIGATION_CLASS } from "../lib/obligationClassifier.js";
import { computeCardUsedLimit, computeCardAvailableLimit, computeCardTotalLimit } from "../lib/cards.js";
import {
  classifyPersistedCardBills,
  buildCardBillManifestById,
  investigateLegacyCardBillArtifact,
  confirmCardBillUniqueConstraint,
} from "./snapshot-dry-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const PRODUCTION_DB_HOST_SUBSTRING = "ep-odd-lab-ac5srwxf-pooler"; // mesmo valor de lib/assertTestEnvironment.js — reforço explícito pra DIRECT_URL, que aquela guarda não checa.
const ASOF = new Date("2026-09-04T00:00:00.000Z"); // semântico — nunca usa o relógio real pra decisão financeira.

const DRY_RUN = process.argv.includes("--dry-run");

// Todo model financeiro EXCETO Card/CardBill — usado pra provar que nada
// além do escopo aprovado foi tocado (item 19 do pedido).
const OTHER_MODELS = [
  "account", "income", "expense", "transfer", "balanceAdjustment", "cardLimitUpdate",
  "purchase", "installment", "bill", "recurringRule", "goal", "reserve", "reserveMovement",
  "externalInstallmentPlan", "externalInstallment", "confirmedCommitment", "contingency",
  "receivable", "categoryBudget", "cardCreditMovement", "appSettings",
];

function log(...args) {
  console.log(...args);
}

// ----------------------------------------------------------------------------
// Item 1 — assertions de ambiente ADICIONAIS às de assertTestEnvironment()
// (que já checa VERCEL_ENV/DATABASE_ENV/DATABASE_URL). Aqui: DIRECT_URL e
// `prisma migrate status` limpo.
// ----------------------------------------------------------------------------
function assertExtraSafety() {
  const problems = [];
  const directUrl = process.env.DIRECT_URL || "";
  if (!directUrl) problems.push("DIRECT_URL não está setada");
  else if (directUrl.includes(PRODUCTION_DB_HOST_SUBSTRING)) problems.push(`DIRECT_URL aponta pro host de produção (contém "${PRODUCTION_DB_HOST_SUBSTRING}")`);

  let migrateStatusOutput = "";
  try {
    migrateStatusOutput = execSync("npx prisma migrate status", { cwd: REPO_ROOT, encoding: "utf8" });
    if (!migrateStatusOutput.includes("up to date")) {
      problems.push(`prisma migrate status não está clean:\n${migrateStatusOutput}`);
    }
  } catch (err) {
    problems.push(`Falha ao rodar 'npx prisma migrate status': ${err.message}`);
  }

  if (process.env.VERCEL_ENV) {
    log(`   (VERCEL_ENV=${process.env.VERCEL_ENV} — já validado por assertTestEnvironment())`);
  }

  if (problems.length > 0) {
    console.error("\n🛑 ABORTADO (assertExtraSafety) — antes de qualquer write:");
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
  }
  return { migrateStatusOutput };
}

async function fingerprintModels(models) {
  const fp = {};
  for (const m of models) {
    const rows = await prisma[m].findMany();
    fp[m] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
  }
  return fp;
}

// Validação real (item 16-17) — reutilizada tanto pra simular o resultado
// ANTES de escrever (dry-run, sobre uma cópia em memória) quanto pra
// confirmar o resultado DEPOIS de escrever (sobre o estado real pós-commit).
// As únicas duas funções que decidem "qual é a fatura atual"/"o que é
// incurred/future" são as REAIS de produção — nunca reimplementadas aqui.
function computeCardValidation(billsView) {
  const currentRelevantCycleMonth = resolveCurrentRelevantCardBillCycleMonth(billsView);
  let incurred = null;
  const future = [];
  const remainingPositive = [];
  for (const b of billsView) {
    const remaining = subtractMoney(money(b.totalAmount), money(b.paidAmount ?? 0));
    if (remaining.lte(0)) continue;
    remainingPositive.push({ cycleMonth: b.cycleMonth, remaining: remaining.toString(), closesAt: b.closesAt.toISOString() });
    const cls = classifyCardBill(b, { isCurrentRelevant: b.cycleMonth === currentRelevantCycleMonth });
    if (cls === OBLIGATION_CLASS.INCURRED_LIABILITY) incurred = { cycleMonth: b.cycleMonth, amount: remaining.toString() };
    else if (cls === OBLIGATION_CLASS.FUTURE_OBLIGATION) future.push({ cycleMonth: b.cycleMonth, amount: remaining.toString() });
  }
  remainingPositive.sort((a, b) => new Date(a.closesAt) - new Date(b.closesAt));
  const noEarlierCycleContaminates = remainingPositive.every((r) => r.cycleMonth >= "2026-09");
  return {
    currentRelevantCycleMonth,
    incurredLiability: incurred,
    futureObligations: { total: sumMoney(future.map((f) => money(f.amount))).toString(), items: future },
    remainingPositiveBillsSortedByClosesAt: remainingPositive,
    noEarlierCycleContaminates,
  };
}

function shapeBill(b) {
  return {
    id: b.id,
    cycleMonth: b.cycleMonth,
    totalAmount: b.totalAmount.toString(),
    paidAmount: b.paidAmount?.toString() ?? null,
    remainingAmount: subtractMoney(money(b.totalAmount), money(b.paidAmount ?? 0)).toString(),
    status: b.status,
    closesAt: b.closesAt.toISOString(),
    dueAt: b.dueAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

async function main() {
  log("=".repeat(78));
  log("Fase 5.1B-CARD — apply real, escopo Card+CardBill only");
  log(DRY_RUN ? "MODO: --dry-run (preflight apenas, ZERO write)" : "MODO: WRITE REAL");
  log("=".repeat(78));

  const { migrateStatusOutput } = assertExtraSafety();
  log("✅ Ambiente dev confirmado (VERCEL_ENV/DATABASE_ENV/DATABASE_URL/DIRECT_URL) + prisma migrate status clean.");

  const inputPath = path.join(HERE, "snapshot-input.local.json");
  if (!fs.existsSync(inputPath)) throw new Error(`Input não encontrado: ${inputPath}`);
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cardInput = input.card;
  if (!cardInput?.slug) throw new Error("input.card.slug ausente — nada a aplicar (escopo desta fase é só Card/CardBill).");

  const cardBefore = await prisma.card.findUnique({ where: { slug: cardInput.slug } });
  if (!cardBefore) throw new Error(`Card slug=${cardInput.slug} não encontrado no banco.`);

  const persistedBillsBefore = await prisma.cardBill.findMany({ where: { cardId: cardBefore.id }, orderBy: { cycleMonth: "asc" } });
  const uniqueConstraint = confirmCardBillUniqueConstraint();
  if (!uniqueConstraint.isCardIdCycleMonth) {
    throw new Error("confirmCardBillUniqueConstraint() não confirmou @@unique([cardId, cycleMonth]) — abortando por segurança, schema pode ter mudado.");
  }
  log(`✅ Constraint @@unique([cardId, cycleMonth]) confirmada. ${persistedBillsBefore.length} CardBills persistidas encontradas pra este cartão.`);

  // --- Deriva o apply set na hora, por execução real (nunca hardcoded) ---
  const knownBills = (cardInput.bills || []).map((b) => ({ ...b, amountMoney: money(b.amount) }));
  const knownBillsByMonth = new Map(knownBills.map((b) => [b.cycleMonth, b.amountMoney]));
  const shapedBills = persistedBillsBefore.map(shapeBill);
  const classified = classifyPersistedCardBills(shapedBills, knownBillsByMonth);
  const cardBillManifestById = buildCardBillManifestById(knownBills, classified);

  const investigations = [];
  for (const cb of cardBillManifestById) {
    if (cb.proposedAction === "DEFER_UNKNOWN" && cb.contaminationRisk) {
      investigations.push(await investigateLegacyCardBillArtifact(cardBefore, cb, { knownBillsByMonth }));
    }
  }
  const deleteApprovals = investigations.filter((inv) => inv.classification === "LEGACY_SAME_ECONOMIC_BILL" && inv.recommendedAction === "DELETE_PROVEN_ARTIFACT");
  const updateApprovals = cardBillManifestById.filter((cb) => cb.proposedAction === "UPDATE");
  const closingDayChanged = cardBefore.closingDay !== cardInput.closingDay;

  log(`\n--- Apply set derivado agora, por execução real ---`);
  log(`Card.closingDay: ${cardBefore.closingDay} -> ${cardInput.closingDay} (mudança: ${closingDayChanged})`);
  log(`DELETE aprovados (LEGACY_SAME_ECONOMIC_BILL, prova por lineage): ${deleteApprovals.map((d) => `${d.cycleMonth}(id=${d.id})`).join(", ") || "nenhum"}`);
  log(`UPDATE aprovados (valor canônico diverge do persistido): ${updateApprovals.map((u) => `${u.cycleMonth}(id=${u.id})`).join(", ") || "nenhum"}`);

  // --- Preflight — estado esperado (item 4) ---
  // Cada UPDATE/DELETE precisa ser exatamente o que o manifesto da Fase 5.1A
  // já classificou — nenhuma surpresa, nenhuma CardBill nova.
  for (const cb of [...deleteApprovals.map((d) => ({ id: d.id, cycleMonth: d.cycleMonth })), ...updateApprovals]) {
    const stillThere = persistedBillsBefore.find((b) => b.id === cb.id);
    if (!stillThere) throw new Error(`PREFLIGHT FALHOU: CardBill id=${cb.id} (${cb.cycleMonth}) não está mais no estado atual do banco — manifesto desatualizado, abortando.`);
  }
  log("✅ Preflight: todas as rows-alvo do apply set continuam presentes e correspondem ao esperado.");

  // --- Item 11 — Dezembro/Janeiro: validar que NÃO precisam de UPDATE mesmo
  // após closingDay mudar; se precisarem, reportar e NUNCA expandir o apply
  // silenciosamente. ---
  const hypotheticalCardWithNewClosingDay = { closingDay: cardInput.closingDay, dueDay: cardInput.dueDay };
  const decJanCheck = [];
  for (const b of persistedBillsBefore) {
    const isTargeted = updateApprovals.some((u) => u.id === b.id) || deleteApprovals.some((d) => d.id === b.id);
    if (isTargeted) continue;
    const hypotheticalClosesAt = getCardBillClosesAt(hypotheticalCardWithNewClosingDay, b.cycleMonth);
    const hypotheticalDueAt = getCardBillDueDate(hypotheticalCardWithNewClosingDay, b.cycleMonth);
    const metadataWouldChange = hypotheticalClosesAt.getTime() !== b.closesAt.getTime() || hypotheticalDueAt.getTime() !== b.dueAt.getTime();
    if (metadataWouldChange) {
      decJanCheck.push({
        id: b.id,
        cycleMonth: b.cycleMonth,
        currentClosesAt: b.closesAt.toISOString(),
        currentDueAt: b.dueAt.toISOString(),
        wouldBeClosesAt: hypotheticalClosesAt.toISOString(),
        wouldBeDueAt: hypotheticalDueAt.toISOString(),
      });
    }
  }
  log(`\n--- Item 11: rows FORA do apply set cujo closesAt/dueAt mudaria sob closingDay=${cardInput.closingDay} (NÃO expandido, só reportado) ---`);
  decJanCheck.forEach((c) => log(`   ${c.cycleMonth} (id=${c.id}): closesAt ${c.currentClosesAt} -> ${c.wouldBeClosesAt} | dueAt ${c.currentDueAt} -> ${c.wouldBeDueAt}`));
  if (decJanCheck.length === 0) log("   (nenhuma)");

  // --- Backup pré-write (item 3) ---
  const otherModelsFingerprintBefore = await fingerprintModels(OTHER_MODELS);
  const backup = {
    generatedAt: new Date().toISOString(),
    asOf: ASOF.toISOString(),
    mode: DRY_RUN ? "DRY_RUN" : "REAL_WRITE",
    schemaMigrateStatus: migrateStatusOutput,
    cardBefore,
    cardBillsBefore: persistedBillsBefore,
    cardBillManifestById,
    legacyCardBillInvestigations: investigations,
    decJanMetadataCheck: decJanCheck,
    deleteApprovals,
    updateApprovals,
    otherModelsFingerprintBefore,
  };
  const backupDir = path.join(HERE, "snapshot-reports");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-card-apply-${DRY_RUN ? "dryrun-" : ""}${Date.now()}.local.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  log(`\n✅ Backup pré-write salvo em: ${backupPath} (gitignored — scripts/snapshot-reports/)`);

  if (deleteApprovals.length === 0 && updateApprovals.length === 0 && !closingDayChanged) {
    log("\n✅ NO_MUTATIONS_NEEDED — nada a fazer (idempotência confirmada).");
    return { status: "NO_MUTATIONS_NEEDED", backupPath };
  }

  // Simula o resultado ANTES de escrever (SEMPRE, dry-run ou write real):
  // clona listCardBillsView (real, read-only) e aplica em memória exatamente
  // o DELETE/UPDATE que seria feito, depois roda a MESMA validação real que
  // rodaria pós-write.
  //
  // CRÍTICO (achado real, descoberto num apply que precisou de rollback):
  // deletar uma CardBill persistida NÃO remove o cycleMonth da janela de
  // scan de listCardBillsView — se esse cycleMonth ainda cai dentro de
  // monthsBack/monthsForward a partir de `now`, getCardBillView PROJETA uma
  // row virtual nova (id=null) via computeExpectedCardBillTotal, sob a
  // convenção do Card JÁ ATUALIZADO. Um mero .filter() removendo a row do
  // array simula "a row nunca existiu", não "a row foi deletada" — os dois
  // são DIFERENTES sempre que o cycleMonth deletado ainda tem evidência real
  // (Expense/Installment) que o motor recomputaria. Por isso a simulação
  // correta recomputa a PROJEÇÃO real pra cada cycleMonth deletado, com o
  // Card hipotético (closingDay novo), em vez de só remover a entrada.
  const realBillsNow = await listCardBillsView(cardBefore.id, { now: ASOF });
  const deleteIds = new Set(deleteApprovals.map((d) => d.id));
  const updateById = new Map(
    updateApprovals.map((u) => [
      u.id,
      {
        totalAmount: money(u.canonical.totalAmount),
        paidAmount: u.canonical.paidAmount != null ? money(u.canonical.paidAmount) : null,
        status: u.canonical.status,
        closesAt: getCardBillClosesAt(hypotheticalCardWithNewClosingDay, u.cycleMonth),
        dueAt: getCardBillDueDate(hypotheticalCardWithNewClosingDay, u.cycleMonth),
      },
    ])
  );
  const simulatedBillsView = await Promise.all(
    realBillsNow.map(async (b) => {
      if (updateById.has(b.id)) return { ...b, ...updateById.get(b.id) };
      if (deleteIds.has(b.id)) {
        const cardHypothetical = { ...cardBefore, closingDay: cardInput.closingDay, dueDay: cardInput.dueDay };
        const projectedTotal = await computeExpectedCardBillTotal(cardHypothetical, b.cycleMonth);
        const projectedClosesAt = getCardBillClosesAt(hypotheticalCardWithNewClosingDay, b.cycleMonth);
        const projectedDueAt = getCardBillDueDate(hypotheticalCardWithNewClosingDay, b.cycleMonth);
        return {
          id: null,
          cardId: cardBefore.id,
          cycleMonth: b.cycleMonth,
          closesAt: projectedClosesAt,
          dueAt: projectedDueAt,
          totalAmount: projectedTotal,
          paidAmount: null,
          status: projectedClosesAt < ASOF ? "closed" : "open",
          isPersisted: false,
          _projectedAfterDeleteWarning: isPositive(projectedTotal) ? `ATENÇÃO: deletar id=${b.id} NÃO elimina liability projetada aqui — recomputa ${projectedTotal.toString()} via evidência real ainda existente (Expense/Installment) sob a nova convenção.` : null,
        };
      }
      return b;
    })
  );
  const projectionWarnings = simulatedBillsView.filter((b) => b._projectedAfterDeleteWarning).map((b) => b._projectedAfterDeleteWarning);
  const simulatedValidation = computeCardValidation(simulatedBillsView);

  log("\n--- Simulação do resultado PÓS-APPLY (em memória, ANTES de qualquer write) ---");
  log(JSON.stringify(simulatedValidation, null, 2));

  // GATE DURO: se a simulação prevê contaminação (liability projetada
  // resgatando um ciclo anterior, ou currentRelevant != o esperado), ABORTA
  // ANTES da transação — dry-run ou write real, sem exceção. Nunca escreve
  // sabendo de antemão que o resultado obrigatório não vai bater.
  if (projectionWarnings.length > 0 || !simulatedValidation.noEarlierCycleContaminates) {
    log("\n🛑 GATE DE CONTAMINAÇÃO ACIONADO — simulação prevê que o resultado pós-write NÃO seria o exigido:");
    projectionWarnings.forEach((w) => log("   " + w));
    log(`   currentRelevantCycleMonth simulado: ${simulatedValidation.currentRelevantCycleMonth}`);
    log("\n   ABORTANDO antes de qualquer write. Nenhuma transação foi iniciada.");
    return { status: "ABORTED_CONTAMINATION_PREDICTED", backupPath, simulatedValidation, projectionWarnings };
  }

  if (DRY_RUN) {
    log("\n--dry-run: simulação passou no gate de contaminação. Parando aqui, nenhuma escrita será feita.");
    return {
      status: "DRY_RUN_COMPLETE",
      backupPath,
      wouldApply: { closingDayChanged, deleteApprovals: deleteApprovals.map((d) => d.id), updateApprovals: updateApprovals.map((u) => u.id) },
      simulatedValidation,
    };
  }

  // ==========================================================================
  // TRANSAÇÃO ÚNICA (item 14) — revalida, então aplica. Qualquer falha =
  // rollback total, nenhum estado parcial.
  // ==========================================================================
  log("\n--- Iniciando transação real ---");
  const txResult = await prisma.$transaction(async (tx) => {
    // 1. Revalidar rows-alvo DENTRO da transação (concorrência otimista).
    const freshCard = await tx.card.findUnique({ where: { id: cardBefore.id } });
    if (!freshCard || freshCard.updatedAt.getTime() !== cardBefore.updatedAt.getTime()) {
      throw new Error("Card mudou entre o preflight e a transação — abortando (rollback automático).");
    }
    for (const cb of [...deleteApprovals, ...updateApprovals]) {
      const fresh = await tx.cardBill.findUnique({ where: { id: cb.id } });
      const originalBefore = persistedBillsBefore.find((b) => b.id === cb.id);
      if (!fresh || fresh.updatedAt.getTime() !== originalBefore.updatedAt.getTime()) {
        throw new Error(`CardBill id=${cb.id} mudou entre o preflight e a transação — abortando (rollback automático).`);
      }
    }

    // 2. Card.closingDay
    let cardAfter = freshCard;
    if (closingDayChanged) {
      cardAfter = await tx.card.update({ where: { id: cardBefore.id }, data: { closingDay: cardInput.closingDay } });
    }

    // 3. DELETE da(s) CardBill(s) legada(s) — só a row agregada, nunca Expense/Purchase/Installment/Transfer subjacentes (não tocados nesta transação, nem existe cascade no schema).
    for (const del of deleteApprovals) {
      await tx.cardBill.delete({ where: { id: del.id } });
    }

    // 4. UPDATE das CardBills canônicas — totalAmount/paidAmount/status/closesAt/dueAt, recomputados sob o closingDay NOVO.
    const updatedBills = [];
    for (const upd of updateApprovals) {
      const newClosesAt = getCardBillClosesAt(hypotheticalCardWithNewClosingDay, upd.cycleMonth);
      const newDueAt = getCardBillDueDate(hypotheticalCardWithNewClosingDay, upd.cycleMonth);
      const after = await tx.cardBill.update({
        where: { id: upd.id },
        data: {
          totalAmount: money(upd.canonical.totalAmount),
          paidAmount: upd.canonical.paidAmount != null ? money(upd.canonical.paidAmount) : null,
          status: upd.canonical.status,
          closesAt: newClosesAt,
          dueAt: newDueAt,
        },
      });
      updatedBills.push(after);
    }

    return { cardAfter, updatedBills };
  });
  log("✅ Transação commitada com sucesso.");

  // --- Backup pós-write (before/after completo) ---
  const cardAfterFull = await prisma.card.findUnique({ where: { id: cardBefore.id } });
  const persistedBillsAfter = await prisma.cardBill.findMany({ where: { cardId: cardBefore.id }, orderBy: { cycleMonth: "asc" } });
  const otherModelsFingerprintAfter = await fingerprintModels(OTHER_MODELS);
  const otherModelsUnchanged = JSON.stringify(otherModelsFingerprintBefore) === JSON.stringify(otherModelsFingerprintAfter);

  const postWritePath = path.join(backupDir, `post-card-apply-${Date.now()}.local.json`);
  fs.writeFileSync(
    postWritePath,
    JSON.stringify({ generatedAt: new Date().toISOString(), cardAfter: cardAfterFull, cardBillsAfter: persistedBillsAfter, otherModelsFingerprintAfter, otherModelsUnchanged }, null, 2)
  );
  log(`✅ Estado pós-write salvo em: ${postWritePath}`);

  // ==========================================================================
  // VALIDAÇÃO PÓS-WRITE (item 16-17) — read-only, funções REAIS de produção.
  // ==========================================================================
  const billsView = await listCardBillsView(cardBefore.id, { now: ASOF });
  const coreValidation = computeCardValidation(billsView);

  const usedLimitReal = await computeCardUsedLimit(cardBefore.id);
  const totalLimitReal = await computeCardTotalLimit(cardBefore.id);
  const availableLimitReal = await computeCardAvailableLimit(cardBefore.id);
  const checksumFromCanonicalBills = sumMoney((cardInput.bills || []).filter((b) => b.status !== "PAID").map((b) => money(b.amount)));

  const validation = {
    ...coreValidation,
    usedLimit_viaCanonicalBillsChecksum: checksumFromCanonicalBills.toString(),
    usedLimit_viaComputeCardUsedLimit_REAL_PRODUCTION_FUNCTION: usedLimitReal.toString(),
    totalLimit: totalLimitReal.toString(),
    availableLimit_viaComputeCardAvailableLimit: availableLimitReal.toString(),
    IMPORTANT_DISCREPANCY_FOUND:
      compareMoney(usedLimitReal, checksumFromCanonicalBills) !== 0
        ? "computeCardUsedLimit() (função REAL de produção) NÃO bate com o checksum canônico baseado em CardBill — são fórmulas INDEPENDENTES (uma usa CardLimitUpdate+Expense+Purchase+pagamentos; outra usa CardBill). CardLimitUpdate está FORA DE ESCOPO desta fase (\"qualquer outro model fora de Card e CardBill\") — esta divergência é um achado novo, não corrigido aqui, requer uma fase futura dedicada ao anchor de limite do cartão."
        : "Ambas as fórmulas coincidem.",
    otherModelsUnchanged,
  };

  log("\n--- Validação pós-write (execução real) ---");
  log(JSON.stringify(validation, null, 2));

  return { status: "APPLIED", backupPath, postWritePath, cardBefore, cardAfter: cardAfterFull, cardBillsBefore: persistedBillsBefore, cardBillsAfter: persistedBillsAfter, deleteApprovals, updateApprovals, validation };
}

main()
  .then((result) => {
    console.log("\n" + "=".repeat(78));
    console.log("RESULTADO:", result.status);
    console.log("=".repeat(78));
  })
  .catch((err) => {
    console.error("\n💥 ERRO — nenhuma escrita parcial deve persistir (transação, se iniciada, foi revertida automaticamente):");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
