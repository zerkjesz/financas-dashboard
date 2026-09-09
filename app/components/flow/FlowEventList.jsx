"use client";

import { formatMoney, formatDate } from "@/lib/formatMoney";

const KIND_LABEL = {
  recurring_income: "Receita",
  bill: "Conta",
  card_bill: "Fatura",
  external_installment: "Parcela externa",
  external_installment_window: "Parcelas externas (janela)",
  confirmed_commitment: "Compromisso confirmado",
  contingency: "Risco (contingência)",
};

// Fase 5.4D, itens 9/41 — fallback textual SEMPRE visível (nunca só dentro
// do <title> do SVG) — mobile não depende de hover, e leitor de tela recebe
// a mesma informação de um jeito nativo. Cada evento aqui é o MESMO ponto
// já desenhado no FlowChart — nunca uma segunda lista com números
// diferentes.
export default function FlowEventList({ startingBalance, timeline, horizonDays, projectedBalance }) {
  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">Eventos da trajetória</h2>
      <div className="divide-y divide-border-subtle">
        <EventRow label="Hoje" value={formatMoney(startingBalance)} highlight />
        {timeline.length === 0 && <p className="text-body text-text-muted py-3">Nenhuma conta, fatura ou receita prevista nesse horizonte.</p>}
        {timeline.map((event, i) => (
          <EventRow
            key={i}
            label={event.label}
            sublabel={`${KIND_LABEL[event.kind] || event.kind} · ${formatDate(event.date)} · em ${event.daysFromNow} dia${event.daysFromNow === 1 ? "" : "s"}`}
            value={`${event.amount >= 0 ? "+" : "-"}${formatMoney(Math.abs(event.amount))}`}
            tone={event.amount >= 0 ? "positive" : "negative"}
            balanceAfter={formatMoney(event.balanceAfter)}
          />
        ))}
        <EventRow label={`Saldo previsto em ${horizonDays} dias`} value={formatMoney(projectedBalance)} highlight />
      </div>
    </div>
  );
}

function EventRow({ label, sublabel, value, tone, balanceAfter, highlight }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className={highlight ? "text-sm font-medium text-text-primary" : "text-sm text-text-secondary"}>{label}</div>
        {sublabel && <div className="text-caption text-text-muted">{sublabel}</div>}
      </div>
      <div className="shrink-0 text-right">
        <div className={`tabular text-sm ${tone === "positive" ? "text-positive" : tone === "negative" ? "text-danger" : "font-medium text-text-primary"}`}>{value}</div>
        {balanceAfter && <div className="tabular text-caption text-text-muted">saldo: {balanceAfter}</div>}
      </div>
    </div>
  );
}
