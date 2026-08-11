import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listCardsWithLimits } from "@/lib/cards";
import { getOrCreateBill } from "@/lib/cardBillCalculator";

export async function GET() {
  const cards = await listCardsWithLimits();
  const withBills = await Promise.all(
    cards.map(async (card) => {
      const currentCycle = new Date().toISOString().slice(0, 7);
      const nextCycle = new Date();
      nextCycle.setUTCMonth(nextCycle.getUTCMonth() + 1);
      const nextCycleKey = nextCycle.toISOString().slice(0, 7);
      const [currentBill, nextBill] = await Promise.all([
        getOrCreateBill(card.id, currentCycle),
        getOrCreateBill(card.id, nextCycleKey),
      ]);
      return { ...card, currentBill, nextBill };
    })
  );
  return NextResponse.json(withBills);
}

export async function POST(request) {
  const body = await request.json();
  const { slug, name, accountId, totalLimit, closingDay, dueDay, usedLimit } = body;

  if (!slug || !name || typeof totalLimit !== "number" || typeof dueDay !== "number") {
    return NextResponse.json({ error: "slug, name, totalLimit e dueDay são obrigatórios" }, { status: 400 });
  }

  const card = await prisma.card.create({
    data: { slug, name, accountId: accountId || null, totalLimit, closingDay: closingDay ?? null, dueDay },
  });

  if (typeof usedLimit === "number") {
    await prisma.cardLimitUpdate.create({
      data: { cardId: card.id, newTotalLimit: totalLimit, newUsedLimit: usedLimit, reportedAvailable: totalLimit - usedLimit, source: "manual" },
    });
  }

  return NextResponse.json(card, { status: 201 });
}
