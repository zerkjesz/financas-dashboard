import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};

  if (body.type && ["income", "expense"].includes(body.type)) data.type = body.type;
  if (typeof body.amount === "number" && body.amount > 0) data.amount = body.amount;
  if (typeof body.category === "string") data.category = body.category;
  if (typeof body.description === "string") data.description = body.description;
  if (body.paymentMethod === null || typeof body.paymentMethod === "string") data.paymentMethod = body.paymentMethod;
  if (typeof body.isRecurring === "boolean") data.isRecurring = body.isRecurring;

  const transaction = await prisma.transaction.update({ where: { id }, data });
  return NextResponse.json(transaction);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.transaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
