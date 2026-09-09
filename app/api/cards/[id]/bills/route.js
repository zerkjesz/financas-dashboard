import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listCardBillsView, computeExpectedCardBillTotal } from "@/lib/cardBillCalculator";
import { subtractMoney, isPositive } from "@/lib/money";
import { deepSerializeMoney } from "@/lib/money";

// Fase 4.1.3: read-only — listCardBillsView nunca materializa (persisted +
// projected em memória, id: null pras projetadas).
//
// Fase 5.4D, itens 15/16 — KNOWN CARD DETAIL GAP, campo ADITIVO só de
// apresentação: `bill.totalAmount` (autoritativo — snapshot bancário
// reconciliado nas Fases 5.1D-5.2D pra faturas já fechadas, ou soma ao vivo
// de Expense+Installment pra faturas abertas) NUNCA é sobrescrito aqui.
// `knownDetailTotal` é computado com a MESMA função que já soma os line
// items persistidos (computeExpectedCardBillTotal — nenhuma fórmula nova) e
// só existe pra UI decidir se mostra o aviso de detalhamento parcial —
// nunca gravado no banco, nunca usado no lugar de totalAmount em nenhum
// cálculo financeiro real.
export async function GET(_request, { params }) {
  const { id } = await params;
  const card = await prisma.card.findUnique({ where: { id } });
  if (!card) return NextResponse.json({ error: "Cartão não encontrado" }, { status: 404 });

  const bills = await listCardBillsView(id);
  const withGap = await Promise.all(
    bills.map(async (bill) => {
      const knownDetailTotal = await computeExpectedCardBillTotal(card, bill.cycleMonth);
      const undetailedAmount = subtractMoney(bill.totalAmount, knownDetailTotal);
      return {
        ...bill,
        knownDetailTotal,
        // Só reporta gap quando o autoritativo excede o detalhamento conhecido
        // (a direção oposta — detalhamento > autoritativo — não é um "gap",
        // é só arredondamento/timing de query, nunca vira aviso pro usuário).
        hasDetailGap: isPositive(undetailedAmount),
        undetailedAmount: isPositive(undetailedAmount) ? undetailedAmount : null,
      };
    })
  );
  return NextResponse.json(deepSerializeMoney(withGap));
}
