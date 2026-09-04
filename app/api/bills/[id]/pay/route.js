import { NextResponse } from "next/server";
import { markBillPaid } from "@/lib/bills";
import { deepSerializeMoney } from "@/lib/money";
import { isValidConfidence } from "@/lib/dataConfidence";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { accountId, description, confidence } = body;

  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  try {
    const result = await markBillPaid(id, { accountId, description, confidence });
    return NextResponse.json(deepSerializeMoney(result), { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
