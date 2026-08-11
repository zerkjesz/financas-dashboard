import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Somente leitura — arquivo histórico pré-migração. Novos lançamentos usam
// /api/incomes, /api/expenses, /api/transfers, /api/purchases etc.
export async function GET() {
  const transactions = await prisma.legacyTransaction.findMany({
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(transactions);
}
