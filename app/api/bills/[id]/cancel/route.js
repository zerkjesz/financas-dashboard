import { NextResponse } from "next/server";
import { cancelBill } from "@/lib/bills";
import { deepSerializeMoney } from "@/lib/money";

export async function POST(_request, { params }) {
  const { id } = await params;
  const bill = await cancelBill(id);
  return NextResponse.json(deepSerializeMoney(bill));
}
