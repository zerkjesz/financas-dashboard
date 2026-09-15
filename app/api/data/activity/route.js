import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Fase 6.0 (Design Freeze) — "Atividade de dados". Read-only, autenticado
// via middleware.js. Cada linha é um DataOperation real (nunca mock) — ver
// lib/dataHub/*.js pra quem grava.
export async function GET() {
  const [operations, undoable] = await Promise.all([
    prisma.dataOperation.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.importBatch.findMany({
      where: { status: "APPLIED", undoDeadline: { gt: new Date() } },
      select: { id: true, fileName: true, mode: true, appliedAt: true, undoDeadline: true },
      orderBy: { appliedAt: "desc" },
    }),
  ]);

  return NextResponse.json({
    operations: operations.map((o) => ({
      id: o.id,
      type: o.type,
      status: o.status,
      mode: o.mode,
      datasets: o.datasets,
      fileName: o.fileName,
      createdCount: o.createdCount,
      updatedCount: o.updatedCount,
      skippedCount: o.skippedCount,
      conflictCount: o.conflictCount,
      deletedCount: o.deletedCount,
      errorMessage: o.errorMessage,
      importBatchId: o.importBatchId,
      createdAt: o.createdAt,
    })),
    undoable, // batchId + prazo — a UI só oferece "Desfazer" pros que estão aqui.
  });
}
