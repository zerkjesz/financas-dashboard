import { NextResponse } from "next/server";
import { payBill, getOrCreateBill } from "@/lib/cardBillCalculator";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";
import { isValidConfidence } from "@/lib/dataConfidence";

// Fase 4.1.3: pagar é uma MUTAÇÃO explícita — pode legitimamente materializar
// a CardBill se o frontend só tinha uma fatura PROJECTED (id: null, ver
// lib/cardBillCalculator.js:getCardBillView). Como o `billId` da URL pode não
// corresponder a nenhuma row real, o body carrega `cardId`+`cycleMonth` como
// fallback pra resolver/criar a fatura antes de pagar — nunca faz isso a partir
// de um GET/render.
export async function POST(request, { params }) {
  const { id: cardId, billId } = await params;
  const body = await request.json();
  const { fromAccountId, amount, description, confidence, cycleMonth } = body;

  if (!fromAccountId || typeof amount !== "number") {
    return NextResponse.json({ error: "fromAccountId e amount são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  try {
    let resolvedBillId = billId;
    const existing = billId && billId !== "projected" ? await prisma.cardBill.findUnique({ where: { id: billId } }) : null;
    if (!existing) {
      if (!cardId || !cycleMonth) {
        return NextResponse.json({ error: "Fatura ainda não existe — informe cardId e cycleMonth para materializá-la" }, { status: 400 });
      }
      const materialized = await getOrCreateBill(cardId, cycleMonth);
      resolvedBillId = materialized.id;
    }

    const result = await payBill(resolvedBillId, { fromAccountId, amount, description, confidence });
    return NextResponse.json(deepSerializeMoney(result), { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
