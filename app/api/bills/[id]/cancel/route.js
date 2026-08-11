import { NextResponse } from "next/server";
import { cancelBill } from "@/lib/bills";

export async function POST(_request, { params }) {
  const { id } = await params;
  const bill = await cancelBill(id);
  return NextResponse.json(bill);
}
