import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const incomes = await prisma.income.findMany({
    include: { account: true },
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(deepSerializeMoney(incomes));
}

export async function POST(request) {
  const body = await request.json();
  const { amount, description, category, accountId, isRecurring, occurredAt } = body;

  if (typeof amount !== "number" || amount <= 0 || !accountId) {
    return NextResponse.json({ error: "amount e accountId são obrigatórios" }, { status: 400 });
  }

  const income = await prisma.income.create({
    data: {
      amount,
      description: description || "",
      category: category || "Outros",
      accountId,
      isRecurring: Boolean(isRecurring),
      source: "manual",
      occurredAt: occurredAt ? new Date(occurredAt) : undefined,
    },
  });
  return NextResponse.json(deepSerializeMoney(income), { status: 201 });
}
