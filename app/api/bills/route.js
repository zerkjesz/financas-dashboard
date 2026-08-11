import { NextResponse } from "next/server";
import { listBills, createBill } from "@/lib/bills";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const bills = await listBills({ status: status ? status.split(",") : undefined });
  return NextResponse.json(bills);
}

export async function POST(request) {
  const body = await request.json();
  const { description, amount, category, accountId, dueDate, notes } = body;

  if (!description || typeof amount !== "number" || amount <= 0 || !dueDate) {
    return NextResponse.json({ error: "description, amount e dueDate são obrigatórios" }, { status: 400 });
  }

  const bill = await createBill({
    description,
    amount,
    category,
    accountId,
    dueDate: new Date(dueDate),
    notes,
    source: "manual",
  });
  return NextResponse.json(bill, { status: 201 });
}
