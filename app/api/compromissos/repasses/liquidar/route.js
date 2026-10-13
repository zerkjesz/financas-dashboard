import { NextResponse } from "next/server";
import { settleInternalReimbursement } from "@/lib/internalReimbursement";
import { domainErrorStatus } from "@/lib/domainErrors";

// Fase 10.6 — "Marcar repasse como feito" (Repasses do Caju). Mutação autenticada + checagem de origem (middleware.js).
// Cria UM Transfer Caju → Itaú (nunca Income/Expense) e fecha o repasse. Idempotente: a 2ª chamada devolve { status: "ALREADY_SETTLED" }
// com 200 e nenhuma alteração financeira.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { id } = body ?? {};
  if (!id) return NextResponse.json({ error: "INVALID", message: "Informe o repasse." }, { status: 400 });
  try {
    return NextResponse.json(await settleInternalReimbursement({ id }), { status: 200 });
  } catch (err) {
    const status = domainErrorStatus(err);
    if (status) return NextResponse.json({ error: err.code, message: err.message }, { status });
    console.error("[api/compromissos/repasses/liquidar]", err);
    return NextResponse.json({ error: "settle_failed", message: "Não consegui registrar o repasse — nada foi alterado." }, { status: 500 });
  }
}
