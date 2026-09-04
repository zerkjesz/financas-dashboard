import { NextResponse } from "next/server";
import { listCardBillsView } from "@/lib/cardBillCalculator";
import { deepSerializeMoney } from "@/lib/money";

// Fase 4.1.3: read-only — listCardBillsView nunca materializa (persisted +
// projected em memória, id: null pras projetadas).
export async function GET(_request, { params }) {
  const { id } = await params;
  const bills = await listCardBillsView(id);
  return NextResponse.json(deepSerializeMoney(bills));
}
