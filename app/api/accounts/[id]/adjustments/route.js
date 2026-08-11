import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const { newBalance, note } = body;

  if (typeof newBalance !== "number") {
    return NextResponse.json({ error: "newBalance inválido" }, { status: 400 });
  }

  const adjustment = await prisma.balanceAdjustment.create({
    data: { accountId: id, newBalance, note: note || null, source: "manual" },
  });
  return NextResponse.json(adjustment, { status: 201 });
}
