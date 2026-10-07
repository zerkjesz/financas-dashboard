import { NextResponse } from "next/server";
import { loadExportData, summarizeExportData, resolveRangeFromParams } from "@/lib/dataHub/exportData";
import { DataRangeError } from "@/lib/dataHub/range";

// Fase 10.3 — PREVIEW do export. Estritamente somente leitura: não grava DataOperation, não materializa Bill, não toca
// updatedAt. Devolve o período RESOLVIDO (datas reais) e as contagens por entidade exatamente como o arquivo as levaria.
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sheetsParam = searchParams.get("sheets");
  const selectedKeys = sheetsParam ? sheetsParam.split(",").filter(Boolean) : null;
  try {
    const range = await resolveRangeFromParams({ preset: searchParams.get("preset"), dateFrom: searchParams.get("dateFrom"), dateTo: searchParams.get("dateTo") });
    const data = await loadExportData({ range, selectedKeys });
    return NextResponse.json(summarizeExportData(data), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof DataRangeError) return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
    console.error("[api/data/export/preview] falha:", err.message);
    return NextResponse.json({ error: "preview_failed" }, { status: 500 });
  }
}
