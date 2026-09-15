// Fase 6.0.1 (Data Hub Integrity Closure) — fecha os gaps encontrados na
// revisão da Fase 6.0: atomicidade real do apply (mutação + status +
// auditoria numa ÚNICA transação), idempotência independente do audit log,
// guard de concorrência no undo, undo de UPDATE/SUBSTITUIR com verificação
// de campo a campo, e prova explícita de AuthZ/CSRF nos endpoints do Data
// Hub via HTTP real contra o dev server.
//
// Precisa do dev server rodando em BASE_URL (default http://localhost:3001)
// — as seções de AuthZ/CSRF/idempotência/stale-guard/XLSX exercitam as rotas
// de verdade (cookies, headers, middleware), não só as libs.
//
//   node scripts/test-data-hub-integrity.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { applyImportBatch, StaleImportError } from "../lib/dataHub/apply.js";
import { undoImportBatch, UndoStaleStateError } from "../lib/dataHub/undo.js";

const BASE_URL = process.env.SECURITY_TEST_BASE_URL || "http://localhost:3001";
const DEV_TEST_PASSWORD = "norte-dev-only-password"; // fixture de dev, ver scripts/test-security-integration.mjs.
const MARK = "TESTE_DATAHUB_INTEGRITY";

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

const created = { incomes: [], importBatches: [] };

