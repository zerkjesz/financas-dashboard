import { NextResponse } from "next/server";
import { listBillsForCard } from "@/lib/cardBillCalculator";

export async function GET(_request, { params }) {
  const { id } = await params;
  const bills = await listBillsForCard(id);
  return NextResponse.json(bills);
}
