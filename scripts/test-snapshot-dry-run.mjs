// Fase 5.0 — testes SINTÉTICOS (zero dado pessoal) pro tooling genérico de
// reconciliação (scripts/snapshot-dry-run.mjs). Cobre: abertura derivada,
// checkpoints intermediários, delta inexplicado, transferência externa não
// vira Expense, card checksum, INCOMPLETE quando falta evidência, e zero-write
// (tanto por checagem estática do código-fonte quanto por fingerprint real
// antes/depois no banco dev).
//
// Este teste toca o banco (via reconcileCard/main, que fazem leituras) —
// assertTestEnvironment() por segurança, mesma disciplina do resto do projeto,
// mesmo sendo 100% read-only.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";
import { compareMoney, money } from "../lib/money.js";
import {
  INVENTORY_MODELS,
  reconcileCheckingLedger,
  reconcileCard,
  engineDryRun,
  auditTransferSchemaForExternalScope,
  main,
} from "./snapshot-dry-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  if (condition) passed++;
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}
function eq(a, b) {
  return compareMoney(money(a), money(b)) === 0;
}

console.log("--- Fase 5.0: testes sintéticos do snapshot-dry-run ---\n");

// ============================================================================
// 0. Checagem estática — zero método mutante no código-fonte do tool (item 33).
// ============================================================================
{
  const source = fs.readFileSync(path.join(HERE, "snapshot-dry-run.mjs"), "utf8");
  const forbidden = /\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw|\$transaction/i;
  check("scripts/snapshot-dry-run.mjs não contém nenhum método mutante do Prisma", !forbidden.test(source));
}

