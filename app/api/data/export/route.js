import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildExportWorkbook, exportFileName } from "@/lib/dataHub/export";
import { PERIODS } from "@/lib/dataHub/sheets";

// Fase 6.0 (Design Freeze) — export do Data Hub. Protegida automaticamente
// por middleware.js (rota não está em PUBLIC_PATHS) — sessão obrigatória,
// igual a qualquer outra rota de app/api/**. GET nunca precisa de CSRF
// (middleware só checa em POST/PUT/PATCH/DELETE) — item 35 do pedido:
// "no financial mutation" já é garantido por construção (esta rota nunca
// escreve numa tabela financeira, só LÊ pra montar o arquivo).
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sheetsParam = searchParams.get("sheets");
  const selectedKeys = sheetsParam ? sheetsParam.split(",").filter(Boolean) : null;
  const periodParam = searchParams.get("period");
  const period = Object.values(PERIODS).includes(periodParam) ? periodParam : PERIODS.ALL;

  let buffer, sheetCount, rowCount;
  try {
    ({ buffer, sheetCount, rowCount } = await buildExportWorkbook({ selectedKeys, period }));
  } catch (err) {
    console.error("[api/data/export] falha ao montar a planilha:", err.message);
    await prisma.dataOperation
      .create({ data: { type: "EXPORT", status: "FAILED", datasets: selectedKeys || [], errorMessage: "Falha ao montar a planilha." } })
      .catch(() => {});
    return NextResponse.json({ error: "export_failed" }, { status: 500 });
  }

  const fileName = exportFileName();
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

  await prisma.dataOperation
    .create({
      data: {
        type: "EXPORT",
        status: "SUCCESS",
        datasets: selectedKeys || ["__all__"],
        fileName,
        fileHash,
        createdCount: rowCount,
      },
    })
    .catch((err) => console.error("[api/data/export] falha ao registrar atividade (não bloqueia o download):", err.message));

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(buffer.length),
      // Nunca cache público — o arquivo contém dado financeiro do usuário.
      "Cache-Control": "private, no-store",
      "X-Sheet-Count": String(sheetCount),
      "X-Row-Count": String(rowCount),
    },
  });
}
