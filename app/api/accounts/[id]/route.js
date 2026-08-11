import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();
  const data = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.type === "string") data.type = body.type;

  const account = await prisma.account.update({ where: { id }, data });
  return NextResponse.json(account);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.account.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
