import { NextResponse } from "next/server";
import { buildIndicators } from "@/lib/indicators";

export async function GET() {
  const indicators = await buildIndicators();
  return NextResponse.json(indicators);
}
