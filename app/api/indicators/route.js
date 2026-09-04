import { NextResponse } from "next/server";
import { buildIndicators } from "@/lib/indicators";
import { deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const indicators = await buildIndicators();
  return NextResponse.json(deepSerializeMoney(indicators));
}
