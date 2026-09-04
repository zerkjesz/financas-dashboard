import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};
  if (typeof body.amount === "number" && body.amount > 0) data.amount = body.amount;
  if (typeof body.category === "string") data.category = body.category;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.accountId === "string") data.accountId = body.accountId;
  if (typeof body.isRecurring === "boolean") data.isRecurring = body.isRecurring;

  const income = await prisma.income.update({ where: { id }, data });
  return NextResponse.json(deepSerializeMoney(income));
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.income.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
