import { NextResponse } from "next/server";
import { markBillPaid } from "@/lib/bills";
import { deepSerializeMoney } from "@/lib/money";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { accountId, description } = body;

  try {
    const result = await markBillPaid(id, { accountId, description });
    return NextResponse.json(deepSerializeMoney(result), { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