async function makeBatch({ mode, datasets, rows, planFingerprint = [] }) {
  const batch = await prisma.importBatch.create({
    data: {
      fileName: `${MARK}.xlsx`,
      fileHash: `${MARK}-${Date.now()}-${Math.random()}`,
      mode,
      datasets,
      rows,
      plan: {},
      planFingerprint,
      status: "PENDING_APPLY",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  created.importBatches.push(batch.id);
  return batch;
}

async function cleanup() {
  console.log("\n--- cleanup ---");
  for (const id of created.incomes) await prisma.income.delete({ where: { id } }).catch(() => {});
  await prisma.dataOperation.deleteMany({ where: { importBatchId: { in: created.importBatches } } }).catch(() => {});
  for (const id of created.importBatches) await prisma.importBatch.delete({ where: { id } }).catch(() => {});
  const strayIncomes = await prisma.income.findMany({ where: { description: { contains: MARK } } });
  for (const i of strayIncomes) await prisma.income.delete({ where: { id: i.id } }).catch(() => {});
  console.log(`Limpeza: incomes remanescentes=${strayIncomes.length}, importBatches=${created.importBatches.length}.`);
}

async function serverReachable() {
  try {
    const res = await fetch(BASE_URL, { redirect: "manual" });
    return res.status < 500 || res.status === 401 || res.status === 302 || res.status === 307;
  } catch {
    return false;
  }
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ password: DEV_TEST_PASSWORD }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

function bodyLeaksSecret(text) {
  const patterns = [/SESSION_SECRET/i, /DASHBOARD_PASSWORD_HASH/i, /TELEGRAM_TOKEN/i, /TELEGRAM_WEBHOOK_SECRET/i, /DATABASE_URL/i, /DIRECT_URL/i, /postgresql:\/\//i, /scrypt\$/i];
  return patterns.some((p) => p.test(text));
}

async function main() {
  console.log(`--- Fase 6.0.1: Data Hub Integrity Closure (HTTP, ${BASE_URL}) ---\n`);
  if (!(await serverReachable())) {
    console.error(`Servidor não acessível em ${BASE_URL}. Suba o dev server (npm run dev) antes de rodar este teste.`);
    process.exit(1);
  }

  const acct = await prisma.account.findFirst();
  check("[pré] existe ao menos 1 conta real pra testar Receitas", !!acct);

  // ==========================================================================
  // A) AUTHZ — sem sessão, TODOS os endpoints do Data Hub -> unauthorized.
  // ==========================================================================
  const noAuthChecks = [
    ["GET", "/api/data/export"],
    ["GET", "/api/data/sheets?period=all"],
    ["GET", "/api/data/activity"],
    ["POST", "/api/data/import/preview"],
    ["POST", "/api/data/import/apply"],
    ["POST", "/api/data/import/undo"],
  ];
  for (const [method, path] of noAuthChecks) {
    const res = await fetch(`${BASE_URL}${path}`, { method, headers: method === "POST" ? { "Content-Type": "application/json", Origin: BASE_URL } : undefined, body: method === "POST" ? "{}" : undefined });
    check(`[AUTHZ] ${method} ${path} sem sessão -> 401`, res.status === 401, `status=${res.status}`);
  }

  const sessionCookie = await login();
  check("[pré] login com fixture de dev funcionou", !!sessionCookie && sessionCookie.includes("norte_session="));

  // ==========================================================================
  // B) CSRF — sessão válida, Origin cross-site -> 403 nas 3 rotas mutáveis.
  // ==========================================================================
  const csrfChecks = ["/api/data/import/preview", "/api/data/import/apply", "/api/data/import/undo"];
  for (const path of csrfChecks) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: "https://attacker.example" },
      body: "{}",
    });
    check(`[CSRF] POST ${path} com sessão válida mas Origin cross-site -> 403`, res.status === 403, `status=${res.status}`);
  }

  // ==========================================================================
  // C) CICLO REAL preview -> apply -> retry idempotente, via HTTP de verdade.
  // ==========================================================================
  if (acct) {
    const fd = new FormData();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Receitas");
    ws.addRow(["ID", "Valor", "Descrição", "Categoria", "Conta", "Recorrente", "Origem", "Confiança", "Data", "Criado em"]);
    ws.addRow([null, 77.77, `${MARK} ciclo real`, "Outros", acct.name, false, null, null, new Date("2099-02-10"), null]);
    const buf = await wb.xlsx.writeBuffer();
    fd.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "teste.xlsx");
    fd.append("mode", "add");
    fd.append("datasets", "incomes");

    const previewRes = await fetch(`${BASE_URL}/api/data/import/preview`, { method: "POST", headers: { Cookie: sessionCookie, Origin: BASE_URL }, body: fd });
    check("[C] preview real -> 200", previewRes.status === 200, `status=${previewRes.status}`);
    const previewBody = await previewRes.json();
    check("[C] preview identifica 1 create", previewBody.summary?.creates === 1, JSON.stringify(previewBody.summary));
    created.importBatches.push(previewBody.batchId);

    const incomeCountBefore = await prisma.income.count();
    const applyRes = await fetch(`${BASE_URL}/api/data/import/apply`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: BASE_URL }, body: JSON.stringify({ batchId: previewBody.batchId }) });
    check("[C] apply real -> 200 ok:true", applyRes.status === 200, `status=${applyRes.status}`);
    const applyBody = await applyRes.json();
    check("[C] apply conta 1 created", applyBody.counts?.created === 1, JSON.stringify(applyBody.counts));
    const incomeCountAfterFirst = await prisma.income.count();
    check("[C] exatamente 1 Income novo foi escrito", incomeCountAfterFirst === incomeCountBefore + 1, `${incomeCountBefore} -> ${incomeCountAfterFirst}`);

    const newIncome = await prisma.income.findFirst({ where: { description: `${MARK} ciclo real` } });
    if (newIncome) created.incomes.push(newIncome.id);

    // reaplicar o MESMO batchId -> idempotente, zero duplicata.
    const retryRes = await fetch(`${BASE_URL}/api/data/import/apply`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: BASE_URL }, body: JSON.stringify({ batchId: previewBody.batchId }) });
    check("[C] 2º apply do MESMO batchId -> 200 alreadyApplied:true", retryRes.status === 200, `status=${retryRes.status}`);
    const retryBody = await retryRes.json();
    check("[C] 2º apply devolve alreadyApplied com os MESMOS contadores", retryBody.alreadyApplied === true && retryBody.counts?.created === 1, JSON.stringify(retryBody));
    const incomeCountAfterRetry = await prisma.income.count();
    check("[C] idempotência: retry NÃO criou um segundo registro", incomeCountAfterRetry === incomeCountAfterFirst, `${incomeCountAfterFirst} -> ${incomeCountAfterRetry}`);

    // limpa a Income deste ciclo, mantendo o restante do arquivo mais enxuto pra próxima seção.
    if (newIncome) {
      await undoImportBatch(prisma, await prisma.importBatch.findUnique({ where: { id: previewBody.batchId } }));
      const afterCleanupUndo = await prisma.income.findUnique({ where: { id: newIncome.id } });
      check("[C] undo de limpeza (via lib) removeu a Income do ciclo C", afterCleanupUndo === null);
      created.incomes = created.incomes.filter((id) => id !== newIncome.id);
    }
  }

  // ==========================================================================
  // D) PREVIEW -> APPLY STALE GUARD, via HTTP de verdade (item 13 da closure).
  // ==========================================================================
  if (acct) {
    const original = await prisma.income.create({ data: { amount: 50, description: `${MARK} stale-guard original`, accountId: acct.id, occurredAt: new Date("2099-03-01") } });
    created.incomes.push(original.id);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Receitas");
    ws.addRow(["ID", "Valor", "Descrição", "Categoria", "Conta", "Recorrente", "Origem", "Confiança", "Data", "Criado em"]);
    ws.addRow([original.id, 999.99, `${MARK} stale-guard MODIFICADO`, "Outros", acct.name, false, null, null, new Date("2099-03-01"), null]);
    const buf = await wb.xlsx.writeBuffer();
    const fd = new FormData();
    fd.append("file", new Blob([buf]), "teste.xlsx");
    fd.append("mode", "update");
    fd.append("datasets", "incomes");

    const previewRes = await fetch(`${BASE_URL}/api/data/import/preview`, { method: "POST", headers: { Cookie: sessionCookie, Origin: BASE_URL }, body: fd });
    const previewBody = await previewRes.json();
    check("[D] preview de update por ID -> 1 update planejado", previewBody.summary?.updates === 1, JSON.stringify(previewBody.summary));
    created.importBatches.push(previewBody.batchId);

    // MUDA o registro por fora, depois do preview, antes do apply.
    await prisma.income.update({ where: { id: original.id }, data: { description: `${MARK} mudou por fora entre preview e apply` } });

    const applyRes = await fetch(`${BASE_URL}/api/data/import/apply`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: BASE_URL }, body: JSON.stringify({ batchId: previewBody.batchId }) });
    check("[D] apply ABORTA com 409 stale_import", applyRes.status === 409, `status=${applyRes.status}`);
    const applyBody = await applyRes.json();
    check('[D] mensagem de erro é "Os dados mudaram desde a revisão. Valide novamente."', applyBody.message === "Os dados mudaram desde a revisão. Valide novamente.", applyBody.message);
    const stillOriginal = await prisma.income.findUnique({ where: { id: original.id } });
    check("[D] o valor NÃO foi sobrescrito (zero efeito financeiro do apply abortado)", Number(stillOriginal.amount) === 50, String(stillOriginal.amount));
    const batchAfter = await prisma.importBatch.findUnique({ where: { id: previewBody.batchId } });
    check("[D] ImportBatch continua PENDING_APPLY", batchAfter.status === "PENDING_APPLY", batchAfter.status);
  }

  // ==========================================================================
  // E) ATOMICIDADE DO APPLY — failure-injection no DataOperation IMPORT_APPLY
  //    (item 2/3 da closure). Usa um Prisma Client Extension pra forçar o
  //    create() do audit log a falhar DENTRO da mesma transação — sem
  //    precisar de nenhum hook de teste no código de produção.
  // ==========================================================================
  if (acct) {
    const rows = { incomes: [{ amount: 321.5, description: `${MARK} atomicidade`, accountName: acct.name, occurredAt: new Date("2099-04-01") }] };
    const batch = await makeBatch({ mode: "add", datasets: ["incomes"], rows });

    const incomeCountBefore = await prisma.income.count();
    const failingPrisma = prisma.$extends({
      query: {
        dataOperation: {
          async create() {
            throw new Error("INJECTED_FAILURE_TEST — falha proposital no audit log");
          },
        },
      },
    });

    let threw = null;
    try {
      await applyImportBatch(failingPrisma, { id: batch.id, mode: "add", datasets: ["incomes"], rows, resolutions: {}, planFingerprint: [], fileName: batch.fileName, fileHash: batch.fileHash });
    } catch (err) {
      threw = err;
    }
    check("[E] apply lança erro quando o audit log falha", threw != null && threw.message.includes("INJECTED_FAILURE_TEST"), threw?.message);

    const incomeCountAfter = await prisma.income.count();
    check("[E] ZERO efeito financeiro — nenhuma Income nova foi commitada", incomeCountAfter === incomeCountBefore, `${incomeCountBefore} -> ${incomeCountAfter}`);
    const strayIncome = await prisma.income.findFirst({ where: { description: `${MARK} atomicidade` } });
    check("[E] a Income da injeção de falha não existe no banco", strayIncome === null);

    const batchAfter = await prisma.importBatch.findUnique({ where: { id: batch.id } });
    check("[E] ImportBatch NÃO ficou APPLIED (rollback também desfez o status)", batchAfter.status === "PENDING_APPLY", batchAfter.status);
    check("[E] ImportBatch.resultCounts continua vazio (nada foi gravado)", batchAfter.resultCounts == null, JSON.stringify(batchAfter.resultCounts));

    const opsForBatch = await prisma.dataOperation.findMany({ where: { importBatchId: batch.id } });
    check("[E] nenhum DataOperation IMPORT_APPLY foi persistido pra este batch (tudo revertido)", !opsForBatch.some((o) => o.type === "IMPORT_APPLY"));
  }

  // ==========================================================================
  // F) UNDO — UPDATE REAL, verificação campo a campo (item 9/11 da closure).
  // ==========================================================================
  if (acct) {
    const original = await prisma.income.create({
      data: {
        amount: 1234.57,
        description: `${MARK} undo-update original`,
        category: "Salário",
        accountId: acct.id,
        occurredAt: new Date("2099-05-10"),
        source: "manual",
        confidence: "CONFIRMED",
        isRecurring: false,
      },
    });
    created.incomes.push(original.id);
    const originalSnapshot = { ...original };

    const rows = { incomes: [{ id: original.id, amount: 9999.01, description: `${MARK} undo-update B`, category: "Outros", accountName: acct.name, occurredAt: new Date("2099-05-20"), isRecurring: false }] };
    const batch = await makeBatch({ mode: "update", datasets: ["incomes"], rows });
    const applied = await applyImportBatch(prisma, { id: batch.id, mode: "update", datasets: ["incomes"], rows, resolutions: {}, planFingerprint: [], fileName: batch.fileName, fileHash: batch.fileHash });
    check("[F] apply do update real: 1 updated", applied.counts.updated === 1, JSON.stringify(applied.counts));

    const afterApply = await prisma.income.findUnique({ where: { id: original.id } });
    check("[F] estado B confirmado (valor novo)", Number(afterApply.amount) === 9999.01 && afterApply.description === `${MARK} undo-update B`, JSON.stringify({ amount: afterApply.amount.toString(), description: afterApply.description }));

    const batchAfterApply = await prisma.importBatch.findUnique({ where: { id: batch.id } });
    await undoImportBatch(prisma, batchAfterApply);

    const afterUndo = await prisma.income.findUnique({ where: { id: original.id } });
    check("[F] UNDO restaura id estável (mesma linha, não recriada)", afterUndo.id === originalSnapshot.id);
    check("[F] UNDO restaura amount Decimal EXATO (1234.57, sem perda de precisão)", afterUndo.amount.toString() === originalSnapshot.amount.toString(), `${afterUndo.amount} vs ${originalSnapshot.amount}`);
    check("[F] UNDO restaura description original", afterUndo.description === originalSnapshot.description, afterUndo.description);
    check("[F] UNDO restaura category original", afterUndo.category === originalSnapshot.category, afterUndo.category);
    check("[F] UNDO restaura occurredAt (data) original exata", afterUndo.occurredAt.getTime() === originalSnapshot.occurredAt.getTime());
    check("[F] UNDO restaura source original", afterUndo.source === originalSnapshot.source, afterUndo.source);
    check("[F] UNDO restaura confidence original", afterUndo.confidence === originalSnapshot.confidence, afterUndo.confidence);
    check("[F] UNDO restaura accountId (relação) original", afterUndo.accountId === originalSnapshot.accountId);
    check("[F] UNDO preserva createdAt original (nunca é campo mutável)", afterUndo.createdAt.getTime() === originalSnapshot.createdAt.getTime());
    check("[F] updatedAt reflete o momento do UNDO, não o valor pré-import (contrato real do @updatedAt)", afterUndo.updatedAt.getTime() > afterApply.updatedAt.getTime());
  }

  // ==========================================================================
  // G) UNDO — CONCORRÊNCIA (item 12 da closure): registro mudou depois do
  //    apply -> undo deve ABORTAR, nunca sobrescrever silenciosamente.
  // ==========================================================================
  if (acct) {
    const original = await prisma.income.create({ data: { amount: 10, description: `${MARK} undo-concorrencia original`, accountId: acct.id, occurredAt: new Date("2099-06-01") } });
    created.incomes.push(original.id);

    const rows = { incomes: [{ id: original.id, amount: 20, description: `${MARK} undo-concorrencia B`, accountName: acct.name, occurredAt: new Date("2099-06-01"), isRecurring: false }] };
    const batch = await makeBatch({ mode: "update", datasets: ["incomes"], rows });
    await applyImportBatch(prisma, { id: batch.id, mode: "update", datasets: ["incomes"], rows, resolutions: {}, planFingerprint: [], fileName: batch.fileName, fileHash: batch.fileHash });

    // edição concorrente DEPOIS do apply, antes do undo.
    await prisma.income.update({ where: { id: original.id }, data: { description: `${MARK} mudou por fora depois do apply` } });

    const batchAfterApply = await prisma.importBatch.findUnique({ where: { id: batch.id } });
    let staleUndoThrew = null;
    try {
      await undoImportBatch(prisma, batchAfterApply);
    } catch (err) {
      staleUndoThrew = err;
    }
    check("[G] undo ABORTA (UndoStaleStateError) quando o registro mudou depois do apply", staleUndoThrew instanceof UndoStaleStateError, staleUndoThrew?.message);

    const afterAbortedUndo = await prisma.income.findUnique({ where: { id: original.id } });
    check("[G] undo abortado NÃO sobrescreveu a edição concorrente", afterAbortedUndo.description === `${MARK} mudou por fora depois do apply`, afterAbortedUndo.description);
    const batchStillApplied = await prisma.importBatch.findUnique({ where: { id: batch.id } });
    check("[G] ImportBatch continua APPLIED (undo abortado não muda o status)", batchStillApplied.status === "APPLIED", batchStillApplied.status);
  }

  // ==========================================================================
  // H) PREVIEW NUNCA ESCREVE DADO FINANCEIRO (item 14 da closure).
  // ==========================================================================
  if (acct) {
    const before = await prisma.income.count();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Receitas");
    ws.addRow(["ID", "Valor", "Descrição", "Categoria", "Conta", "Recorrente", "Origem", "Confiança", "Data", "Criado em"]);
    ws.addRow([null, 55, `${MARK} preview zero write`, "Outros", acct.name, false, null, null, new Date("2099-07-01"), null]);
    const buf = await wb.xlsx.writeBuffer();
    const fd = new FormData();
    fd.append("file", new Blob([buf]), "teste.xlsx");
    fd.append("mode", "add");
    fd.append("datasets", "incomes");
    const previewRes = await fetch(`${BASE_URL}/api/data/import/preview`, { method: "POST", headers: { Cookie: sessionCookie, Origin: BASE_URL }, body: fd });
    const previewBody = await previewRes.json();
    created.importBatches.push(previewBody.batchId);
    const after = await prisma.income.count();
    check("[H] preview real (HTTP) -> ZERO Income nova escrita", after === before, `${before} -> ${after}`);
  }

  // ==========================================================================
  // I) XLSX SANITY (leitor independente) + NO_SECRET_SCAN (itens 21/22).
  // ==========================================================================
  {
    const exportRes = await fetch(`${BASE_URL}/api/data/export`, { headers: { Cookie: sessionCookie } });
    check("[I] export real -> 200", exportRes.status === 200, `status=${exportRes.status}`);
    const arrayBuffer = await exportRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    check("[I] workbook tem 28 abas (24 RAW + Resumo/Indicadores/Projeções/Dicionário)", wb.worksheets.length === 28, String(wb.worksheets.length));
    check("[I] aba Resumo presente", !!wb.getWorksheet("Resumo"));
    check("[I] aba Dicionário de dados presente", !!wb.getWorksheet("Dicionário de dados"));
    check("[I] aba Indicadores presente", !!wb.getWorksheet("Indicadores"));
    check("[I] aba Projeções presente", !!wb.getWorksheet("Projeções"));

    const despesas = wb.getWorksheet("Despesas");
    const row2 = despesas?.getRow(2);
    let moneyIsNumeric = false;
    let dateIsDate = false;
    if (row2) {
      const valorCell = row2.getCell(2); // coluna "Valor"
      const dataCell = row2.getCell(10); // coluna "Data"
      moneyIsNumeric = typeof valorCell.value === "number";
      dateIsDate = valorCell && dataCell.value instanceof Date;
    }
    check("[I] célula de dinheiro é tipo numérico real (nunca string)", moneyIsNumeric);
    check("[I] célula de data é tipo Date real (nunca string)", dateIsDate);

    // NO_SECRET_SCAN — varre TODAS as células de TODAS as abas.
    let secretHits = [];
    const SECRET_PATTERNS = [/SESSION_SECRET/i, /DASHBOARD_PASSWORD_HASH/i, /TELEGRAM_TOKEN/i, /TELEGRAM_WEBHOOK_SECRET/i, /DATABASE_URL/i, /DIRECT_URL/i, /postgresql:\/\//i, /scrypt\$/i];
    for (const sheet of wb.worksheets) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          const v = cell.value;
          const s = typeof v === "string" ? v : v instanceof Date ? "" : v != null ? String(v) : "";
          if (s && SECRET_PATTERNS.some((p) => p.test(s))) secretHits.push({ sheet: sheet.name, value: s.slice(0, 40) });
        });
      });
    }
    check("[I] NO_SECRET_SCAN: zero padrão de segredo em qualquer célula do workbook", secretHits.length === 0, JSON.stringify(secretHits));

    // Também não deve haver header/aba de sessão/rate-limit/bot-wizard.
    const forbiddenSheetNames = ["PendingBotMessage", "BotWizardSession", "Session", "RateLimit"];
    const hasForbidden = wb.worksheets.some((s) => forbiddenSheetNames.includes(s.name));
    check("[I] nenhuma aba de estado interno do bot/sessão foi exportada", !hasForbidden);
  }

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
