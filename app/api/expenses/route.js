import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function GET() {
  const expenses = await prisma.expense.findMany({
    include: { account: true, card: true },
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(deepSerializeMoney(expenses));
}

export async function POST(request) {
  const body = await request.json();
  const { amount, description, category, accountId, cardId, isRecurring, occurredAt, confidence } = body;

  if (typeof amount !== "number" || amount <= 0 || (!accountId && !cardId)) {
    return NextResponse.json({ error: "amount e (accountId ou cardId) são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const expense = await prisma.expense.create({
    data: {
      amount,
      description: description || "",
      category: category || "Outros",
      accountId: accountId || null,
      cardId: cardId || null,
      isRecurring: Boolean(isRecurring),
      source: "manual",
      confidence: resolveConfidence(confidence),
      occurredAt: occurredAt ? new Date(occurredAt) : undefined,
    },
  });
  return NextResponse.json(deepSerializeMoney(expense), { status: 201 });
}
