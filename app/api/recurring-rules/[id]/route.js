import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepSerializeMoney } from "@/lib/money";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.amount === "number" || body.amount === null) data.amount = body.amount;
  if (typeof body.dayOfMonth === "number") data.dayOfMonth = body.dayOfMonth;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (typeof body.category === "string" || body.category === null) data.category = body.category;

  const rule = await prisma.recurringRule.update({ where: { id }, data });
  return NextResponse.json(deepSerializeMoney(rule));
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.recurringRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
