import { NextResponse } from "next/server";
import RAW_SHEETS, { PERIODS } from "@/lib/dataHub/sheets";
import { buildResumoRows } from "@/lib/dataHub/derived";

// Fase 6.0 (Design Freeze) — catálogo de sheets + contagem REAL de linhas
// (nunca um número mock) pro seletor "O que vem dentro" da tela Dados.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const periodParam = searchParams.get("period");
  const period = Object.values(PERIODS).includes(periodParam) ? periodParam : PERIODS.ALL;

  const { counts } = await buildResumoRows({ period });

  const sheets = RAW_SHEETS.map((s) => ({
    key: s.key,
    sheetName: s.sheetName,
    description: s.description,
    importable: s.importable,
    modes: s.modes || [],
    rowCount: counts[s.sheetName] ?? 0,
  }));

  return NextResponse.json({ sheets, period, periods: Object.values(PERIODS) });
}
