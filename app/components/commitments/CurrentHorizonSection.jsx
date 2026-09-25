"use client";

import Link from "next/link";
import { Receipt, CreditCard, Repeat } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { obligationItemLabel, obligationItemDate, obligationItemHref, obligationItemHasNoDueDate, obligationItemCaption, OBLIGATION_CLASS_LABEL } from "@/lib/commitmentsPresentation";

// Fase 6.0 (Design Freeze) — RESTYLE. A taxonomia de dado não muda: os
// mesmos itens de `incurred`/`dueBeforeIncome` (já anotados com `.type` —
// "CardBill" | "Bill" | "ConfirmedCommitment" | "ExternalInstallment" — em
// lib/freeMoney.js, e `.class` — INCURRED_LIABILITY | CURRENT_HORIZON_
// OBLIGATION — em lib/productFinancialSnapshot.js) continuam vindo prontos
// do engine, nunca reclassificados aqui. O que muda é só a APRESENTAÇÃO:
// em vez de 1 card único agrupado por TEMPO (já gasto / antes da renda),
// os mesmos itens viram até 3 dos 4 "group cards" do design aprovado,
// agrupados por TIPO (confirmadas / cartão / parcelas externas) — a MESMA
// taxonomia que `item.type` já carrega. O total de cada grupo é só a soma
// dos `amount` já computados por item (mesma operação que `combinedTotal`
// já fazia antes, só em 3 fatias em vez de 1) — nenhum valor novo.
const GRID_COLS = "grid-cols-[64px_minmax(0,1fr)_84px] sm:grid-cols-[96px_minmax(0,1fr)_140px]";

function sumAmounts(items) {
  return items.reduce((s, i) => s + Number(i.amount), 0);
}

function GroupCard({ icon: Icon, title, caption, total, items, dark = false }) {
  if (items.length === 0) return null;
  const rowHover = dark ? "hover:bg-white/5" : "hover:bg-chip-bg-2";
  const border = dark ? "border-white/10" : "border-border-subtle";

  return (
    <div className={`rounded-card p-5 sm:p-7 ${dark ? "bg-ink text-white shadow-hero" : "bg-surface shadow-card"}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile ${dark ? "bg-accent/16 text-accent" : "bg-chip-bg text-text-secondary"}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 className={`text-card-title truncate ${dark ? "text-white" : "text-text-primary"}`}>{title}</h2>
        </div>
        {caption && <span className={`text-eyebrow shrink-0 ${dark ? "text-white/50" : "text-text-muted"}`}>{caption}</span>}
        <span className={`tabular ml-auto shrink-0 text-metric-md ${dark ? "text-white" : "text-text-primary"}`}>{formatMoney(total)}</span>
      </div>

      <div className="mt-3">
        {items.map((item, i) => {
          const label = obligationItemLabel(item);
          const date = obligationItemDate(item);
          const href = obligationItemHref(item);
          const classLabel = item.class ? OBLIGATION_CLASS_LABEL[item.class] : null;
          const rowContent = (
            <div className={`focus-ring grid ${GRID_COLS} items-center gap-2 rounded-control border-t ${border} py-3 -mx-2 px-2 transition-colors ${rowHover}`}>
              <span className={`tabular text-xs ${dark ? "text-white/50" : "text-text-muted"}`}>{date ? formatDate(date) : "—"}</span>
              <span className="min-w-0">
                <span className={`block truncate text-sm ${dark ? "text-white/90" : "text-text-secondary"}`}>{label}</span>
                {obligationItemCaption(item, classLabel) && (
                  <span className={`block text-caption ${dark ? "text-white/40" : "text-text-muted"}`}>{obligationItemCaption(item, classLabel)}</span>
                )}
              </span>
              <span className={`tabular text-right text-sm font-medium ${dark ? "text-white" : "text-text-primary"}`}>{formatMoney(item.amount)}</span>
            </div>
          );
          return href ? (
            <Link key={item.id ?? i} href={href} className="block">
              {rowContent}
            </Link>
          ) : (
            <div key={item.id ?? i}>{rowContent}</div>
          );
        })}
      </div>
    </div>
  );
}

export default function CurrentHorizonSection({ incurred, incurredTotal, dueBeforeIncome, dueBeforeIncomeTotal }) {
  if (incurred.length === 0 && dueBeforeIncome.length === 0) return null;

  // Mesmo array combinado que o card único antigo somava em `combinedTotal`
  // (incurredTotal + dueBeforeIncomeTotal) — só reparticionado por tipo em
  // vez de mostrado como 1 bloco.
  const all = [...incurred, ...dueBeforeIncome];
  const confirmedItems = all.filter((i) => i.type !== "CardBill" && i.type !== "ExternalInstallment");
  const cardItems = all.filter((i) => i.type === "CardBill");
  const externalItems = all.filter((i) => i.type === "ExternalInstallment");

  // Caption do grupo "Fatura de cartão" — data de vencimento real (mais
  // próxima, quando há mais de um cartão) do próprio item, nunca inventada.
  const cardDueDates = cardItems.map((i) => obligationItemDate(i)).filter(Boolean).sort();
  const cardCaption = cardDueDates.length > 0 ? `vence ${formatDate(cardDueDates[0])}` : null;

  const externalCaption =
    externalItems.length > 0 ? `${externalItems.length} parcela${externalItems.length > 1 ? "s" : ""} neste horizonte` : null;

  return (
    <>
      <GroupCard icon={Receipt} title="Contas confirmadas" caption="não dá para adiar" total={sumAmounts(confirmedItems)} items={confirmedItems} />
      <GroupCard icon={CreditCard} title="Fatura de cartão" caption={cardCaption} total={sumAmounts(cardItems)} items={cardItems} dark />
      <GroupCard icon={Repeat} title="Parcelas externas" caption={externalCaption} total={sumAmounts(externalItems)} items={externalItems} />
    </>
  );
}
