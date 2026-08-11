import { NextResponse } from "next/server";
import { buildCashFlowProjection, HORIZON_OPTIONS } from "@/lib/cashFlowProjection";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const daysParam = parseInt(searchParams.get("days"), 10);
  const horizonDays = HORIZON_OPTIONS.includes(daysParam) ? daysParam : undefined;
  const projection = await buildCashFlowProjection(horizonDays ? { horizonDays } : {});
  return NextResponse.json(projection);
}
