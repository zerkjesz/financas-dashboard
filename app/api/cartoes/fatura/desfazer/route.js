import { NextResponse } from "next/server";
import { undoCardBillPayment } from "@/lib/cardBillPayment";
import { domainErrorStatus } from "@/lib/domainErrors";

// Fase 10.5 — "Desfazer pagamento": só o settlement criado por "Marcar fatura como paga" (e ainda não conciliado com o extrato).
// Reabre a fatura, devolve o valor ao saldo e grava auditoria. Nunca toca em compras, parcelas nem na reconciliação da fatura.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { cardBillId, cardId, cycleMonth } = body ?? {};
  if (!cardBillId && !(cardId && cycleMonth)) return NextResponse.json({ error: "INVALID", message: "Informe a fatura (cardBillId ou cardId + cycleMonth)." }, { status: 400 });
  try {
    return NextResponse.json(await undoCardBillPayment({ cardBillId, cardId, cycleMonth }), { status: 200 });
  } catch (err) {
    const status = domainErrorStatus(err);
    if (status) return NextResponse.json({ error: err.code, message: err.message }, { status });
    console.error("[api/cartoes/fatura/desfazer]", err);
    return NextResponse.json({ error: "undo_failed", message: "Não consegui desfazer o pagamento — nada foi alterado." }, { status: 500 });
  }
}