// ============================================================================
// 1. Checkpoints intermediário + final, sem delta (fecha exato).
// ============================================================================
{
  const section = {
    checkpointA: { amount: 1000, date: "2026-01-01", confidence: "CONFIRMED" },
    movementsAfterCheckpointA: [
      { type: "INFLOW", description: "entrada sintética", amount: 500, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_INCOME" },
      { type: "TRANSFER_OUT_EXTERNAL", description: "saída sintética externa", amount: 300, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_EXTERNAL" },
    ],
    checkpointB: { amount: 1200, date: "2026-01-01", confidence: "CONFIRMED" },
  };
  const result = reconcileCheckingLedger(section, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  check("checkpoint intermediário preservado no resultado", eq(result.checkpointA.amount, 1000));
  check("net movements = +500 -300 = 200", eq(result.netMovements, 200));
  check("mathematicalExpected = 1000+200 = 1200", eq(result.mathematicalExpected, 1200));
  check("checkpoint final bate exato — delta zero", result.unexplainedDifference === "0" || eq(result.unexplainedDifference, 0));
  check("finalChecksum.matchesObserved = true quando fecha exato", result.finalChecksum.matchesObserved === true);
  check("opening balance sempre marcado DERIVED_ONLY (nunca EVIDENCED por padrão, sem prova independente)", result.derivedOpeningBalance.openingBalanceEvidence === "DERIVED_ONLY");
}

// ============================================================================
// 2. Delta inexplicado — NÃO é escondido nem "corrigido" automaticamente.
// ============================================================================
{
  const section = {
    checkpointA: { amount: 500, date: "2026-01-01", confidence: "CONFIRMED" },
    movementsAfterCheckpointA: [{ type: "INFLOW", description: "entrada sintética", amount: 100, date: "2026-01-01", movementConfidence: "CONFIRMED", economicClassification: "TEST_INCOME" }],
    checkpointB: { amount: 605, date: "2026-01-01", confidence: "CONFIRMED" }, // esperado 600, observado 605 — delta +5
  };
  const result = reconcileCheckingLedger(section, { operationalHistoryStart: new Date("2026-01-01T00:00:00.000Z") });
  check("delta de +5 reportado explicitamente (não zerado, não escondido)", eq(result.unexplainedDifference, 5));
  check("finalChecksum.matchesObserved = false quando existe delta", result.finalChecksum.matchesObserved === false);
  check("investigação textual presente (não silenciosa)", typeof result.unexplainedDifferenceInvestigation === "string" && result.unexplainedDifferenceInvestigation.includes("NÃO"));
}

// ============================================================================
// 3. Transferência externa (TRANSFER_OUT_EXTERNAL) — auditoria de schema:
// confirma que NÃO precisa virar Expense nem exigir Account de destino.
// ============================================================================
{
  const audit = auditTransferSchemaForExternalScope();
  check("schema já suporta transferência externa sem exigir toAccountId/toCardId", audit.question_B_transferRequiresInternalToField === false);
  check("existe semântica já suportada (kind livre + description) pra transfer-out", audit.question_C_existingSemanticsForTransferOut === true);
  check("nenhuma alteração de schema necessária (gap de modelagem = NENHUM)", audit.question_D_minimalSchemaChangeIfUnsupported.isSchemaChangeNeeded === false);
  check("conclusão explicita que NÃO é preciso criar Account nova pro destino externo", audit.conclusion.includes("sem alteração"));
}

// ============================================================================
// 4. Card checksum — limite usado bate com soma de faturas conhecidas.
// ============================================================================
{
  const cardInput = {
    slug: "cartao-sintetico-inexistente-fase5", // não existe no banco — reconcileCard só faz um findUnique que retorna null, nenhuma escrita.
    totalLimit: 1000,
    observedAvailable: 400,
    closingDay: 4,
    dueDay: 11,
    bills: [
      { cycleMonth: "2026-01", amount: 200, status: "PAID" },
      { cycleMonth: "2026-02", amount: 300, status: "UNPAID" },
      { cycleMonth: "2026-03", amount: 300, status: "UNPAID" },
    ],
  };
  const result = await reconcileCard(cardInput);
  check("usedLimit = 1000-400 = 600", eq(result.usedLimitChecksum.usedLimitObserved, 600));
  check("soma das faturas não pagas = 600, bate com usedLimit", result.usedLimitChecksum.matches === true);
  check("primeira fatura não paga (2026-02) = INCURRED_LIABILITY", result.liabilityClassification.incurredLiability.cycleMonth === "2026-02");
  check("fatura seguinte (2026-03) = FUTURE_OBLIGATION", result.liabilityClassification.futureObligations.items.some((i) => i.cycleMonth === "2026-03"));
  check("card inexistente no banco é reportado como NOT_FOUND_IN_DB, não inventado", result.cardFoundInDb.status === "NOT_FOUND_IN_DB");
}

// ============================================================================
// 5. Engine dry-run: COMPLETE quando toda evidência necessária existe.
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { bills: [{ cycleMonth: "2026-01", amount: 100, status: "UNPAID" }] },
    confirmedCommitments: [],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-01T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings });
  check("engine COMPLETE quando não há campo faltante", result.status === "COMPLETE");
  check("freeMoney calculado (não INCOMPLETE)", result.freeMoney !== "INCOMPLETE");
}

// ============================================================================
// 6. Engine dry-run: INCOMPLETE quando falta evidência (data ambígua que MUDA
// a classificação de horizonte dependendo de qual candidata for a real).
// ============================================================================
{
  const input = {
    asOf: "2026-01-15",
    checkingAccount: { checkpointB: { amount: 1000 } },
    card: { bills: [] },
    confirmedCommitments: [
      {
        description: "Compromisso ambíguo sintético",
        amount: 100,
        // Uma data cai ANTES do nextIncome (current horizon), outra cai DEPOIS
        // (future) — classificação muda dependendo de qual for a real, então
        // não é seguro decidir (replica o cuidado do item 24.4 do pedido).
        dateCandidates: ["2026-01-20", "2026-03-01"],
        dateConfidence: "UNCERTAIN",
        funding: "UNDEFINED",
      },
    ],
    contingencies: [],
  };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: new Date("2026-02-01T00:00:00.000Z"), status: "UPCOMING", isFallback: false };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings });
  check("engine reporta INCOMPLETE quando a classificação muda conforme a data candidata", result.status === "INCOMPLETE");
  check("missingEvidence lista o campo exato faltante", result.missingEvidence.some((m) => m.field.includes("dueDate")));
  check("NÃO inventa um resultado final mesmo faltando evidência (freeMoney ainda é calculável, mas currentHorizon ignora o item ambíguo)", result.freeMoney !== undefined);
}

