import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listCardsWithLimits } from "@/lib/cards";
import { getCardBillView } from "@/lib/cardBillCalculator";
import { getCardCycleForDate } from "@/lib/cardCycle";
import { addMonthKey } from "@/lib/formatMoney";
import { deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";

export async function GET() {
  const cards = await listCardsWithLimits();
  // Fase 4.1.3: GET nunca materializa — getCardBillView devolve a fatura
  // persistida se existir, senão uma PROJEÇÃO em memória (id: null), sem
  // nenhum INSERT/UPDATE. Ciclo ancorado no closingDay real deste cartão (Fase
  // 4.0), igual antes.
  const withBills = await Promise.all(
    cards.map(async (card) => {
      const currentCycle = getCardCycleForDate(card, new Date());
      const nextCycleKey = addMonthKey(currentCycle, 1);
      const [currentBill, nextBill] = await Promise.all([
        getCardBillView(card, currentCycle),
        getCardBillView(card, nextCycleKey),
      ]);
      return { ...card, currentBill, nextBill };
    })
  );
  return NextResponse.json(deepSerializeMoney(withBills));
}

export async function POST(request) {
  const body = await request.json();
  const { slug, name, accountId, totalLimit, closingDay, dueDay, usedLimit, confidence } = body;

  if (!slug || !name || typeof totalLimit !== "number" || typeof dueDay !== "number") {
    return NextResponse.json({ error: "slug, name, totalLimit e dueDay são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  const card = await prisma.card.create({
    data: { slug, name, accountId: accountId || null, totalLimit, closingDay: closingDay ?? null, dueDay },
  });

  if (typeof usedLimit === "number") {
    await prisma.cardLimitUpdate.create({
      data: {
        cardId: card.id,
        newTotalLimit: totalLimit,
        newUsedLimit: usedLimit,
        reportedAvailable: totalLimit - usedLimit,
        source: "manual",
        confidence: resolveConfidence(confidence),
      },
    });
  }

  return NextResponse.json(deepSerializeMoney(card), { status: 201 });
}
