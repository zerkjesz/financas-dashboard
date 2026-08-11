import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const { reportedAvailable, newTotalLimit, note } = body;

  if (typeof reportedAvailable !== "number") {
    return NextResponse.json({ error: "reportedAvailable inválido" }, { status: 400 });
  }

  const card = await prisma.card.findUnique({ where: { id } });
  if (!card) return NextResponse.json({ error: "cartão não encontrado" }, { status: 404 });

  const totalLimit = newTotalLimit ?? card.totalLimit;
  const limitUpdate = await prisma.cardLimitUpdate.create({
    data: {
      cardId: id,
      newTotalLimit: newTotalLimit ?? null,
      newUsedLimit: Math.max(0, totalLimit - reportedAvailable),
      reportedAvailable,
      note: note || null,
      source: "manual",
    },
  });
  return NextResponse.json(limitUpdate, { status: 201 });
}
