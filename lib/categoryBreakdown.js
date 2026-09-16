// ============================================================================
// Fase 7.0.1, item 2 — "onde gastei mais esse mês?" precisa de um cálculo
// determinístico de verdade, nunca o LLM inventando/estimando o número (o
// LLM só identifica QUERY_FINANCIAL_STATE/topic="category_breakdown" +,
// opcionalmente, qual período — ver lib/telegramAi/pipeline.js).
//
// Período = MÊS CALENDÁRIO (não o ciclo financeiro de cartão, que é um
// conceito por-cartão, nem qualquer ciclo pessoal — este app não tem um
// "ciclo financeiro pessoal" genérico implementado ainda). "Esse mês"/"mês
// passado" em português mapeiam naturalmente pro mês do calendário — a
// interpretação mais direta e menos surpreendente pra esta pergunta
// específica.
// ============================================================================
import { prisma } from "./prisma.js";

function monthRange(monthsBack, now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - monthsBack, 1));
  const end = new Date(Date.UTC(y, m - monthsBack + 1, 1));
  return { start, end };
}

// `periodSpec` vem do plano estruturado (schema-validado): "current_month" |
// "last_month" | {start,end} (datas ISO já resolvidas) | ausente. NUNCA
// lança — período não reconhecível cai no default seguro (mês atual), nunca
// aborta a leitura.
export function resolvePeriod(periodSpec, { now = new Date() } = {}) {
  if (!periodSpec || periodSpec === "current_month") {
    const { start, end } = monthRange(0, now);
    return { start, end, label: "este mês" };
  }
  if (periodSpec === "last_month") {
    const { start, end } = monthRange(1, now);
    return { start, end, label: "mês passado" };
  }
  if (typeof periodSpec === "object" && periodSpec.start && periodSpec.end) {
    const start = new Date(`${periodSpec.start}T00:00:00.000Z`);
    const end = new Date(`${periodSpec.end}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      return { start, end, label: `${periodSpec.start} a ${periodSpec.end}` };
    }
  }
  const { start, end } = monthRange(0, now);
  return { start, end, label: "este mês" };
}

// ZERO WRITE — só leitura de Expense real, soma por categoria. Mesma fonte
// de verdade que qualquer outra leitura financeira do produto (Prisma
// direto, nenhuma fórmula paralela).
export async function computeCategoryBreakdown(periodSpec, { now = new Date(), client = prisma } = {}) {
  const { start, end, label } = resolvePeriod(periodSpec, { now });
  const expenses = await client.expense.findMany({
    where: { occurredAt: { gte: start, lt: end } },
    select: { amount: true, category: true },
  });

  const totals = new Map();
  let grandTotal = 0;
  for (const e of expenses) {
    const amount = Number(e.amount);
    const category = e.category || "Outros";
    totals.set(category, (totals.get(category) || 0) + amount);
    grandTotal += amount;
  }

  const categories = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([category, total]) => ({ category, total }));

  return { start, end, label, grandTotal, categories };
}
