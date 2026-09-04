import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { addToGoal } from "@/lib/goals";
import { deepSerializeMoney } from "@/lib/money";

export async function PATCH(request, { params }) {
  const { id } = await params;
  const body = await request.json();

  if (typeof body.addAmount === "number" && body.addAmount !== 0) {
    const goal = await addToGoal(id, body.addAmount);
    return NextResponse.json(deepSerializeMoney(goal));
  }

  const data = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.targetAmount === "number" && body.targetAmount > 0) data.targetAmount = body.targetAmount;
  if (typeof body.savedAmount === "number") data.savedAmount = body.savedAmount;
  if (body.targetDate === null || body.targetDate) data.targetDate = body.targetDate ? new Date(body.targetDate) : null;
  if (typeof body.notes === "string" || body.notes === null) data.notes = body.notes;

  const goal = await prisma.goal.update({ where: { id }, data });
  return NextResponse.json(deepSerializeMoney(goal));
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  await prisma.goal.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ ok: true });
}
