import { NextResponse } from "next/server";
import { buildFinancialSummary } from "@/lib/intelligence";
import { deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const summary = await buildFinancialSummary();
  return NextResponse.json(deepSerializeMoney(summary));
}
