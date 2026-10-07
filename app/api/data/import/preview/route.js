import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseImportFile, ImportParseError, MAX_FILE_SIZE_BYTES } from "@/lib/dataHub/parse";
import { planImport } from "@/lib/dataHub/plan";
import { planReplace, resolveReplaceScope, ReplaceScopeError, REPLACEABLE_DATASETS } from "@/lib/dataHub/replace";
import { describeRange } from "@/lib/dataHub/range";
import ADAPTERS from "@/lib/dataHub/adapters";

const PREVIEW_TTL_MS = 15 * 60 * 1000; // janela pra ir do preview até o apply — depois disso, revalida do zero.
const VALID_MODES = new Set(["add", "update", "replace"]);

// Fase 6.0 (Design Freeze) — item 42: UPLOAD -> PARSE -> VALIDATE ->
// NORMALIZE -> MATCH -> DRY-RUN -> PREVIEW. O upload sozinho NUNCA escreve
// dado financeiro (esta rota só grava um ImportBatch de TRABALHO — nenhuma
// tabela financeira é tocada aqui).
export async function POST(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = form.get("file");
  const mode = form.get("mode");
  // Fase 10.3 — o escopo do SUBSTITUIR vem do período que o ARQUIVO declara (metadados), nunca de um estado da tela.
  // scopeFrom/scopeTo só servem para (a) arquivo legado, que não declara período, ou (b) ESTREITAR o escopo do arquivo.
  const scopeFrom = form.get("scopeFrom") || null;
  const scopeTo = form.get("scopeTo") || null;
  const datasetsRaw = form.get("datasets"); // CSV de chaves, opcional (default: todas as importáveis do modo)

  if (!file || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "file_required" }, { status: 400 });
  if (!VALID_MODES.has(mode)) return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
  if (file.size > MAX_FILE_SIZE_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  let parsed;
  try {
    parsed = await parseImportFile(buffer, { fileName: file.name });
  } catch (err) {
    if (err instanceof ImportParseError) {
      await prisma.dataOperation.create({ data: { type: "IMPORT_FAILED", status: "FAILED", fileName: file.name, fileHash, mode, errorMessage: err.message } }).catch(() => {});
      return NextResponse.json({ error: err.code, message: err.message }, { status: 422 });
    }
    console.error("[api/data/import/preview] erro inesperado no parse:", err.message);
    return NextResponse.json({ error: "parse_failed" }, { status: 500 });
  }

  const importableKeys = Object.keys(ADAPTERS).filter((k) => ADAPTERS[k].modes.includes(mode === "replace" ? "add" : mode) || (mode === "replace" && REPLACEABLE_DATASETS.includes(k)));
  const requested = datasetsRaw ? String(datasetsRaw).split(",").filter(Boolean) : importableKeys;
  const datasets = requested.filter((k) => parsed.rowsBySheet[k] && parsed.rowsBySheet[k].length > 0 && (mode === "replace" ? REPLACEABLE_DATASETS.includes(k) : ADAPTERS[k]));

  if (datasets.length === 0) {
    return NextResponse.json({ error: "no_importable_data", message: "Nenhuma aba importável com dados foi encontrada no arquivo." }, { status: 422 });
  }

  let plan, fingerprint;
  if (mode === "replace") {
    let scopeInfo;
    try {
      scopeInfo = resolveReplaceScope({ exportMeta: parsed.exportMeta, requestedFrom: scopeFrom, requestedTo: scopeTo });
    } catch (err) {
      if (err instanceof ReplaceScopeError) {
        return NextResponse.json({ error: err.code, message: err.message, exportMeta: parsed.exportMeta ?? null, legacy: !parsed.exportMeta || parsed.exportMeta.legacy }, { status: 422 });
      }
      throw err;
    }
    const r = await planReplace({ prisma, datasets, scope: scopeInfo.scope, rowsBySheet: parsed.rowsBySheet });
    r.scopeSource = scopeInfo.source;
    plan = r;
    fingerprint = []; // substituir revalida por contagem no apply, não por updatedAt de linha individual (ver route de apply).
  } else {
    const r = await planImport({ prisma, mode, datasets, rowsBySheet: parsed.rowsBySheet });
    plan = r;
    fingerprint = r.fingerprint;
  }

  const now = new Date();
  const batch = await prisma.importBatch.create({
    data: {
      fileName: file.name,
      fileHash,
      mode,
      datasets,
      rows: parsed.rowsBySheet,
      plan,
      planFingerprint: fingerprint,
      status: "PENDING_APPLY",
      expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
    },
  });

  // Fase 6.0.1 (Integrity Closure, item 4/5) — importBatchId NÃO é mais
  // @unique (ImportBatch 1 → N DataOperation: PREVIEW, possivelmente FAILED,
  // APPLY, talvez UNDO, e retries de qualquer um desses são eventos de
  // auditoria genuínos e distintos do MESMO lote). Ligar o preview ao batch
  // agora é seguro e completa o ciclo de vida auditável.
  await prisma.dataOperation
    .create({ data: { type: "IMPORT_PREVIEW", status: "SUCCESS", mode, datasets, fileName: file.name, fileHash, importBatchId: batch.id } })
    .catch((err) => console.error("[api/data/import/preview] falha ao registrar atividade:", err.message));

  const summary = mode === "replace" ? summarizeReplace(plan) : plan.summary;
  const meta = parsed.exportMeta ?? null;
  const fileRows = datasets.reduce((a, k) => a + (parsed.rowsBySheet[k]?.length ?? 0), 0);
  const counts = mode === "replace" ? replaceCounts(plan, fileRows) : importCounts(plan, fileRows);

  return NextResponse.json({
    batchId: batch.id,
    mode,
    datasets,
    exportMeta: meta,
    legacyFile: !meta || meta.legacy,
    counts,
    scope: mode === "replace" ? { ...plan.scope, text: describeRange(plan.scope), source: plan.scopeSource } : undefined,
    schemaVersionKnown: parsed.schemaVersionKnown,
    unknownSheets: parsed.unknownSheets,
    sheetReports: parsed.sheetReports,
    summary,
    sampleDiffRows: mode === "replace" ? undefined : plan.sampleDiffRows,
    replaceScope: mode === "replace" ? plan.perDataset : undefined,
    expiresAt: batch.expiresAt,
  });
}

