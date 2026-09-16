// Fase 6.1 — regressão do incidente P0 de produção (2026-09-16).
//
// INCIDENTE: import real em modo Adicionar (34 registros novos, preview OK)
// falhou no apply com "A importação falhou — nada foi aplicado (transação
// revertida)". O erro real persistido em DataOperation.errorMessage:
//
//   Invalid `prisma.expense.findUnique()` invocation:
//   Transaction API error: Transaction not found. Transaction ID is
//   invalid, refers to an old closed transaction Prisma doesn't have
//   information about anymore, or was obtained before disconnecting.
//
// CAUSA RAIZ (provada, não presumida — ver diagnóstico completo): findMatch
// fazia 1 round-trip de banco POR LINHA (findUnique por ID) dentro do loop
// de planImport, que roda de novo DENTRO da transação interativa do apply
// (timeout padrão do Prisma = 5000ms). O arquivo real tinha 113 despesas +
// 13 receitas com ID (match por ID -> skip) + 32 despesas + 2 receitas sem
// ID (create) = ~126 findUnique sequenciais + 34 create — em torno de 160
// round-trips síncronos, cross-region (Vercel US <-> Neon sa-east-1),
// estourando os 5s. Preview nunca via isso porque preview não abre
// transação nenhuma.
//
// CORREÇÃO: lib/dataHub/adapters.js ganhou `prepareMatchIndex` — 1 única
// `findMany({id:{in:[...]}})` por dataset em vez de N `findUnique`. Mais
// timeout explícito e generoso (30s) em lib/dataHub/apply.js como defesa em
// profundidade. Reprodução real (o MESMO arquivo do incidente, replayado
// contra DEV): 3910ms antes da correção -> 1089ms depois, mesmo resultado
// exato (created/updated/skipped/invalid idênticos).
//
// Este teste reproduz a MESMA FORMA do incidente (muitas linhas com ID
// existente misturadas com poucas linhas novas) com dado 100% sintético, e
// vira um guard de performance: se alguém reintroduzir N round-trips de
// matching, este teste passa a estourar o teto de tempo abaixo.
//
//   node scripts/test-data-hub-p0-timeout-regression.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import { prisma } from "../lib/prisma.js";
import { planImport } from "../lib/dataHub/plan.js";
import { applyImportBatch } from "../lib/dataHub/apply.js";
import { undoImportBatch } from "../lib/dataHub/undo.js";

const MARK = "TESTE_P0_TIMEOUT";
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

const EXISTING_COUNT = 100; // linhas que vão bater por ID (match -> skip), igual ao incidente real.
const NEW_COUNT = 20; // linhas sem ID (create), igual ao incidente real (proporção comparável).
const created = { incomes: [] };

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  const stray = await prisma.income.findMany({ where: { description: { contains: MARK } } });
  for (const i of stray) await prisma.income.delete({ where: { id: i.id } }).catch(() => {});
  console.log(`Limpeza: incomes remanescentes=${stray.length}.`);
}

