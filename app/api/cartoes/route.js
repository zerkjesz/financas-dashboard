import { NextResponse } from "next/server";
import { buildCardsAreaModel } from "@/lib/cardsArea";

// Fase 10 — GET read-only do modelo da área Cartões (Itaú + Caju). Nenhuma escrita.
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return NextResponse.json(await buildCardsAreaModel());
  } catch (error) {
    console.error("[api/cartoes]", error);
    return NextResponse.json({ error: "Não consegui montar a área de Cartões." }, { status: 500 });
  }
}
