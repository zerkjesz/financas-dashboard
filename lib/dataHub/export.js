import ExcelJS from "exceljs";
import RAW_SHEETS, { PERIODS } from "./sheets.js";
import { INDICADORES_SHEET, PROJECAO_SHEET, buildResumoRows } from "./derived.js";

export const EXPORT_SCHEMA_VERSION = "6.0.0";

// ============================================================================
// Fase 6.0 (Design Freeze) — GERAÇÃO DO XLSX. Server-side (exceljs), nunca
// no cliente (item 34 do pedido: não engordar o bundle com lib de planilha
// se a geração pode ser 100% no servidor).
//
// SEGURANÇA (item 33): toda célula de texto que começa com = + - @ é
// prefixada com um apóstrofo — mitigação padrão de "formula injection" (o
// mesmo texto exportado hoje pode um dia rodar por um CSV/planilha menos
// cuidadosa; XLSX nativo já trata isso como string literal, mas a
// mitigação é defesa em profundidade barata). Datas/dinheiro/booleanos
// nunca passam por essa checagem — só colunas type:"string".
// ============================================================================

const DANGEROUS_PREFIX_RE = /^[=+\-@]/;
function sanitizeString(v) {
  if (v == null) return null;
  const s = String(v);
  return DANGEROUS_PREFIX_RE.test(s) ? `'${s}` : s;
}

const MONEY_FMT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const DATE_FMT = "dd/mm/yyyy";
const DATETIME_FMT = "dd/mm/yyyy hh:mm";

function writeSheet(workbook, def, rows) {
  const ws = workbook.addWorksheet(def.sheetName.slice(0, 31)); // limite do Excel pro nome da aba
  ws.columns = def.columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(14, c.header.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of rows) {
    const out = {};
    for (const col of def.columns) {
      const raw = row[col.key];
      if (col.type === "string") out[col.key] = sanitizeString(raw);
      else out[col.key] = raw ?? null;
    }
    ws.addRow(out);
  }

  // Tipagem de célula (item 32) — aplicada coluna a coluna, depois das
  // linhas existirem (exceljs não expõe numFmt por-coluna direto no
  // `columns` pra Date de forma confiável em todas as versões).
  def.columns.forEach((col, i) => {
    const excelCol = ws.getColumn(i + 1);
    if (col.type === "money") excelCol.numFmt = MONEY_FMT;
    else if (col.type === "date") excelCol.numFmt = DATE_FMT;
    else if (col.type === "datetime") excelCol.numFmt = DATETIME_FMT;
    else if (col.type === "string" && /id$/i.test(col.key)) excelCol.numFmt = "@"; // força texto — nunca autoconverter um ID
  });

  return ws;
}

function buildDictionaryRows(allDefs) {
  const rows = [];
  for (const def of allDefs) {
    for (const col of def.columns) {
      rows.push({
        sheet: def.sheetName,
        campo: col.header,
        tipo: col.type,
        descricao: `${def.description} — campo "${col.header}"`,
        importavel: def.importable ? "SIM" : "NÃO",
        derivado: def.group === "derived" ? "SIM" : "NÃO",
      });
    }
  }
  return rows;
}

const DICIONARIO_DEF = {
  sheetName: "Dicionário de dados",
  columns: [
    { key: "sheet", header: "Aba", type: "string" },
    { key: "campo", header: "Campo", type: "string" },
    { key: "tipo", header: "Tipo", type: "string" },
    { key: "descricao", header: "Descrição", type: "string" },
    { key: "importavel", header: "Importável", type: "string" },
    { key: "derivado", header: "Derivado", type: "string" },
  ],
};

const RESUMO_DEF = {
  sheetName: "Resumo",
  columns: [
    { key: "geradoEm", header: "Gerado em", type: "datetime" },
    { key: "situacaoFinanceira", header: "Situação financeira", type: "string" },
    { key: "totalSheets", header: "Total de abas", type: "int" },
    { key: "totalLinhas", header: "Total de linhas", type: "int" },
    { key: "schemaVersion", header: "Versão do schema de exportação", type: "string" },
    { key: "periodo", header: "Período", type: "string" },
    { key: "timezone", header: "Fuso horário", type: "string" },
  ],
};

// selectedKeys: null = todas as sheets RAW (default "baixar tudo").
// period: um de PERIODS.
export async function buildExportWorkbook({ selectedKeys = null, period = PERIODS.ALL } = {}) {
  const rawDefs = selectedKeys ? RAW_SHEETS.filter((s) => selectedKeys.includes(s.key)) : RAW_SHEETS;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Norte";
  workbook.created = new Date();

  const { counts, row: resumoRow } = await buildResumoRows({ period });
  const periodLabel = { [PERIODS.ALL]: "Todo o histórico", [PERIODS.LAST_12_MONTHS]: "Últimos 12 meses", [PERIODS.THIS_YEAR]: "Este ano" }[period] ?? period;
  writeSheet(workbook, RESUMO_DEF, [{ ...resumoRow, schemaVersion: EXPORT_SCHEMA_VERSION, periodo: periodLabel, timezone: process.env.APP_TIMEZONE || "America/Sao_Paulo" }]);

  let totalRows = resumoRow.totalLinhas;
  for (const def of rawDefs) {
    const rows = await def.fetch({ period });
    writeSheet(workbook, def, rows);
  }

  const indicadoresRows = await INDICADORES_SHEET.fetch();
  writeSheet(workbook, INDICADORES_SHEET, indicadoresRows);
  const projecaoRows = await PROJECAO_SHEET.fetch();
  writeSheet(workbook, PROJECAO_SHEET, projecaoRows);
  totalRows += indicadoresRows.length + projecaoRows.length;

  const allDefsForDictionary = [RESUMO_DEF, ...RAW_SHEETS, INDICADORES_SHEET, PROJECAO_SHEET];
  writeSheet(workbook, DICIONARIO_DEF, buildDictionaryRows(allDefsForDictionary));

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, sheetCount: allDefsForDictionary.length + 1, rowCount: totalRows, counts };
}

export function exportFileName(now = new Date()) {
  const month = now.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
  return `norte-dados-${month}-${now.getFullYear()}.xlsx`;
}
