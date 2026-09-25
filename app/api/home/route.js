import { NextResponse } from "next/server";
import { buildHomeModel } from "@/lib/homeModel";

// Fase 9.1 — SOMENTE LEITURA.
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return NextResponse.json(await buildHomeModel());
  } catch (err) {
    console.error("[api/home] erro:", err.message);
    return NextResponse.json({ error: "Não consegui carregar a Home." }, { status: 500 });
  }
}