function summarizeReplace(plan) {
  let toDelete = 0,
    protectedCount = 0,
    toCreate = 0;
  for (const key of Object.keys(plan.perDataset)) {
    toDelete += plan.perDataset[key].deletableIds.length;
    protectedCount += plan.perDataset[key].protectedIds.length;
  }
  for (const key of Object.keys(plan.addPlan.perDataset)) toCreate += plan.addPlan.perDataset[key].creates.length;
  const ignored = Object.values(plan.ignoredOutOfScope || {}).reduce((a, b) => a + b, 0);
  // fora do escopo: nada é candidato à remoção (affected = 0 por construção; o apply ainda revalida e aborta se não for 0).
  return { toDelete, protectedCount, toCreate, invalid: Object.values(plan.addPlan.perDataset).reduce((a, b) => a + b.invalid.length, 0), insideScope: toDelete + protectedCount, outsideScopeExisting: plan.outside?.existing ?? 0, outsideScopeAffected: plan.outside?.affected ?? 0, fileRowsIgnoredOutsideScope: ignored, blocked: (plan.outside?.affected ?? 0) !== 0 };
}

function importCounts(plan, fileRows) {
  let existing = 0, ignored = 0;
  for (const b of Object.values(plan.perDataset)) {
    for (const sk of b.skips) {
      if (sk.reason === "já existe") existing++;
      else ignored++;
    }
    ignored += b.invalid.length;
  }
  return { total: fileRows, new: plan.summary.creates, existing, updates: plan.summary.updates, duplicates: existing, conflicts: plan.summary.conflicts, ignored, destructive: 0 };
}

function replaceCounts(plan, fileRows) {
  const s = summarizeReplace(plan);
  const skipped = Object.values(plan.addPlan.perDataset).reduce((a, b) => a + b.skips.length, 0);
  return { total: fileRows, new: s.toCreate, existing: s.insideScope, updates: 0, duplicates: skipped, conflicts: 0, ignored: s.fileRowsIgnoredOutsideScope + s.invalid + skipped, destructive: s.toDelete };
}
