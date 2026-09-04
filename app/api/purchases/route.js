import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listPurchasesWithProgress } from "@/lib/installments";
import { generateInstallmentSchedule } from "@/lib/installments";
import { money, divideMoney, roundMoney, serializeMoney, deepSerializeMoney } from "@/lib/money";
import { resolveConfidence, isValidConfidence } from "@/lib/dataConfidence";
import { getCardCycleForDate } from "@/lib/cardCycle";

export async function GET() {
  const purchases = await listPurchasesWithProgress();
  return NextResponse.json(deepSerializeMoney(purchases));
}

export async function POST(request) {
  const body = await request.json();
  const { description, totalAmount, installmentCount, cardId, category, firstInstallmentMonth, startingInstallmentNumber, confidence } = body;

  if (!description || typeof totalAmount !== "number" || !installmentCount || !cardId) {
    return NextResponse.json({ error: "description, totalAmount, installmentCount e cardId são obrigatórios" }, { status: 400 });
  }
  if (confidence != null && !isValidConfidence(confidence)) {
    return NextResponse.json({ error: `confidence inválida: ${confidence}` }, { status: 400 });
  }

  // Decimal-first na fronteira de entrada (Etapa 8) — mesmo esse cálculo simples
  // (valor nominal da parcela, exibido antes de generateInstallmentSchedule ajustar
  // a última parcela por subtração) evita o ruído de ponto flutuante do JS puro.
  const installmentValue = serializeMoney(roundMoney(divideMoney(money(totalAmount), installmentCount)));

  // Fase 4.0: default de firstInstallmentMonth é o ciclo real DESTE cartão pra
  // "agora" (closingDay-aware), não mais um mês calendário genérico — idêntico ao
  // valor antigo enquanto closingDay continuar null.
  let resolvedFirstInstallmentMonth = firstInstallmentMonth;
  if (!resolvedFirstInstallmentMonth) {
    const card = await prisma.card.findUnique({ where: { id: cardId } });
    if (!card) return NextResponse.json({ error: "cartão não encontrado" }, { status: 404 });
    resolvedFirstInstallmentMonth = getCardCycleForDate(card, new Date());
  }

  const purchase = await prisma.purchase.create({
    data: {
      description,
      totalAmount,
      installmentCount,
      installmentValue,
      category: category || "Outros",
      cardId,
      firstInstallmentMonth: resolvedFirstInstallmentMonth,
      startingInstallmentNumber: startingInstallmentNumber || 1,
      source: "manual",
      confidence: resolveConfidence(confidence),
    },
  });
  await generateInstallmentSchedule(purchase);

  const withInstallments = await prisma.purchase.findUnique({ where: { id: purchase.id }, include: { installments: true } });
  return NextResponse.json(deepSerializeMoney(withInstallments), { status: 201 });
}
