import { NextResponse } from "next/server";
import { payCardBillInFull } from "@/lib/cardBillPayment";
import { DomainError, domainErrorStatus } from "@/lib/domainErrors";

// Fase 10.5 — "Marcar fatura como paga" (quitação INTEGRAL). Mutação autenticada + checagem de origem (middleware.js).
// Pagar fatura NÃO cria Expense: é um Transfer card_bill_payment (conta → cartão) ligado à CardBill. Idempotente: a 2ª chamada
// devolve { status: "ALREADY_PAID" } com 200 e nenhuma alteração financeira.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { cardBillId, cardId, cycleMonth, fromAccountId, paidAt } = body ?? {};
  if (!cardBillId && !(cardId && cycleMonth)) return NextResponse.json({ error: "INVALID", message: "Informe a fatura (cardBillId ou cardId + cycleMonth)." }, { status: 400 });
  try {
    const result = await payCardBillInFull({ cardBillId, cardId, cycleMonth, fromAccountId, paidAt });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const status = domainErrorStatus(err);
    if (status) return NextResponse.json({ error: err.code, message: err.message }, { status });
    console.error("[api/cartoes/fatura/pagar]", err);
    return NextResponse.json({ error: "pay_failed", message: "Não consegui registrar o pagamento — nada foi alterado." }, { status: 500 });
  }
}