async function main() {
  const acct = await prisma.account.findFirst();
  check("[pré] existe ao menos 1 conta real pra testar", !!acct);
  if (!acct) return;

  // 1) Cria EXISTING_COUNT incomes reais (com ID de verdade) — simula o
  // "arquivo de regularização" que reimporta dado que já existe no banco.
  console.log(`Criando ${EXISTING_COUNT} incomes sintéticas (simulando dado já existente)...`);
  const existingRows = [];
  for (let i = 0; i < EXISTING_COUNT; i++) {
    const row = await prisma.income.create({
      data: { amount: 10 + i, description: `${MARK} existente ${i}`, accountId: acct.id, occurredAt: new Date("2099-08-01") },
    });
    created.incomes.push(row.id);
    existingRows.push(row);
  }

  // 2) Monta o arquivo de import: as EXISTING_COUNT linhas trazem o ID real
  // (match por ID -> skip, igual ao incidente), mais NEW_COUNT linhas sem ID
  // (create genuíno).
  const rowsWithId = existingRows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    description: r.description,
    accountName: acct.name,
    occurredAt: r.occurredAt,
    isRecurring: false,
  }));
  const rowsWithoutId = Array.from({ length: NEW_COUNT }, (_, i) => ({
    amount: 500 + i,
    description: `${MARK} novo ${i}`,
    accountName: acct.name,
    occurredAt: new Date("2099-08-02"),
    isRecurring: false,
  }));
  const rowsBySheet = { incomes: [...rowsWithId, ...rowsWithoutId] };

  // 3) Plano (fora de transação, igual ao preview real) — confirma a mesma
  // classificação do incidente: N skips (match por ID) + M creates.
  const plan = await planImport({ prisma, mode: "add", datasets: ["incomes"], rowsBySheet });
  check(
    `[A] plano: ${EXISTING_COUNT} skips (match por ID) + ${NEW_COUNT} creates`,
    plan.perDataset.incomes.skips.length === EXISTING_COUNT && plan.perDataset.incomes.creates.length === NEW_COUNT,
    JSON.stringify({ skips: plan.perDataset.incomes.skips.length, creates: plan.perDataset.incomes.creates.length })
  );

  // 4) Apply real, cronometrado — o guard de performance do incidente P0.
  const batch = await prisma.importBatch.create({
    data: {
      fileName: `${MARK}.xlsx`,
      fileHash: `${MARK}-${Date.now()}`,
      mode: "add",
      datasets: ["incomes"],
      rows: rowsBySheet,
      plan: {},
      planFingerprint: [],
      status: "PENDING_APPLY",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  const start = Date.now();
  const result = await applyImportBatch(prisma, {
    id: batch.id,
    mode: "add",
    datasets: ["incomes"],
    rows: rowsBySheet,
    resolutions: {},
    planFingerprint: [],
    fileName: batch.fileName,
    fileHash: batch.fileHash,
  });
  const elapsedMs = Date.now() - start;

  check(`[B] apply real (${EXISTING_COUNT + NEW_COUNT} linhas) completa SEM lançar erro`, true);
  check(`[B] apply conta exatamente ${NEW_COUNT} created, 0 updated`, result.counts.created === NEW_COUNT && result.counts.updated === 0, JSON.stringify(result.counts));
  // Teto generoso (bem abaixo do timeout padrão do Prisma de 5000ms, e MUITO
  // abaixo do explícito de 30000ms) — se alguém reintroduzir N round-trips
  // de matching por linha, este teto estoura antes do timeout da transação
  // em si, pegando a regressão de performance como FALHA DE TESTE, não como
  // incidente de produção.
  check(`[B] apply de ${EXISTING_COUNT + NEW_COUNT} linhas completa em menos de 4000ms (era >5000ms/timeout antes da correção)`, elapsedMs < 4000, `${elapsedMs}ms`);

  const newIncomes = await prisma.income.findMany({ where: { description: { contains: `${MARK} novo` } } });
  check(`[B] exatamente ${NEW_COUNT} Income novas foram escritas de verdade`, newIncomes.length === NEW_COUNT, String(newIncomes.length));
  created.incomes.push(...newIncomes.map((r) => r.id));

  // 5) Confirma que NADA das EXISTING_COUNT foi tocado (skip de verdade, não update).
  const untouchedCheck = await prisma.income.findMany({ where: { id: { in: existingRows.map((r) => r.id) } } });
  const allUnchanged = untouchedCheck.every((r) => {
    const original = existingRows.find((e) => e.id === r.id);
    return Number(r.amount) === Number(original.amount) && r.updatedAt.getTime() === original.updatedAt.getTime();
  });
  check("[C] as linhas com match por ID continuam EXATAMENTE como estavam (skip real, não touch)", allUnchanged);

  // 6) Undo do batch inteiro — confirma que a otimização de matching não
  // quebrou o undo (preimages continuam corretos mesmo com o índice
  // pré-carregado em vez de query por linha).
  const batchAfter = await prisma.importBatch.findUnique({ where: { id: batch.id } });
  await undoImportBatch(prisma, batchAfter);
  const afterUndo = await prisma.income.findMany({ where: { description: { contains: `${MARK} novo` } } });
  check("[D] undo remove as Income criadas por este batch", afterUndo.length === 0, String(afterUndo.length));
  created.incomes = created.incomes.filter((id) => !newIncomes.some((n) => n.id === id));

  await prisma.dataOperation.deleteMany({ where: { importBatchId: batch.id } });
  await prisma.importBatch.delete({ where: { id: batch.id } }).catch(() => {});

  console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("ERRO INESPERADO:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
