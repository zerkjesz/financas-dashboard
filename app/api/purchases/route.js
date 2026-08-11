import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listPurchasesWithProgress } from "@/lib/installments";
import { generateInstallmentSchedule } from "@/lib/installments";

export async function GET() {
  const purchases = await listPurchasesWithProgress();
  return NextResponse.json(purchases);
}

export async function POST(request) {
  const body = await request.json();
  const { description, totalAmount, installmentCount, cardId, category, firstInstallmentMonth, startingInstallmentNumber } = body;

  if (!description || typeof totalAmount !== "number" || !installmentCount || !cardId) {
    return NextResponse.json({ error: "description, totalAmount, installmentCount e cardId são obrigatórios" }, { status: 400 });
  }

  const installmentValue = Math.round((totalAmount / installmentCount) * 100) / 100;
  const purchase = await prisma.purchase.create({
    data: {
      description,
      totalAmount,
      installmentCount,
      installmentValue,
      category: category || "Outros",
      cardId,
      firstInstallmentMonth: firstInstallmentMonth || new Date().toISOString().slice(0, 7),
      startingInstallmentNumber: startingInstallmentNumber || 1,
      source: "manual",
    },
  });
  await generateInstallmentSchedule(purchase);

  const withInstallments = await prisma.purchase.findUnique({ where: { id: purchase.id }, include: { installments: true } });
  return NextResponse.json(withInstallments, { status: 201 });
}
