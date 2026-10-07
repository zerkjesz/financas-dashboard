// Fase 10.3 — leitura ÚNICA (e somente leitura) das abas RAW já recortadas pelo período. Serve ao preview, à contagem e à
// montagem do XLSX: cada aba é lida UMA vez por chamada (nada de contar e depois reler). Zero escrita.
import RAW_SHEETS from "./sheets.js";
import { filterSheetRows, describeRange, resolveRange, EXPORT_DATE_SEMANTICS } from "./range.js";
import { getAppSettings } from "../settings.js";

export async function loadExportData({ range, selectedKeys = null } = {}) {
  const defs = selectedKeys ? RAW_SHEETS.filter((s) => selectedKeys.includes(s.key)) : RAW_SHEETS;
  const sheets = [];
  for (const def of defs) {
    const all = await def.fetch({ period: null }); // sem pré-filtro: a data econômica é aplicada por entidade em filterSheetRows
    const { rows, counts } = filterSheetRows(def.key, all, range);
    sheets.push({ def, rows, counts });
  }
  return { range, sheets };
}

export function summarizeExportData(data) {
  return {
    range: data.range,
    rangeText: describeRange(data.range),
    totalRows: data.sheets.reduce((a, s) => a + s.counts.included, 0),
    sheets: data.sheets.map(({ def, counts }) => ({
      key: def.key,
      sheetName: def.sheetName,
      description: def.description,
      importable: def.importable,
      modes: def.modes || [],
      rowCount: counts.included,
      inRangeCount: counts.inRange,
      globalStateCount: counts.globalState,
      noEventDateCount: counts.noEventDate,
      excludedCount: counts.excluded,
      dateSemantics: EXPORT_DATE_SEMANTICS[def.key]?.note ?? null,
    })),
  };
}

// Resolve o período a partir dos parâmetros da requisição (preset / dateFrom / dateTo). Lê só AppSettings (cycleStartDay) —
// nenhum default silencioso: preset ausente cai no padrão do módulo (Ciclo atual) e o range resolvido SEMPRE volta no payload.
export async function resolveRangeFromParams({ preset, dateFrom, dateTo, now = new Date(), client } = {}) {
  const settings = await getAppSettings(client ? { client } : undefined);
  return resolveRange({ preset: preset || undefined, dateFrom, dateTo, now, settings });
}
