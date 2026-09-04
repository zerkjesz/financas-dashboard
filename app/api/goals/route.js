import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listGoals } from "@/lib/goals";
import { deepSerializeMoney } from "@/lib/money";

export async function GET() {
  const goals = await listGoals();
  return NextResponse.json(deepSerializeMoney(goals));
}

export async function POST(request) {
  const body = await request.json();
  const { name, targetAmount, targetDate, notes } = body;

  if (!name || typeof targetAmount !== "number" || targetAmount <= 0) {
    return NextResponse.json({ error: "name e targetAmount são obrigatórios" }, { status: 400 });
  }

  const goal = await prisma.goal.create({
    data: { name, targetAmount, targetDate: targetDate ? new Date(targetDate) : null, notes: notes || null },
  });
  return NextResponse.json(deepSerializeMoney(goal), { status: 201 });
}
