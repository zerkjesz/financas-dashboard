import { NextResponse } from "next/server";
import { buildVaSnapshot } from "@/lib/vaPanel";
import { deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const snapshot = await buildVaSnapshot();
  return NextResponse.json(deepSerializeMoney(snapshot));
}
