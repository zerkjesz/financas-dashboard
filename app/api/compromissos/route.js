import { NextResponse } from "next/server";
import { buildCommitmentsModel } from "@/lib/compromissosModel";

// Fase 9.1 — SOMENTE LEITURA (nenhum INSERT/UPDATE em GET; contas da casa são projetadas em memória).
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return NextResponse.json(await buildCommitmentsModel());
  } catch (err) {
    console.error("[api/compromissos] erro:", err.message);
    return NextResponse.json({ error: "Não consegui carregar os compromissos." }, { status: 500 });
  }
}
