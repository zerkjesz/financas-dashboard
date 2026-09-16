// Fase 7.0.1, item 5 — hardening de isolamento de teste. A Fase 7.0 vazou
// dado real pro DEV (Expenses stray + CardBill.paidAmount alterado) porque o
// cleanup de um teste capturou a fatura ERRADA pra restaurar. Este script
// prova, de forma automatizada e repetível, que isso não acontece mais:
//
//   1. Tira um snapshot AMPLO do estado do banco (não só dos ids que EU acho
//      que criei — todo CardBill de todo cartão, todas as contagens
//      relevantes).
//   2. Roda o BUNDLE inteiro de testes Fase 7.0/7.0.1 (scripts/test-telegram-ai-*.mjs,
//      exceto este próprio arquivo).
//   3. Tira o snapshot de novo, compara byte a byte com o de antes.
//   4. Repete os passos 1-3 MAIS UMA VEZ (dupla execução consecutiva) e prova
//      que os resultados (pass/fail de cada arquivo) são idênticos nas duas
//      rodadas.
//
//   node scripts/test-telegram-ai-isolation.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THIS_FILE = path.basename(fileURLToPath(import.meta.url));

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

// Snapshot AMPLO — nunca restrito aos ids que um teste específico "acha" que
// tocou (foi exatamente essa suposição que causou o vazamento na Fase 7.0).
async function snapshotDevState() {
  const [
    expenseCount,
    incomeCount,
    transferCount,
    purchaseCount,
    installmentCount,
    balanceAdjustmentCount,
    cardBillReconciliationCount,
    pendingBotMessageCount,
    telegramCorrectionAuditCount,
    telegramUpdateReceiptCount,
    confirmedCommitmentCount,
    contingencyCount,
    receivableCount,
    accountCount,
    cardCount,
    allCardBills,
  ] = await Promise.all([
    prisma.expense.count(),
    prisma.income.count(),
    prisma.transfer.count(),
    prisma.purchase.count(),
    prisma.installment.count(),
    prisma.balanceAdjustment.count(),
    prisma.cardBillReconciliation.count(),
    prisma.pendingBotMessage.count(),
    prisma.telegramCorrectionAudit.count(),
    prisma.telegramUpdateReceipt.count(),
    prisma.confirmedCommitment.count(),
    prisma.contingency.count(),
    prisma.receivable.count(),
    prisma.account.count(),
    prisma.card.count(),
    prisma.cardBill.findMany({ select: { id: true, cardId: true, cycleMonth: true, totalAmount: true, paidAmount: true, status: true, paidAt: true }, orderBy: { id: "asc" } }),
  ]);

  return {
    counts: { expenseCount, incomeCount, transferCount, purchaseCount, installmentCount, balanceAdjustmentCount, cardBillReconciliationCount, pendingBotMessageCount, telegramCorrectionAuditCount, telegramUpdateReceiptCount, confirmedCommitmentCount, contingencyCount, receivableCount, accountCount, cardCount },
    // Serializado pra comparação determinística (Decimal/Date -> string).
    cardBills: JSON.parse(JSON.stringify(allCardBills, (_k, v) => (v && typeof v.toFixed === "function" ? v.toString() : v))),
  };
}

function diffSnapshots(before, after) {
  const diffs = [];
  for (const key of Object.keys(before.counts)) {
    if (before.counts[key] !== after.counts[key]) diffs.push(`${key}: ${before.counts[key]} -> ${after.counts[key]}`);
  }
  if (before.cardBills.length !== after.cardBills.length) {
    diffs.push(`número de CardBill mudou: ${before.cardBills.length} -> ${after.cardBills.length}`);
  } else {
    for (let i = 0; i < before.cardBills.length; i++) {
      const b = before.cardBills[i];
      const a = after.cardBills.find((x) => x.id === b.id);
      if (!a) {
        diffs.push(`CardBill ${b.id} sumiu`);
        continue;
      }
      for (const field of ["totalAmount", "paidAmount", "status", "paidAt"]) {
        if (b[field] !== a[field]) diffs.push(`CardBill ${b.id} (${b.cardId}/${b.cycleMonth}).${field}: ${b[field]} -> ${a[field]}`);
      }
    }
  }
  return diffs;
}

function listAiTestFiles() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => /^test-telegram-ai-.*\.mjs$/.test(f) && f !== THIS_FILE)
    .sort();
}

function runBundle(files) {
  const results = [];
  for (const f of files) {
    let code = 0,
      tail = "";
    try {
      const out = execFileSync("node", [path.join("scripts", f)], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env },
      });
      tail = out.trim().split("\n").slice(-1)[0];
    } catch (e) {
      code = e.status ?? (e.killed ? 124 : 1);
      tail = ((e.stdout || "") + "\n" + (e.stderr || "")).trim().split("\n").slice(-3).join(" | ");
    }
    results.push({ file: f, code, tail });
  }
  return results;
}

async function runOneRound(roundLabel, files) {
  const before = await snapshotDevState();
  const results = runBundle(files);
  const after = await snapshotDevState();
  const driftDiffs = diffSnapshots(before, after);

  console.log(`\n--- ${roundLabel}: resultado por arquivo ---`);
  for (const r of results) console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.file}  ${r.code !== 0 ? "exit=" + r.code + " " + r.tail : ""}`);

  check(`[${roundLabel}] todos os ${files.length} arquivos do bundle passaram`, results.every((r) => r.code === 0), JSON.stringify(results.filter((r) => r.code !== 0)));
  check(`[${roundLabel}] ZERO drift no estado do DEV depois do bundle inteiro (nenhuma linha vazada, nenhum CardBill.paidAmount alterado)`, driftDiffs.length === 0, JSON.stringify(driftDiffs));

  return { results, driftDiffs };
}

async function main() {
  const files = listAiTestFiles();
  check("[setup] encontrou os arquivos de teste Fase 7.0/7.0.1", files.length >= 7, JSON.stringify(files));
  console.log(`Bundle (${files.length} arquivos): ${files.join(", ")}\n`);

  const round1 = await runOneRound("RODADA 1", files);
  const round2 = await runOneRound("RODADA 2 (consecutiva, mesmo estado inicial que a rodada 1 deixou)", files);

  // Dupla execução consecutiva precisa dar o MESMO resultado por arquivo nas
  // duas rodadas (nenhum teste depende de estado deixado por uma rodada
  // anterior pra passar, nem quebra por causa dele).
  const sameOutcome = round1.results.every((r, i) => r.code === round2.results[i].code && r.file === round2.results[i].file);
  check("[double-run] mesmos resultados (pass/fail) nas duas rodadas consecutivas", sameOutcome, JSON.stringify({ round1: round1.results.map((r) => [r.file, r.code]), round2: round2.results.map((r) => [r.file, r.code]) }));

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("ERRO INESPERADO:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
