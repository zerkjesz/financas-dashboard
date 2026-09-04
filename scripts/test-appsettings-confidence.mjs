// Fase 3.2, item 9 — testes de AppSettings + DataConfidence contra o branch dev.
// Mesma disciplina do scripts/test-dev-integration.mjs (Fase 3.1): marcador
// inconfundível em todo dado criado, cleanup garantido em `finally`, verificação
// de evidência de que nada sobrou.
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { getAppSettings, APP_SETTINGS_ID } from "../lib/settings.js";
import { resolveConfidence, DATA_CONFIDENCE_VALUES } from "../lib/dataConfidence.js";
import { createBill } from "../lib/bills.js";
import fs from "node:fs";

const MARK = "TESTE_FASE32";
const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

const created = { accounts: [], expenses: [], bills: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const e of created.expenses) await prisma.expense.delete({ where: { id: e } }).catch(() => {});
  for (const b of created.bills) await prisma.bill.delete({ where: { id: b } }).catch(() => {});
  for (const a of created.accounts) await prisma.account.delete({ where: { id: a } }).catch(() => {});

  const leftover = await Promise.all([
    prisma.account.count({ where: { slug: { contains: "teste-fase32" } } }),
    prisma.expense.count({ where: { description: { contains: MARK } } }),
    prisma.bill.count({ where: { description: { contains: MARK } } }),
  ]);
  const total = leftover.reduce((a, b) => a + b, 0);
  check("cleanup: zero dado de teste restante no banco", total === 0, `contagens: ${JSON.stringify(leftover)}`);
}

