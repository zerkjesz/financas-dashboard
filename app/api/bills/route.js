import { NextResponse } from "next/server";
import { listBills, createBill } from "@/lib/bills";
import { deepSerializeMoney } from "@/lib/money";
import { isValidConfidence } from "@/lib/dataConfidence";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const bills = await listBills({ status: status ? status.split(",") : undefined });
  return NextResponse.json(deepSerializeMoney(bills));
}

export async function POST(request) {
  const body = await request.json();
  const { description, amount, category, accountId, dueDate, notes, confidence } = body;

  if (!description || typeof amount !== "number" || amount <= 0 || !dueDate) {
    return NextResponse.json({ error: "description, amount e dueDate são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const bill = await createBill({
    description,
    amount,
    category,
    accountId,
    dueDate: new Date(dueDate),
    notes,
    source: "manual",
    confidence,
  });
  return NextResponse.json(deepSerializeMoney(bill), { status: 201 });
}
