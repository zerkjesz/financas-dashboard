import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const incomes = await prisma.income.findMany({
    include: { account: true },
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(incomes);
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
  return NextResponse.json(income, { status: 201 });
}
