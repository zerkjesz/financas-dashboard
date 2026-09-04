import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const { newBalance, note, confidence } = body;

  if (typeof newBalance !== "number") {
    return NextResponse.json({ error: "newBalance inválido" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const adjustment = await prisma.balanceAdjustment.create({
    data: { accountId: id, newBalance, note: note || null, source: "manual", confidence: resolveConfidence(confidence) },
  });
  return NextResponse.json(deepSerializeMoney(adjustment), { status: 201 });
}
