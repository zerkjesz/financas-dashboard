import { NextResponse } from "next/server";
import { buildCashFlowProjection } from "@/lib/cashFlowProjection";

export async function GET() {
  const projection = await buildCashFlowProjection();
  return NextResponse.json(projection);
}