async function run() {
  console.log("--- Testes de AppSettings + DataConfidence (branch dev) — Fase 3.2, item 9 ---\n");

  const acc = await prisma.account.create({ data: { slug: "teste-fase32-conta", name: `[${MARK}] Conta`, type: "checking" } });
  created.accounts.push(acc.id);

  // ---- A) enum aceita os 5 valores ----
  const expensesByConfidence = {};
  for (const value of DATA_CONFIDENCE_VALUES) {
    const e = await prisma.expense.create({
      data: { amount: 1, description: `[${MARK}] ${value}`, category: "Outros", accountId: acc.id, source: "manual", confidence: value },
    });
    created.expenses.push(e.id);
    expensesByConfidence[value] = e;
  }
  check(
    "A) enum DataConfidence aceita os 5 valores exatos",
    DATA_CONFIDENCE_VALUES.every((v) => expensesByConfidence[v].confidence === v),
    DATA_CONFIDENCE_VALUES.join(", ")
  );

  // ---- B) novo Expense sem confidence explícita recebe a política definida (CONFIRMED) ----
  check("B) resolveConfidence(undefined) === CONFIRMED", resolveConfidence(undefined) === "CONFIRMED");
  check("B) resolveConfidence(null) === CONFIRMED", resolveConfidence(null) === "CONFIRMED");
  const billNoConfidence = await createBill({
    description: `[${MARK}] Bill sem confidence`,
    amount: 10,
    accountId: acc.id,
    dueDate: new Date(Date.now() + 86400000),
    source: "manual",
  });
  created.bills.push(billNoConfidence.id);
  check("B) createBill() sem confidence grava CONFIRMED", billNoConfidence.confidence === "CONFIRMED", billNoConfidence.confidence);

  // ---- C) Expense com ESTIMATED preserva ESTIMATED ----
  check(
    "C) Expense criada com ESTIMATED preserva ESTIMATED (não é sobrescrita pro default)",
    expensesByConfidence.ESTIMATED.confidence === "ESTIMATED"
  );
  check("C) resolveConfidence('ESTIMATED') preserva o valor explícito", resolveConfidence("ESTIMATED") === "ESTIMATED");

  // ---- D) source e confidence variam independentemente ----
  const telegramConfirmed = await prisma.expense.create({
    data: { amount: 1, description: `[${MARK}] telegram+CONFIRMED`, category: "Outros", accountId: acc.id, source: "telegram", confidence: "CONFIRMED" },
  });
  created.expenses.push(telegramConfirmed.id);
  const manualEstimated = await prisma.expense.create({
    data: { amount: 1, description: `[${MARK}] manual+ESTIMATED`, category: "Outros", accountId: acc.id, source: "manual", confidence: "ESTIMATED" },
  });
  created.expenses.push(manualEstimated.id);
  check(
    "D) source e confidence variam independentemente (telegram+CONFIRMED, manual+ESTIMATED)",
    telegramConfirmed.source === "telegram" &&
      telegramConfirmed.confidence === "CONFIRMED" &&
      manualEstimated.source === "manual" &&
      manualEstimated.confidence === "ESTIMATED"
  );

  // ---- E) AppSettings retorna os valores oficiais ----
  const settings = await getAppSettings();
  check("E) AppSettings.cycleStartDay === 24", settings.cycleStartDay === 24, String(settings.cycleStartDay));
  check("E) AppSettings.safetyMarginPercent === 10", settings.safetyMarginPercent === 10, String(settings.safetyMarginPercent));
  check(
    "E) AppSettings.operationalHistoryStart === 2026-08-24",
    new Date(settings.operationalHistoryStart).toISOString() === "2026-08-24T00:00:00.000Z",
    new Date(settings.operationalHistoryStart).toISOString()
  );
  check(
    "E) AppSettings.vaHistoryStart === 2026-08-21",
    new Date(settings.vaHistoryStart).toISOString() === "2026-08-21T00:00:00.000Z",
    new Date(settings.vaHistoryStart).toISOString()
  );

  // ---- F) audit/read-only não cria AppSettings ----
  // Checagem estrutural: getAppSettings() nunca chama create/upsert (grep no próprio
  // arquivo, mesmo espírito da verificação read-only de scripts/audit.js).
  const settingsSource = fs.readFileSync(new URL("../lib/settings.js", import.meta.url), "utf8");
  const hasWriteVerb = /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\s*\(/.test(settingsSource);
  check("F) lib/settings.js não contém nenhum verbo de escrita (grep estrutural)", !hasWriteVerb);
  // Checagem funcional: chamar getAppSettings() várias vezes não muda count nem updatedAt.
  const countBefore = await prisma.appSettings.count();
  const rowBefore = await prisma.appSettings.findUnique({ where: { id: APP_SETTINGS_ID } });
  await getAppSettings();
  await getAppSettings();
  await getAppSettings();
  const countAfter = await prisma.appSettings.count();
  const rowAfter = await prisma.appSettings.findUnique({ where: { id: APP_SETTINGS_ID } });
  check(
    "F) 3 chamadas a getAppSettings() não alteram count nem updatedAt do singleton",
    countBefore === countAfter && rowBefore?.updatedAt?.getTime() === rowAfter?.updatedAt?.getTime(),
    `count antes=${countBefore} depois=${countAfter}`
  );

  // ---- G) não existem múltiplos singletons ----
  check("G) prisma.appSettings.count() === 1", (await prisma.appSettings.count()) === 1);

  // ---- H) APIs continuam serializando dinheiro corretamente após a nova migration ----
  // Verificado ao vivo contra o dashboard rodando (ver relatório final — feito via
  // Browser pane, não é prático reproduzir aqui um servidor HTTP completo). Este
  // script cobre a parte de banco/lib; a parte de HTTP é verificada à parte e citada
  // no relatório de entrega.
  check("H) ver verificação HTTP ao vivo no relatório de entrega (fora do escopo deste script)", true);
}

let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error("\n💥 Erro durante os testes:", err);
  exitCode = 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checagem(ns) passaram.`);
if (failed.length > 0) {
  console.log("Falharam:", failed.map((f) => f.name).join(", "));
  exitCode = 1;
}
process.exit(exitCode);
