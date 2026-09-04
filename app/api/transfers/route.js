import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function GET() {
  const transfers = await prisma.transfer.findMany({
    include: { fromAccount: true, toAccount: true, toCard: true },
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(deepSerializeMoney(transfers));
}

export async function POST(request) {
  const body = await request.json();
  const { amount, description, fromAccountId, toAccountId, kind, confidence } = body;

  if (typeof amount !== "number" || amount <= 0 || (!fromAccountId && !toAccountId)) {
    return NextResponse.json({ error: "amount e ao menos uma conta são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const transfer = await prisma.transfer.create({
    data: {
      amount,
      description: description || "",
      fromAccountId: fromAccountId || null,
      toAccountId: toAccountId || null,
      kind: kind || "generic",
      source: "manual",
      confidence: resolveConfidence(confidence),
    },
  });
  return NextResponse.json(deepSerializeMoney(transfer), { status: 201 });
}
