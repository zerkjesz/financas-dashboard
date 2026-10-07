// Fase 10.3 — DATA HUB: filtro de período + export com metadados + import com range + SUBSTITUIR parcial seguro.
// Testes direcionados (DEV DB, assertTestEnvironment, marcador TESTE_F103, cleanup em finally).
//
//   node scripts/test-fase103-datahub.mjs
import { assertTestEnvironment } from "./lib/assertTestEnvironment.js";
assertTestEnvironment();

import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma.js";
import { resolveRange, rangeFromBounds, DataRangeError, PRESET_ORDER, NORTE_START_DATE, classifyRow, filterSheetRows } from "../lib/dataHub/range.js";
import { buildExportWorkbook } from "../lib/dataHub/export.js";
import { loadExportData, summarizeExportData } from "../lib/dataHub/exportData.js";
import { parseImportFile } from "../lib/dataHub/parse.js";
import { planImport } from "../lib/dataHub/plan.js";
import { planReplace, applyReplace, resolveReplaceScope, ReplaceScopeError } from "../lib/dataHub/replace.js";
import { undoImportBatch } from "../lib/dataHub/undo.js";

const MARK = "TESTE_F103";
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
const settings = { cycleStartDay: 24 };
const at = (iso) => new Date(iso);
const R = (preset, nowIso, extra = {}) => resolveRange({ preset, now: at(nowIso), settings, timeZone: "America/Sao_Paulo", ...extra });

