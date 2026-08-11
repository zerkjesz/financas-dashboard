import { NextResponse } from "next/server";
import { buildAlerts } from "@/lib/alerts";

export async function GET() {
  const alerts = await buildAlerts();
  return NextResponse.json(alerts);
}
