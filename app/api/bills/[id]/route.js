import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.amount === "number" && body.amount > 0) data.amount = body.amount;
  if (typeof body.category === "string") data.category = body.category;
  if (body.accountId === null || typeof body.accountId === "string") data.accountId = body.accountId;
  if (body.dueDate) data.dueDate = new Date(body.dueDate);
  if (typeof body.notes === "string" || body.notes === null) data.notes = body.notes;

  const bill = await prisma.bill.update({ where: { id }, data });
  return NextResponse.json(bill);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.bill.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
