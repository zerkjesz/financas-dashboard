"use client";

import { Search, Receipt, ArrowRightLeft, UtensilsCrossed, Car, Home, HeartPulse, PartyPopper, Briefcase } from "lucide-react";
import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (restyle Histórico) — lista agrupada por dia calendário (dado real:
// `row.occurredAt`, vindo de lib/historyPresentation.js). Cada grupo é um card
// branco próprio (design aprovado), com um total do dia e as linhas dentro.
//
// Ícone por categoria — mapeamento de apresentação (não é dado real, é
// julgamento visual): mesmas 7 categorias de lib/categoryRules.js. Transfer
// (pagamento de fatura) sempre usa ArrowRightLeft, categoria ausente/"Outros"
// cai em Receipt (ícone genérico).
const CATEGORY_ICONS = {
  "Alimentação": UtensilsCrossed,
  "Transporte": Car,
  "Moradia": Home,
  "Saúde": HeartPulse,
  "Lazer": PartyPopper,
  "Trabalho": Briefcase,
  "Outros": Receipt,
};

function rowIcon(row) {
  if (row.kind === "transfer") return ArrowRightLeft;
  return CATEGORY_ICONS[row.category] || Receipt;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Labels relativos calculados de verdade a partir de `occurredAt` (nunca
// hardcoded) — comparação em dia LOCAL (não UTC), coerente com o comentário
// de lib/formatMoney.js sobre occurredAt ser timestamp real.
function dayLabel(date) {
  const d = startOfLocalDay(date);
  const today = startOfLocalDay(new Date());
  const diffDays = Math.round((today - d) / 86400000);
  const datePart = new Date(date).toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
  if (diffDays === 0) return `Hoje, ${datePart}`;
  if (diffDays === 1) return `Ontem, ${datePart}`;
  return datePart;
}

function groupByDay(rows) {
  const order = [];
  const map = new Map();
  for (const row of rows) {
    const key = startOfLocalDay(row.occurredAt).getTime();
    if (!map.has(key)) {
      map.set(key, { key, occurredAt: row.occurredAt, rows: [] });
      order.push(key);
    }
    map.get(key).rows.push(row);
  }
  return order.map((key) => map.get(key));
}

// Total do dia: income soma, expense subtrai, transfer (pagamento de fatura)
// nunca conta — mesma regra de categoryTotals em lib/historyPresentation.js.
function dayTotal(rows) {
  return rows.reduce((sum, r) => {
    if (r.kind === "income") return sum + r.amount;
    if (r.kind === "expense") return sum - r.amount;
    return sum;
  }, 0);
}

export default function TransactionList({ rows }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-card bg-surface shadow-card p-10 flex flex-col items-center text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-tile bg-surface-3">
          <Search className="h-5 w-5 text-text-muted" aria-hidden="true" />
        </div>
        <p className="text-section-title text-text-primary mb-1">Nada por aqui</p>
        <p className="text-caption text-text-secondary">Tente outra palavra ou tire os filtros.</p>
      </div>
    );
  }

  const groups = groupByDay(rows);

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const total = dayTotal(group.rows);
        return (
          <div key={group.key} className="rounded-card bg-surface shadow-card p-6">
            <div className="flex items-baseline justify-between gap-3 mb-3">
              <span className="text-eyebrow text-text-muted">{dayLabel(group.occurredAt)}</span>
              <span className="tabular text-sm text-text-muted">
                {total > 0 ? "+" : total < 0 ? "-" : ""}
                {formatMoney(Math.abs(total))}
              </span>
            </div>
            <div className="divide-y divide-border-subtle">
              {group.rows.map((row) => {
                const Icon = rowIcon(row);
                // Sub-label real: categoria + origem (conta/cartão) já vêm
                // prontos de lib/historyPresentation.js (row.category,
                // row.origin) — nunca um enum técnico cru (item 51 legado).
                const subLabel = row.category
                  ? `${row.category} · ${row.origin}`
                  : row.kind === "transfer"
                    ? `Pagamento de fatura · ${row.origin}`
                    : row.origin;
                return (
                  <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-surface-3">
                        <Icon className="h-4 w-4 text-text-secondary" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {row.isVa && <UtensilsCrossed className="h-3 w-3 shrink-0 text-text-muted" aria-hidden="true" />}
                          <span className="truncate text-sm text-text-body">{row.description}</span>
                        </div>
                        <div className="truncate text-caption text-text-muted">{subLabel}</div>
                      </div>
                    </div>
                    {/* Única ocorrência de text-positive (verde) no app inteiro —
                        exclusivo de receita nesta lista, per design. Transfer
                        (pagamento de fatura) usa o mesmo tom neutro de despesa,
                        nunca um terceiro tom — simplificação deliberada em
                        relação ao "text-restricted" que existia aqui antes. */}
                    <span className={`tabular shrink-0 text-sm font-medium ${row.kind === "income" ? "text-positive" : "text-text-body"}`}>
                      {row.kind === "income" ? "+" : row.kind === "transfer" ? "" : "-"}
                      {formatMoney(row.amount)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
