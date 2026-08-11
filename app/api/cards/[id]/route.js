import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.totalLimit === "number") data.totalLimit = body.totalLimit;
  if (body.closingDay === null || typeof body.closingDay === "number") data.closingDay = body.closingDay;
  if (typeof body.dueDay === "number") data.dueDay = body.dueDay;
  if (body.accountId === null || typeof body.accountId === "string") data.accountId = body.accountId;

  const card = await prisma.card.update({ where: { id }, data });
  return NextResponse.json(card);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.card.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
