import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const transfers = await prisma.transfer.findMany({
    include: { fromAccount: true, toAccount: true, toCard: true },
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(transfers);
}

export async function POST(request) {
  const body = await request.json();
  const { amount, description, fromAccountId, toAccountId, kind } = body;

  if (typeof amount !== "number" || amount <= 0 || (!fromAccountId && !toAccountId)) {
    return NextResponse.json({ error: "amount e ao menos uma conta são obrigatórios" }, { status: 400 });
  }

  const transfer = await prisma.transfer.create({
    data: {
      amount,
      description: description || "",
      fromAccountId: fromAccountId || null,
      toAccountId: toAccountId || null,
      kind: kind || "generic",
      source: "manual",
    },
  });
  return NextResponse.json(transfer, { status: 201 });
}
