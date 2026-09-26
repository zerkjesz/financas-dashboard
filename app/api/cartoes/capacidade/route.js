import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildItauModel } from "@/lib/cardsItau";
import { getCapacityContext, evaluatePurchase, computeBudgetCaps, PURCHASE_OPTIONS } from "@/lib/cardPurchaseCapacity";

// Fase 10 — "Se eu comprar algo hoje". READ-ONLY (simulação pura, ZERO escrita):
//   GET  -> capacidade de orçamento por parcelamento (busca determinística sobre o MESMO simulador do /simulador)
//   POST -> avaliação detalhada de UMA compra { amount, installments }
export const dynamic = "force-dynamic";

async function load() {
  const itau = await buildItauModel();
  if (!itau) return null;
  const context = await getCapacityContext({ cardId: itau.card.id });
  return { itau, context };
}

export async function GET() {
  try {
    const base = await load();
    if (!base) return NextResponse.json({ error: "Nenhum cartão cadastrado." }, { status: 404 });
    const { itau, context } = base;
    const caps = await computeBudgetCaps({ cardId: itau.card.id, knowledge: itau.limit, context, hi: itau.limit.total });
    return NextResponse.json({ options: PURCHASE_OPTIONS, budgetCaps: caps, limit: { low: itau.limit.estimate.low, high: itau.limit.estimate.high, ceiling: itau.limit.ceilingAvailable }, baseline: { freeMoney: Number(context.baselineEngine.freeMoney.toString()), status: context.baselineEngine.status.status } });
  } catch (error) {
    console.error("[api/cartoes/capacidade GET]", error);
    return NextResponse.json({ error: "Não consegui calcular a capacidade de compra." }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const amount = Number(body.amount);
    const installments = Number(body.installments ?? 1);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return NextResponse.json({ error: "Valor inválido." }, { status: 400 });
    if (!Number.isInteger(installments) || installments < 1 || installments > 60) return NextResponse.json({ error: "Número de parcelas inválido." }, { status: 400 });
    const base = await load();
    if (!base) return NextResponse.json({ error: "Nenhum cartão cadastrado." }, { status: 404 });
    const result = await evaluatePurchase({ cardId: base.itau.card.id, amount, installments, knowledge: base.itau.limit, client: prisma, context: base.context });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[api/cartoes/capacidade POST]", error);
    return NextResponse.json({ error: "Não consegui simular esta compra." }, { status: 500 });
  }
}
