import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listAccountsWithBalances } from "@/lib/accounts";
import { deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function GET() {
  const accounts = await listAccountsWithBalances();
  return NextResponse.json(deepSerializeMoney(accounts));
}

export async function POST(request) {
  const body = await request.json();
  const { slug, name, type, initialBalance, confidence } = body;

  if (!slug || !name || !type) {
    return NextResponse.json({ error: "slug, name e type são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const account = await prisma.account.create({ data: { slug, name, type } });
  if (typeof initialBalance === "number") {
    await prisma.balanceAdjustment.create({
      data: { accountId: account.id, newBalance: initialBalance, source: "manual", note: "Saldo inicial", confidence: resolveConfidence(confidence) },
    });
  }

  return NextResponse.json(account, { status: 201 });
}
