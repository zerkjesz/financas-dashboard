// ============================================================================
// Fase 5.4D — HISTORY PRESENTATION HELPERS. Pura derivação sobre `entries`
// (income+expense, já compostas em app/api/dashboard/route.js) + `transfers`
// (/api/transfers) — NUNCA recalcula categoria/ciclo/saldo. Ciclo financeiro
// (item 44) já vem pronto de app/api/dashboard/route.js (getCurrentFinancialCycle,
// lib/financialCycle.js) — este arquivo só filtra pelo intervalo já resolvido.
// ============================================================================

// Item 52/53 — Transfer NUNCA é gasto (nunca entra em total de categoria),
// mas card_bill_payment é um movimento financeiro real que o usuário
// reconhece — mostrado como linha própria, tipo "transfer", nunca "expense".
export function cardPaymentTransfersInCycle(transfers, cycleStart) {
  const start = new Date(cycleStart);
  return transfers.filter((t) => t.kind === "card_bill_payment" && new Date(t.occurredAt) >= start);
}

// Item 54 — VA identificado pela origem (accountId da conta food_voucher),
// nunca misturado com unrestrictedCash. Só um marcador de apresentação.
export function isVaOrigin(entry, vaAccountId) {
  return !!vaAccountId && entry.accountId === vaAccountId;
}

// Une entries (income/expense) + transfers de pagamento de fatura numa
// única lista de EXIBIÇÃO — nunca uma tabela de escrita, só apresentação.
// Cada linha carrega `kind` explícito ("income"/"expense"/"transfer") pra
// UI nunca confundir Transfer com gasto (item 52).
export function mergeHistoryRows(entries, cardPaymentTransfers, vaAccountId) {
  const fromEntries = entries.map((e) => ({
    id: e.id,
    kind: e.type, // "income" | "expense"
    description: e.description,
    category: e.category,
    amount: e.amount,
    occurredAt: e.occurredAt,
    origin: e.targetName,
    isVa: isVaOrigin(e, vaAccountId),
  }));
  const fromTransfers = cardPaymentTransfers.map((t) => ({
    id: t.id,
    kind: "transfer",
    description: t.description || "Pagamento de fatura",
    category: null,
    amount: t.amount,
    occurredAt: t.occurredAt,
    origin: t.fromAccount?.name || "—",
    isVa: false,
  }));
  return [...fromEntries, ...fromTransfers].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
}

export function categoryTotals(entries) {
  const totals = new Map();
  let sum = 0;
  for (const e of entries) {
    if (e.type !== "expense") continue;
    totals.set(e.category, (totals.get(e.category) || 0) + e.amount);
    sum += e.amount;
  }
  return { list: Array.from(totals.entries()).sort((a, b) => b[1] - a[1]), total: sum };
}