const created = { batches: [] };
async function makeBatch({ datasets, rows, plan = {} }) {
  const b = await prisma.importBatch.create({
    data: { fileName: `${MARK}.xlsx`, fileHash: `${MARK}-${Date.now()}-${Math.random()}`, mode: "replace", datasets, rows, plan, planFingerprint: [], status: "PENDING_APPLY", expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
  });
  created.batches.push(b.id);
  return b;
}
async function cleanup() {
  console.log("\n--- cleanup ---");
  await prisma.dataOperation.deleteMany({ where: { importBatchId: { in: created.batches } } }).catch(() => {});
  for (const id of created.batches) await prisma.importBatch.delete({ where: { id } }).catch(() => {});
  const e = await prisma.expense.deleteMany({ where: { description: { contains: MARK } } });
  const i = await prisma.income.deleteMany({ where: { description: { contains: MARK } } });
  console.log(`Limpeza: expenses=${e.count} incomes=${i.count}`);
}

// ---------------------------------------------------------------------------
// 1) PRESETS (puro) — ciclo 24→23, bordas, personalizado, Período todo sem herança
// ---------------------------------------------------------------------------
function testPresets() {
  const cycle = (d) => {
    const r = R("current_cycle", d);
    return `${r.dateFrom}|${r.dateTo}`;
  };
  check("[P] 23/09 12h → ciclo 24/08–23/09", cycle("2026-09-23T15:00:00Z") === "2026-08-24|2026-09-23", cycle("2026-09-23T15:00:00Z"));
  check("[P] 24/09 → ciclo 24/09–23/10", cycle("2026-09-24T15:00:00Z") === "2026-09-24|2026-10-23");
  check("[P] 30/09 → ciclo 24/09–23/10", cycle("2026-09-30T15:00:00Z") === "2026-09-24|2026-10-23");
  check("[P] 01/10 → ciclo 24/09–23/10", cycle("2026-10-01T15:00:00Z") === "2026-09-24|2026-10-23");
  check("[P] 23/10 → ciclo 24/09–23/10", cycle("2026-10-23T15:00:00Z") === "2026-09-24|2026-10-23");
  check("[P] 24/10 → ciclo 24/10–23/11", cycle("2026-10-24T15:00:00Z") === "2026-10-24|2026-11-23");
  // fuso: 24/10 01:30Z = 23/10 22:30 em São Paulo → ainda é 23/10
  check("[P] fuso: 24/10 01:30Z (= 23/10 22:30 BRT) ainda no ciclo anterior", cycle("2026-10-24T01:30:00Z") === "2026-09-24|2026-10-23", cycle("2026-10-24T01:30:00Z"));
  const prev = R("previous_cycle", "2026-10-07T15:00:00Z");
  check("[P] ciclo anterior (07/10) = 24/08–23/09", prev.dateFrom === "2026-08-24" && prev.dateTo === "2026-09-23", `${prev.dateFrom}|${prev.dateTo}`);
  check("[P] ciclo atual traz financialCycleStart/End", R("current_cycle", "2026-10-07T15:00:00Z").financialCycleStart === "2026-09-24");
  const l30 = R("last_30_days", "2026-10-07T15:00:00Z");
  const l90 = R("last_90_days", "2026-10-07T15:00:00Z");
  check("[P] últimos 30 dias = 09/09–07/10", l30.dateFrom === "2026-09-08" || l30.dateFrom === "2026-09-09", `${l30.dateFrom}|${l30.dateTo}`);
  check("[P] últimos 30 dias termina hoje", l30.dateTo === "2026-10-07");
  check("[P] últimos 90 dias termina hoje e tem 90 dias", l90.dateTo === "2026-10-07" && (at(`${l90.dateTo}T00:00:00Z`) - at(`${l90.dateFrom}T00:00:00Z`)) / 86400000 === 89);
  const ty = R("this_year", "2026-10-07T15:00:00Z");
  check("[P] este ano = 01/01–hoje", ty.dateFrom === "2026-01-01" && ty.dateTo === "2026-10-07");
  const sn = R("since_norte_start", "2026-10-07T15:00:00Z");
  check("[P] desde o início do Norte = 24/08/2026–hoje", sn.dateFrom === NORTE_START_DATE && sn.dateTo === "2026-10-07" && !sn.allTime);
  const all = R("all_time", "2026-10-07T15:00:00Z", { dateFrom: "01/10/2026", dateTo: "23/10/2026" });
  check("[P] Período todo: sem filtro, NÃO herda dateFrom/dateTo residuais", all.allTime && all.dateFrom === null && all.dateTo === null);
  check("[P] Período todo ≠ Desde o início do Norte", all.allTime !== sn.allTime);
  const c = R("custom", "2026-10-07T15:00:00Z", { dateFrom: "01/09/2026", dateTo: "15/09/2026" });
  check("[P] personalizado DD/MM/AAAA", c.dateFrom === "2026-09-01" && c.dateTo === "2026-09-15");
  const bad = (opts) => {
    try {
      resolveRange({ preset: "custom", now: at("2026-10-07T15:00:00Z"), settings, ...opts });
      return null;
    } catch (e) {
      return e instanceof DataRangeError ? e.code : "OTHER:" + e.message;
    }
  };
  check("[P] personalizado: formato inválido recusado", bad({ dateFrom: "2026-13-01", dateTo: "2026-10-01" }) !== null);
  check("[P] personalizado: 31/02 recusado", bad({ dateFrom: "31/02/2026", dateTo: "01/03/2026" }) !== null);
  check("[P] personalizado: início > fim recusado", bad({ dateFrom: "10/10/2026", dateTo: "01/10/2026" }) === "RANGE_ORDER");
  check("[P] personalizado: vazio recusado", bad({ dateFrom: "", dateTo: "" }) !== null);
  check("[P] personalizado: 1 dia (início = fim) válido", bad({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }) === null);
  check("[P] preset desconhecido recusado", (() => { try { resolveRange({ preset: "xyz", now: new Date(), settings }); return false; } catch (e) { return e instanceof DataRangeError; } })());
  check("[P] 8 presets expostos", PRESET_ORDER.length === 8);
}

// ---------------------------------------------------------------------------
async function main() {
  testPresets();

  const acct = await prisma.account.findFirst();
  check("pré-condição: existe conta para os fixtures", !!acct);
  if (!acct) return;

  // Fixtures em 2099 (zero dado real ali). "Hoje" simulado = 05/10/2099 ⇒ ciclo atual 24/09/2099–23/10/2099.
  const NOW = "2099-10-05T15:00:00Z";
  const days = {
    ago: "2099-08-30T03:00:00Z", // fora (ciclo ant.)
    sep23: "2099-09-23T03:00:00Z", // fora, borda
    sep24: "2099-09-24T03:00:00Z", // dentro, borda
    oct10: "2099-10-10T00:00:00Z", // dentro (convenção UTC-meia-noite)
    oct23: "2099-10-23T03:00:00Z", // dentro, borda
    oct24: "2099-10-24T03:00:00Z", // fora, borda
    nov: "2099-11-10T03:00:00Z", // fora
  };
  const preNorte = "2026-08-01T03:00:00Z"; // antes do início do Norte
  const ex = {};
  for (const [k, v] of Object.entries({ ...days, preNorte })) {
    ex[k] = await prisma.expense.create({ data: { amount: 10, description: `${MARK} exp ${k}`, category: "Teste", accountId: acct.id, occurredAt: at(v) } });
  }
  const inc = {};
  for (const [k, v] of Object.entries(days)) {
    inc[k] = await prisma.income.create({ data: { amount: 20, description: `${MARK} inc ${k}`, category: "Teste", accountId: acct.id, occurredAt: at(v) } });
  }
  const inCycleKeys = ["sep24", "oct10", "oct23"];

  // ---- export por ciclo atual: contagem por entidade, metadados, round-trip ----
  const cur = R("current_cycle", NOW);
  const { buffer: bufCur } = await buildExportWorkbook({ range: cur, now: at(NOW) });
  const pCur = await parseImportFile(bufCur, { fileName: "cur.xlsx" });
  const markIn = (parsed, sheet) => (parsed.rowsBySheet[sheet] || []).filter((r) => String(r.description || "").includes(MARK)).map((r) => String(r.description).replace(`${MARK} `, "").replace(/^(exp|inc) /, ""));
  const expCur = markIn(pCur, "expenses").sort();
  const incCur = markIn(pCur, "incomes").sort();
  check("[X] ciclo atual exporta só despesas do período (24/09–23/10)", JSON.stringify(expCur) === JSON.stringify([...inCycleKeys].sort()), JSON.stringify(expCur));
  check("[X] ciclo atual exporta só receitas do período", JSON.stringify(incCur) === JSON.stringify([...inCycleKeys].sort()), JSON.stringify(incCur));
  const meta = pCur.exportMeta;
  check("[M] metadados: preset/dateFrom/dateTo/ciclo", meta.rangePreset === "current_cycle" && meta.dateFrom === "2099-09-24" && meta.dateTo === "2099-10-23" && meta.financialCycleStart === "2099-09-24" && meta.financialCycleEnd === "2099-10-23", JSON.stringify(meta));
  check("[M] metadados: schemaVersion 6.1.0, exportedAt ISO, timezone", meta.schemaVersion === "6.1.0" && /^2099-10-05T15:00:00/.test(meta.exportedAt) && meta.timezone === "America/Sao_Paulo", JSON.stringify(meta));
  check("[M] arquivo novo não é legado e tem limites", meta.legacy === false && meta.hasBounds === true);
  check("[M] versão suportada reconhecida", pCur.schemaVersionKnown === true);

  // ---- ALL_TIME vs SINCE_NORTE_START vs período todo ----
  const sinceN = R("since_norte_start", NOW);
  const dAll = await loadExportData({ range: R("all_time", NOW), selectedKeys: ["expenses", "incomes"] });
  const dSn = await loadExportData({ range: sinceN, selectedKeys: ["expenses", "incomes"] });
  const markCount = (data, sheet) => data.sheets.find((s) => s.def.key === sheet).rows.filter((r) => String(r.description || "").includes(MARK)).length;
  check("[T] Período todo inclui TODAS as despesas de fixture (7 + pré-Norte)", markCount(dAll, "expenses") === Object.keys(days).length + 1, String(markCount(dAll, "expenses")));
  check("[T] Desde o início do Norte exclui a despesa pré-24/08/2026", markCount(dSn, "expenses") === 3 /* ago, set23, set24: 24/08/2026 → "hoje" simulado 05/10/2099 */, String(markCount(dSn, "expenses")));
  check("[T] Período todo ≠ Desde o início (conteúdo diferente)", markCount(dAll, "expenses") > markCount(dSn, "expenses"));
  check("[T] Período todo não limitado ao mês/ciclo atual", markCount(dAll, "expenses") === 8 && markCount(await loadExportData({ range: cur, selectedKeys: ["expenses"] }), "expenses") === 3);

  // ---- classificação: estado global / sem data ----
  const accCur = await loadExportData({ range: cur, selectedKeys: ["accounts"] });
  const accAll = await prisma.account.count();
  check("[S] contas (estado global) entram inteiras em qualquer recorte", accCur.sheets[0].counts.included === accAll && accCur.sheets[0].counts.globalState === accAll);
  check("[S] classificação: compromisso sem prazo é NO_EVENT_DATE (incluído)", classifyRow("confirmedCommitments", { dueDate: null }, cur) === "NO_EVENT_DATE");
  check("[S] classificação: despesa fora do ciclo é OUT_OF_RANGE", classifyRow("expenses", { occurredAt: at(days.oct24) }, cur) === "OUT_OF_RANGE");

  // ---- preview somente leitura ----
  const snap = async () => ({
    expense: await prisma.expense.count(),
    income: await prisma.income.count(),
    bill: await prisma.bill.count(),
    ops: await prisma.dataOperation.count(),
    batches: await prisma.importBatch.count(),
    upd: String((await prisma.expense.aggregate({ _max: { updatedAt: true } }))._max.updatedAt),
    billUpd: String((await prisma.bill.aggregate({ _max: { updatedAt: true } }))._max.updatedAt),
  });
  const s0 = await snap();
  const sum = summarizeExportData(await loadExportData({ range: cur }));
  const s1 = await snap();
  check("[V] preview: zero escritas (contagens, Bills, DataOperation, ImportBatch, updatedAt)", JSON.stringify(s0) === JSON.stringify(s1), JSON.stringify([s0, s1]));
  const eSheet = sum.sheets.find((s) => s.key === "expenses");
  check("[V] preview traz contagem por entidade e semântica de data", eSheet.rowCount >= 3 && !!eSheet.dateSemantics && sum.rangeText.includes("24/09/2099") && sum.rangeText.includes("23/10/2099"), JSON.stringify(eSheet));

  // ---- IMPORT: arquivo legado (sem metadados de período) ----
  const wbLegacy = new ExcelJS.Workbook();
  await wbLegacy.xlsx.load(bufCur);
  const resumo = wbLegacy.getWorksheet("Resumo");
  const hdr = resumo.getRow(1).values;
  const keep = hdr.map((h, i) => ({ h, i })).filter(({ h }) => h && !["Preset do período", "Data inicial", "Data final", "Início do ciclo financeiro", "Fim do ciclo financeiro", "Exportado em (ISO)", "Fuso horário"].includes(String(h)));
  const rowsVals = resumo.getRow(2).values;
  resumo.spliceColumns(1, hdr.length); // zera
  keep.forEach(({ h, i }, idx) => {
    resumo.getCell(1, idx + 1).value = h;
    resumo.getCell(2, idx + 1).value = rowsVals[i];
  });
  const bufLegacy = Buffer.from(await wbLegacy.xlsx.writeBuffer());
  const pLegacy = await parseImportFile(bufLegacy, { fileName: "legado.xlsx" });
  check("[L] arquivo legado continua importável e é marcado como legado", pLegacy.exportMeta?.legacy === true && !pLegacy.exportMeta.hasBounds && (pLegacy.rowsBySheet.expenses || []).length > 0);
  const legacyPlan = await planImport({ prisma, mode: "add", datasets: ["expenses"], rowsBySheet: { expenses: (pLegacy.rowsBySheet.expenses || []).filter((r) => String(r.description || "").includes(MARK)) } });
  check("[L] ADICIONAR de arquivo legado funciona (linhas existentes viram 'já existe')", legacyPlan.summary.creates === 0 && legacyPlan.summary.skips === 3, JSON.stringify(legacyPlan.summary));
  let legacyErr = null;
  try { resolveReplaceScope({ exportMeta: pLegacy.exportMeta }); } catch (e) { legacyErr = e; }
  check("[L] SUBSTITUIR de arquivo legado exige período explícito (não inventa range)", legacyErr instanceof ReplaceScopeError && legacyErr.code === "legacy_replace_requires_range");
  const legacyScope = resolveReplaceScope({ exportMeta: pLegacy.exportMeta, requestedFrom: "24/09/2099", requestedTo: "23/10/2099" });
  check("[L] com De/Até explícitos o escopo é exatamente o informado", legacyScope.scope.dateFrom === "2099-09-24" && legacyScope.scope.dateTo === "2099-10-23" && legacyScope.source === "user_range_legacy_file");
  let noMeta = null;
  try { resolveReplaceScope({ exportMeta: null }); } catch (e) { noMeta = e; }
  check("[L] arquivo sem aba Resumo também exige período", noMeta?.code === "legacy_replace_requires_range");

  // ---- escopo do arquivo: não amplia ----
  const fileScope = resolveReplaceScope({ exportMeta: meta });
  check("[R] escopo do arquivo parcial = período declarado", fileScope.scope.dateFrom === "2099-09-24" && fileScope.scope.dateTo === "2099-10-23" && fileScope.source === "file_range");
  let widen = null;
  try { resolveReplaceScope({ exportMeta: meta, requestedFrom: "01/09/2099", requestedTo: "23/10/2099" }); } catch (e) { widen = e; }
  check("[R] pedir escopo MAIOR que o arquivo cobre é recusado", widen?.code === "scope_exceeds_file");
  const narrowed = resolveReplaceScope({ exportMeta: meta, requestedFrom: "01/10/2099", requestedTo: "23/10/2099" });
  check("[R] estreitar o escopo dentro do arquivo é permitido", narrowed.scope.dateFrom === "2099-10-01" && narrowed.source === "user_narrowed");
  const { buffer: bufAll } = await buildExportWorkbook({ range: R("all_time", NOW), selectedKeys: ["expenses", "incomes"], now: at(NOW) });
  const pAll = await parseImportFile(bufAll, { fileName: "all.xlsx" });
  const allScope = resolveReplaceScope({ exportMeta: pAll.exportMeta });
  check("[R] arquivo 'Período todo' → escopo todo (e só ele)", pAll.exportMeta.rangePreset === "all_time" && allScope.scope.allTime === true);
  let noScope = null;
  try { await planReplace({ prisma, datasets: ["expenses"], rowsBySheet: {} }); } catch (e) { noScope = e; }
  check("[R] planReplace sem escopo NÃO assume 'tudo' (lança)", noScope?.code === "replace_scope_required");

  // ---- SUBSTITUIR parcial (arquivo do ciclo atual) — nada fora do escopo é tocado ----
  const fileRows = {
    expenses: pCur.rowsBySheet.expenses.filter((r) => String(r.description || "").includes(MARK)),
    incomes: pCur.rowsBySheet.incomes.filter((r) => String(r.description || "").includes(MARK)),
  };
  // o arquivo traz também linhas de OUTROS períodos (arquivo adulterado/ruidoso): precisam ser ignoradas, não importadas.
  fileRows.expenses.push({ amount: 77, description: `${MARK} exp intruso-nov`, accountName: acct.name, category: "Teste", occurredAt: at(days.nov), id: null });
  const outsideSnapshot = async () => {
    const out = {};
    for (const [model, field] of [["expense", "occurredAt"], ["income", "occurredAt"], ["transfer", "occurredAt"]]) {
      const rows = await prisma[model].findMany({ where: { OR: [{ [field]: { lt: at("2099-09-24T00:00:00Z") } }, { [field]: { gte: at("2099-10-24T00:00:00Z") } }] }, select: { id: true, updatedAt: true, amount: true, description: true }, orderBy: { id: "asc" } });
      out[model] = rows.map((r) => `${r.id}|${r.updatedAt.toISOString()}|${r.amount}|${r.description}`);
    }
    return out;
  };
  const globals = async () => ({
    accounts: (await prisma.account.findMany({ orderBy: { id: "asc" }, select: { id: true, updatedAt: true } })).map((a) => `${a.id}|${a.updatedAt.toISOString()}`),
    rules: (await prisma.recurringRule.findMany({ orderBy: { id: "asc" }, select: { id: true, updatedAt: true } })).map((a) => `${a.id}|${a.updatedAt.toISOString()}`),
    settings: JSON.stringify(await prisma.appSettings.findMany()),
    goals: await prisma.goal.count(),
    commitments: await prisma.confirmedCommitment.count(),
  });
  const outBefore = await outsideSnapshot();
  const gBefore = await globals();
  // Fora do escopo, o DEV DB tem dados reais (pré-2099) — aqui o outsideSnapshot cobre TUDO fora de 24/09–23/10/2099, não só fixtures.

  const rp = await planReplace({ prisma, datasets: ["expenses", "incomes"], scope: fileScope.scope, rowsBySheet: fileRows });
  check("[R] plano: deletáveis = exatamente as 3+3 do ciclo (nada de fora)", rp.perDataset.expenses.deletableIds.length === 3 && rp.perDataset.incomes.deletableIds.length === 3, `${rp.perDataset.expenses.deletableIds.length}/${rp.perDataset.incomes.deletableIds.length}`);
  check("[R] plano: fora do escopo afetado = 0", rp.outside.affected === 0);
  check("[R] plano: linha do arquivo fora do período é IGNORADA (não entra)", rp.ignoredOutOfScope.expenses === 1 && !rp.addPlan.perDataset.expenses.creates.some((c) => String(c.data.description).includes("intruso")), JSON.stringify(rp.ignoredOutOfScope));
  check("[R] plano: linhas do ciclo são RECRIADAS (mesmo id) e não puladas como 'já existe'", rp.addPlan.perDataset.expenses.creates.length === 3 && rp.addPlan.perDataset.incomes.creates.length === 3 && rp.addPlan.perDataset.expenses.skips.length === 0, JSON.stringify({ c: rp.addPlan.perDataset.expenses.creates.length, s: rp.addPlan.perDataset.expenses.skips.length }));
  check("[R] plano: preview de replace é somente leitura", (await prisma.expense.count()) === s0.expense);

  const batch = await makeBatch({ datasets: ["expenses", "incomes"], rows: fileRows, plan: { scope: fileScope.scope } });
  const applied = await applyReplace(prisma, { id: batch.id, datasets: ["expenses", "incomes"], scope: fileScope.scope, rowsBySheet: fileRows, fileName: batch.fileName, fileHash: batch.fileHash });
  check("[R] apply: 6 removidas e 6 recriadas (3+3), 0 inválidas", applied.counts.deleted === 6 && applied.counts.created === 6 && applied.counts.invalid === 0, JSON.stringify(applied.counts));
  const outAfter = await outsideSnapshot();
  const gAfter = await globals();
  check("[R] OUT_OF_RANGE_ROWS_TOUCHED = 0 (despesas/receitas/transferências fora do período idênticas, incl. updatedAt)", JSON.stringify(outBefore) === JSON.stringify(outAfter));
  check("[R] fixtures de ago/set23/out24/nov (e o intruso) continuam como estavam", outAfter.expense.some((l) => l.includes("exp nov")) && !outAfter.expense.some((l) => l.includes("intruso")) && outAfter.income.some((l) => l.includes("inc ago")));
  check("[R] estado global intacto (Contas, Regras, AppSettings, Metas, Compromissos)", JSON.stringify(gBefore) === JSON.stringify(gAfter));
  const inAfter = await prisma.expense.findMany({ where: { description: { contains: `${MARK} exp` }, occurredAt: { gte: at("2099-09-24T00:00:00Z"), lt: at("2099-10-24T00:00:00Z") } } });
  check("[R] ciclo: mesmas 3 despesas, mesmos IDs (reaproveitados)", inAfter.length === 3 && inAfter.every((r) => [ex.sep24.id, ex.oct10.id, ex.oct23.id].includes(r.id)), String(inAfter.length));

  const undone = await undoImportBatch(prisma, await prisma.importBatch.findUnique({ where: { id: batch.id } }));
  check("[R] undo do substituir parcial restaura o ciclo (6 recriadas) sem duplicar", undone.restored === 6 && undone.deleted === 6, JSON.stringify(undone));
  const afterUndo = await prisma.expense.count({ where: { description: { contains: `${MARK} exp` } } });
  check("[R] após undo: 8 despesas de fixture (sem duplicar, sem perder)", afterUndo === Object.keys(days).length + 1, String(afterUndo));
  check("[R] após undo: fora do período continua idêntico", JSON.stringify(outBefore) === JSON.stringify(await outsideSnapshot()));

  // ---- 'Período todo' em REPLACE: só planeja (nunca aplica no DEV real); prova que o escopo ilimitado só vem de arquivo all_time ----
  const planAll = await planReplace({ prisma, datasets: ["expenses"], scope: allScope.scope, rowsBySheet: { expenses: [] } });
  check("[R] 'Período todo' só se aplica com arquivo all_time; nada fica 'fora' (outside.existing = 0)", planAll.outside.existing === 0 && planAll.perDataset.expenses.existingCount >= Object.keys(days).length + 1);

  // ---- trava final: apply com linha fora do escopo aborta ----
  let guard = null;
  try {
    const bad = await makeBatch({ datasets: ["expenses"], rows: { expenses: [] } });
    await applyReplace(prisma, { id: bad.id, datasets: ["expenses"], scope: { allTime: false }, rowsBySheet: { expenses: [] }, fileName: bad.fileName, fileHash: bad.fileHash });
  } catch (e) { guard = e; }
  check("[R] apply com escopo malformado é recusado", guard?.code === "scope_invalid");
}

try {
  await main();
} catch (e) {
  fail++;
  console.log("❌ erro inesperado:", e);
} finally {
  await cleanup();
  await prisma.$disconnect();
}
console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail === 0 ? 0 : 1);
