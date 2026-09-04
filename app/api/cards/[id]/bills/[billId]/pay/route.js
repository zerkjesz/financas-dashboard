import { NextResponse } from "next/server";
import { payBill } from "@/lib/cardBillCalculator";

export async function POST(request, { params }) {
  const { billId } = await params;
  const body = await request.json();
  const { fromAccountId, amount, description } = body;

  if (!fromAccountId || typeof amount !== "number") {
    return NextResponse.json({ error: "fromAccountId e amount são obrigatórios" }, { status: 400 });
  }

  try {
    const result = await payBill(billId, { fromAccountId, amount, description });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
