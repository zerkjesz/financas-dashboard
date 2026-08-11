import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_request, { params }) {
  const { id } = await params;
  const purchase = await prisma.purchase.findUnique({
    where: { id },
    include: { installments: { orderBy: { number: "asc" } }, card: true },
  });
  if (!purchase) return NextResponse.json({ error: "não encontrada" }, { status: 404 });
  return NextResponse.json(purchase);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.purchase.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
