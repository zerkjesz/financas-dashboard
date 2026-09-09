"use client";

import { useState } from "react";
import { ArrowRightLeft, UtensilsCrossed } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

const KIND_TONE = { income: "text-positive", expense: "text-text-primary", transfer: "text-restricted" };

// Fase 5.4D, itens 50-54 — UMA lista responsiva (linhas, não uma <table>
// literal — mesma gramática já usada em SpendingSection/BillsManager,
// item 57 consistência visual) em vez de tabela desktop + cards mobile
// duplicados. Income/Expense/Transfer distinguíveis por cor+label (nunca só
// cor — item 52); Transfer de pagamento de fatura NUNCA soma em total de
// categoria (já garantido em lib/historyPresentation.js, aqui só exibe).
// VA marcado com ícone (item 54) sem misturar com unrestrictedCash. Expandir
// uma linha só mostra origem/conta — nunca id técnico/enum cru (item 51).
export default function TransactionList({ rows, categoryFilter }) {
  const [expandedId, setExpandedId] = useState(null);

  if (rows.length === 0) {
    return (
      <div className="rounded-card bg-surface-1 p-6">
        <h2 className="text-label text-text-muted mb-2">Transações</h2>
        <p className="text-body text-text-muted">{categoryFilter ? `Nenhum lançamento em "${categoryFilter}" neste ciclo.` : "Nenhum lançamento neste ciclo ainda."}</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">{categoryFilter ? `Transações — ${categoryFilter}` : "Transações (ciclo atual)"}</h2>
      <div className="divide-y divide-border-subtle">
        {rows.map((row) => {
          const expanded = expandedId === row.id;
          return (
            <div key={row.id}>
              <button onClick={() => setExpandedId(expanded ? null : row.id)} aria-expanded={expanded} className="focus-ring flex w-full items-center justify-between gap-3 py-2.5 text-left cursor-pointer">
                <div className="min-w-0 flex items-center gap-2">
                  {row.isVa && <UtensilsCrossed className="h-3.5 w-3.5 shrink-0 text-restricted" aria-hidden="true" />}
                  {row.kind === "transfer" && <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-restricted" aria-hidden="true" />}
                  <div className="min-w-0">
                    <div className="truncate text-sm text-text-secondary">{row.description}</div>
                    <div className="text-caption text-text-muted">
                      {formatDate(row.occurredAt)}
                      {row.category ? ` · ${row.category}` : row.kind === "transfer" ? " · pagamento de fatura" : ""}
                    </div>
                  </div>
                </div>
                <span className={`tabular shrink-0 text-sm font-medium ${KIND_TONE[row.kind]}`}>
                  {row.kind === "income" ? "+" : row.kind === "transfer" ? "" : "-"}
                  {formatMoney(row.amount)}
                </span>
              </button>
              {expanded && (
                <div className="pb-2.5 pl-0 text-caption text-text-muted">
                  origem: {row.origin} {row.isVa && "· vale alimentação (uso restrito)"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