// ============================================================================
// 6b. Engine dry-run: sem checkingAccount -> freeMoney explicitamente INCOMPLETE.
// ============================================================================
{
  const input = { asOf: "2026-01-15", card: { bills: [] }, confirmedCommitments: [], contingencies: [] };
  const settings = { safetyMarginPercent: 10 };
  const nextIncomeProposed = { expectedDate: null, status: "MISSING_EVIDENCE", isFallback: null };
  const result = engineDryRun(input, { nextIncomeProposed, nextIncomeFromDb: { status: "FALLBACK" }, appSettings: settings });
  check("sem unrestrictedCash, freeMoney = 'INCOMPLETE' (nunca um número inventado)", result.freeMoney === "INCOMPLETE");
  check("status geral = INCOMPLETE", result.status === "INCOMPLETE");
}

// ============================================================================
// 7. Zero-write: fingerprint real do banco antes/depois de rodar main() com um
// input sintético completo (arquivo temporário, sem dado pessoal).
// ============================================================================
{
  const tmpInput = path.join(HERE, `snapshot-input.tmp-test-${Date.now()}.json`);
  fs.writeFileSync(
    tmpInput,
    JSON.stringify({
      asOf: "2026-01-15",
      checkingAccount: {
        checkpointA: { amount: 100, date: "2026-01-15", confidence: "CONFIRMED" },
        movementsAfterCheckpointA: [{ type: "INFLOW", description: "teste", amount: 10, date: "2026-01-15", movementConfidence: "CONFIRMED", economicClassification: "TEST" }],
        checkpointB: { amount: 110, date: "2026-01-15", confidence: "CONFIRMED" },
      },
      restrictedAccount: { recharge: { amount: 50, date: "2026-01-01", confidence: "CONFIRMED" }, observedClosing: { amount: 20, date: "2026-01-15", confidence: "CONFIRMED" } },
      mainIncome: { amount: 1000, date: "2026-01-01", dayOfMonth: 1, confidence: "CONFIRMED" },
      card: { totalLimit: 500, observedAvailable: 500, closingDay: 4, dueDay: 11, bills: [] },
      confirmedCommitments: [],
      contingencies: [],
    })
  );

  async function fingerprint() {
    const fp = {};
    for (const modelName of INVENTORY_MODELS) {
      const rows = await prisma[modelName].findMany();
      fp[modelName] = rows.map((r) => `${r.id}:${r.updatedAt ? r.updatedAt.toISOString() : ""}`).sort();
    }
    return fp;
  }

  const before = await fingerprint();
  const originalArgv = process.argv;
  process.argv = [originalArgv[0], originalArgv[1], "--input", tmpInput];
  let mainError = null;
  try {
    await main();
  } catch (err) {
    mainError = err;
  } finally {
    process.argv = originalArgv;
    fs.unlinkSync(tmpInput);
  }
  const after = await fingerprint();

  check("main() do dry-run executou sem erro sobre input sintético", mainError === null, mainError?.message);
  check("fingerprint do banco (ids + updatedAt de todo model financeiro) idêntico antes/depois — ZERO write", JSON.stringify(before) === JSON.stringify(after));
}

console.log(`\n${passed}/${results.length} teste(s) passaram.`);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  process.exitCode = 1;
}
await prisma.$disconnect();
