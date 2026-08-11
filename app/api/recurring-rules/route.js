import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rules = await prisma.recurringRule.findMany({ orderBy: { dayOfMonth: "asc" } });
  return NextResponse.json(rules);
}

export async function POST(request) {
  const body = await request.json();
  const { name, kind, amount, dayOfMonth, accountId, category } = body;

  if (!name || !["income", "expense"].includes(kind) || !dayOfMonth) {
    return NextResponse.json({ error: "name, kind e dayOfMonth são obrigatórios" }, { status: 400 });
  }

  const rule = await prisma.recurringRule.create({
    data: {
      name,
      kind,
      amount: typeof amount === "number" ? amount : null,
      dayOfMonth,
      accountId: accountId || null,
      category: category || null,
    },
  });
  return NextResponse.json(rule, { status: 201 });
}
