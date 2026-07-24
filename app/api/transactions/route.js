import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const transactions = await prisma.transaction.findMany({
    orderBy: { occurredAt: "desc" },
  });
  return NextResponse.json(transactions);
}

export async function POST(request) {
  const body = await request.json();
  const { type, amount, category, description, paymentMethod, isRecurring, installmentCurrent, installmentTotal } = body;

  if (!type || !["income", "expense"].includes(type)) {
    return NextResponse.json({ error: "type inválido" }, { status: 400 });
  }
  if (typeof amount !== "number" || amount <= 0) {
    return NextResponse.json({ error: "amount inválido" }, { status: 400 });
  }

  const transaction = await prisma.transaction.create({
    data: {
      type,
      amount,
      category: category || "Outros",
      paymentMethod: paymentMethod || null,
      isRecurring: Boolean(isRecurring),
      installmentCurrent: Number.isInteger(installmentCurrent) ? installmentCurrent : null,
      installmentTotal: Number.isInteger(installmentTotal) ? installmentTotal : null,
      description: description || "",
      rawMessage: description || "",
      source: "manual",
    },
  });

  return NextResponse.json(transaction, { status: 201 });
}

export async function DELETE(request) {
  const body = await request.json().catch(() => ({}));
  const { ids, all } = body;

  if (all) {
    const { count } = await prisma.transaction.deleteMany({});
    return NextResponse.json({ deleted: count });
  }

  if (Array.isArray(ids) && ids.length > 0) {
    const { count } = await prisma.transaction.deleteMany({ where: { id: { in: ids } } });
    return NextResponse.json({ deleted: count });
  }

  return NextResponse.json({ error: "informe ids ou all" }, { status: 400 });
}
