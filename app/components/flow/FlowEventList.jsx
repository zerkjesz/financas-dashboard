"use client";

import { ArrowDownToLine, Receipt, CreditCard, Layers, CheckCircle2, CircleDashed, MapPin } from "lucide-react";
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

// Ícone por tipo de evento — mesmo `kind` real que /api/cash-flow já
// devolve (collectOutflowEvents em lib/financialProjection.js), nenhuma
// classificação nova.
const KIND_ICON = {
  recurring_income: ArrowDownToLine,
  bill: Receipt,
  card_bill: CreditCard,
  external_installment: Layers,
  external_installment_window: Layers,
  confirmed_commitment: CheckCircle2,
  contingency: CircleDashed,
};

// Fase 6.0 (Design Freeze) — o mock aprovado NÃO tem gráfico de linha: é uma
// lista vertical de eventos discretos num único card branco, cada linha com
// data + ícone + label + valor + barra de saldo restante. Substitui o antigo
// layout de 2 colunas (label/sublabel à esquerda, valor/saldo em texto à
// direita) — mesmos dados reais (`timeline`), só reapresentados como o mock
// pede: chip de ícone tonal por tipo de evento e uma barra horizontal de
// 160px cujo preenchimento é `balanceAfter / maxBalanceInTimeline` (dado já
// computado pelo motor — `event.balanceAfter` vem pronto de
// buildBaseProjection, nunca recalculado aqui).
export default function FlowEventList({ startingBalance, timeline, horizonDays, projectedBalance }) {
  // max real do próprio timeline (nunca hardcoded) — inclui o saldo de hoje
  // e o saldo final projetado, pra barra nunca estourar 100% nem ficar toda
  // vazia quando o saldo só cai.
  const allBalances = [Number(startingBalance), ...timeline.map((e) => Number(e.balanceAfter)), Number(projectedBalance)];
  const maxBalance = Math.max(0, ...allBalances);

  return (
    <div className="rounded-card bg-surface shadow-card p-6 sm:p-7">
      <div className="text-eyebrow text-text-muted mb-4">Eventos da trajetória</div>
      <div className="divide-y divide-border-subtle">
        <EventRow
          date="Hoje"
          label="Saldo atual"
          balanceAfter={startingBalance}
          maxBalance={maxBalance}
          isToday
        />
        {timeline.length === 0 && <p className="text-body text-text-muted py-4">Nenhuma conta, fatura ou receita prevista nesse horizonte.</p>}
        {timeline.map((event, i) => (
          <EventRow
            key={i}
            date={formatDate(event.date)}
            label={event.label}
            sublabel={`${KIND_LABEL[event.kind] || event.kind} · em ${event.daysFromNow} dia${event.daysFromNow === 1 ? "" : "s"}`}
            kind={event.kind}
            amount={event.amount}
            balanceAfter={event.balanceAfter}
            maxBalance={maxBalance}
          />
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between gap-3">
        <span className="text-caption text-text-muted">Saldo previsto em {horizonDays} dias</span>
        <span className={`tabular text-sm font-semibold ${Number(projectedBalance) < 0 ? "text-danger-text" : "text-text-primary"}`}>{formatMoney(projectedBalance)}</span>
      </div>
    </div>
  );
}

function EventRow({ date, label, sublabel, kind, amount, balanceAfter, maxBalance, isToday = false }) {
  const Icon = isToday ? MapPin : KIND_ICON[kind] || CircleDashed;
  const pct = maxBalance > 0 ? Math.max(0, (Number(balanceAfter) / maxBalance) * 100) : 0;

  // Tonalidade do chip: hoje = lime com ícone escuro (+ glow sutil), receita
  // = escuro com ícone lime, fatura de cartão e o resto = chip neutro —
  // exatamente a regra do mock.
  const chipClass = isToday
    ? "bg-accent text-ink ring-4 ring-accent/20"
    : kind === "recurring_income"
      ? "bg-ink text-accent"
      : "bg-chip-bg text-text-secondary";

  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="w-[4.75rem] shrink-0 text-caption text-text-muted tabular">{date}</div>
      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-tile ${chipClass}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className={isToday ? "text-sm font-medium text-text-primary" : "text-sm text-text-body"}>{label}</div>
        {sublabel && <div className="text-caption text-text-muted truncate">{sublabel}</div>}
      </div>
      <div className="shrink-0 text-right">
        {amount != null && (
          <div className={`tabular text-sm font-medium ${amount >= 0 ? "text-positive" : "text-text-primary"}`}>
            {amount >= 0 ? "+" : "-"}
            {formatMoney(Math.abs(amount))}
          </div>
        )}
        <div className="mt-1 h-1.5 w-40 rounded-pill bg-track overflow-hidden ml-auto">
          <div className="transition-bar h-full rounded-pill bg-ink" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-caption font-mono text-text-muted">SOBRA {formatMoney(balanceAfter)}</div>
      </div>
    </div>
  );
}
