import ExcelJS from "exceljs";
import RAW_SHEETS from "./sheets.js";
import { SUPPORTED_SCHEMA_VERSIONS } from "./export.js";

// ============================================================================
// Fase 6.0 (Design Freeze) — PARSE + VALIDAÇÃO server-side do upload.
// Nunca confia em validação client-side (item 40). Limites explícitos
// (item 41 — XLSX é ZIP: proteção contra arquivo grande/malformado):
// ============================================================================
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
export const MAX_ROWS_PER_SHEET = 20000;
export const MAX_SHEETS = 60;

export class ImportParseError extends Error {
  constructor(message, code = "PARSE_ERROR") {
    super(message);
    this.code = code;
  }
}

const SHEET_NAME_TO_KEY = new Map(RAW_SHEETS.map((s) => [s.sheetName, s.key]));

function cellToPlain(cell) {
  const v = cell.value;
  if (v == null) return null;
  // Célula de fórmula: NUNCA usa/reexecuta a fórmula (item 33) — só o
  // resultado já calculado que o Excel salvou junto.
  if (typeof v === "object" && "formula" in v) {
    return v.result != null && typeof v.result === "object" && "error" in v.result ? null : v.result ?? null;
  }
  if (typeof v === "object" && v.richText) return v.richText.map((t) => t.text).join("");
  if (v instanceof Date) return v;
  return v;
}

// Aceita: XLSX (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
// pelo nome/extensão — CSV mencionado no design mas NÃO implementado nesta
// fase (item 38: a UI precisa refletir só o que existe de verdade).
export async function parseImportFile(buffer, { fileName = "arquivo.xlsx" } = {}) {
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new ImportParseError(`Arquivo maior que o limite de ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.`, "FILE_TOO_LARGE");
  }
  if (!/\.xlsx$/i.test(fileName)) {
    throw new ImportParseError("Só arquivos .xlsx são aceitos nesta versão.", "UNSUPPORTED_FORMAT");
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw new ImportParseError("Não foi possível ler o arquivo — verifique se é um .xlsx válido.", "MALFORMED_FILE");
  }

  if (workbook.worksheets.length > MAX_SHEETS) {
    throw new ImportParseError(`Arquivo com mais de ${MAX_SHEETS} abas — não processado.`, "TOO_MANY_SHEETS");
  }

  // Versão do schema de exportação (item 39) — lida da aba "Resumo" se
  // existir; arquivo sem essa aba (não veio de uma exportação Norte) ainda
  // é aceito, mas sem garantia de compatibilidade de coluna — cada adapter
  // valida os próprios campos de qualquer forma.
  let detectedSchemaVersion = null;
  let exportMeta = null; // Fase 10.3 — metadados do arquivo (null = arquivo não veio de uma exportação Norte)
  const resumoWs = workbook.getWorksheet("Resumo");
  if (resumoWs) {
    const header = resumoWs.getRow(1).values;
    const valueOf = (pred) => {
      const idx = header.findIndex((h) => pred(String(h || "")));
      return idx > 0 ? cellToPlain(resumoWs.getRow(2).getCell(idx)) : null;
    };
    detectedSchemaVersion = valueOf((h) => h.includes("schema"));
    const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
    const day = (v) => {
      const k = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).trim();
      return k && /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
    };
    const rangePreset = valueOf((h) => h === "Preset do período");
    exportMeta = {
      schemaVersion: detectedSchemaVersion != null ? String(detectedSchemaVersion) : null,
      exportedAt: iso(valueOf((h) => h === "Exportado em (ISO)")) ?? iso(valueOf((h) => h === "Gerado em")),
      timezone: valueOf((h) => h === "Fuso horário"),
      rangePreset: rangePreset != null ? String(rangePreset) : null,
      dateFrom: day(valueOf((h) => h === "Data inicial")),
      dateTo: day(valueOf((h) => h === "Data final")),
      financialCycleStart: day(valueOf((h) => h === "Início do ciclo financeiro")),
      financialCycleEnd: day(valueOf((h) => h === "Fim do ciclo financeiro")),
      periodText: valueOf((h) => h === "Período"),
    };
    // Arquivo LEGADO (6.0.0 ou sem metadados de período): nunca inventa um range a partir do conteúdo.
    exportMeta.legacy = !exportMeta.rangePreset;
    exportMeta.hasBounds = exportMeta.rangePreset === "all_time" || (!!exportMeta.dateFrom && !!exportMeta.dateTo);
  }
  const schemaVersionKnown = detectedSchemaVersion == null || SUPPORTED_SCHEMA_VERSIONS.includes(String(detectedSchemaVersion));

  const rowsBySheet = {};
  const unknownSheets = [];
  const sheetReports = [];

  for (const ws of workbook.worksheets) {
    const key = SHEET_NAME_TO_KEY.get(ws.name);
    if (!key) {
      if (!["Resumo", "Indicadores", "Projeções", "Dicionário de dados"].includes(ws.name)) unknownSheets.push(ws.name);
      continue;
    }
    const def = RAW_SHEETS.find((s) => s.key === key);
    const headerRow = ws.getRow(1).values.slice(1).map((h) => String(h || "").trim());
    const expectedHeaders = def.columns.map((c) => c.header);
    const missingColumns = expectedHeaders.filter((h) => !headerRow.includes(h));
    const unknownColumns = headerRow.filter((h) => h && !expectedHeaders.includes(h));

    const rows = [];
    const totalDataRows = ws.rowCount - 1;
    if (totalDataRows > MAX_ROWS_PER_SHEET) {
      throw new ImportParseError(`A aba "${ws.name}" tem mais de ${MAX_ROWS_PER_SHEET} linhas — não processada.`, "TOO_MANY_ROWS");
    }

    const colIndexByKey = {};
    def.columns.forEach((c) => {
      const idx = headerRow.indexOf(c.header);
      if (idx >= 0) colIndexByKey[c.key] = idx + 1; // exceljs é 1-based
    });

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj = {};
      let hasAny = false;
      for (const col of def.columns) {
        const idx = colIndexByKey[col.key];
        if (!idx) continue;
        const val = cellToPlain(row.getCell(idx));
        if (val != null) hasAny = true;
        obj[col.key] = val;
      }
      if (hasAny) rows.push(obj);
    });

    rowsBySheet[key] = rows;
    sheetReports.push({ key, sheetName: ws.name, rowCount: rows.length, missingColumns, unknownColumns, importable: def.importable });
  }

  return { rowsBySheet, sheetReports, unknownSheets, detectedSchemaVersion, schemaVersionKnown, exportMeta };
}
