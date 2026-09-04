import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { maxMoney, subtractMoney, money, ZERO, serializeMoney, deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const { reportedAvailable, newTotalLimit, note, confidence } = body;

  if (typeof reportedAvailable !== "number") {
    return NextResponse.json({ error: "reportedAvailable inválido" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const card = await prisma.card.findUnique({ where: { id } });
  if (!card) return NextResponse.json({ error: "cartão não encontrado" }, { status: 404 });

  // card.totalLimit já vem como Decimal do Prisma — nunca usar `-` nativo nele
  // (Fase 3.1). newTotalLimit é number cru vindo do body (fronteira de entrada).
  const totalLimit = newTotalLimit != null ? money(newTotalLimit) : card.totalLimit;
  const newUsedLimit = maxMoney(ZERO, subtractMoney(totalLimit, reportedAvailable));
  const limitUpdate = await prisma.cardLimitUpdate.create({
    data: {
      cardId: id,
      newTotalLimit: newTotalLimit ?? null,
      newUsedLimit: serializeMoney(newUsedLimit),
      reportedAvailable,
      note: note || null,
      source: "manual",
      confidence: resolveConfidence(confidence),
    },
  });
  return NextResponse.json(deepSerializeMoney(limitUpdate), { status: 201 });
}
