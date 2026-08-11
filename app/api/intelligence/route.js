import { NextResponse } from "next/server";
import { buildFinancialSummary } from "@/lib/intelligence";

export async function GET() {
  const summary = await buildFinancialSummary();
  return NextResponse.json(summary);
}
