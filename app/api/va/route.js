import { NextResponse } from "next/server";
import { buildVaSnapshot } from "@/lib/vaPanel";

export async function GET() {
  const snapshot = await buildVaSnapshot();
  return NextResponse.json(snapshot);
}
