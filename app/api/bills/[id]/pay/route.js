import { NextResponse } from "next/server";
import { markBillPaid } from "@/lib/bills";

export async function POST(request, { params }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const { accountId, description } = body;

  try {
    const result = await markBillPaid(id, { accountId, description });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
