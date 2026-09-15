"use client";

import { ShoppingBag, Layers } from "lucide-react";
import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — RESTYLE + composição nova: vira o "two-up" do
// design aprovado — "Compras desta fatura" e "Parcelas rodando" lado a
// lado, cada um com sua própria barra de progresso real. CARD installments
// (Purchase/Installment, sempre presa a este Card) continuam separadas de
// EXTERNAL installments (dono é /compromissos) — nenhuma mudança nessa
// fronteira.
//
// "Compras desta fatura" é dado real, não uma segunda fonte: cada
// `purchase.installments` já vem incluído por listPurchasesWithProgress
// (GET /api/purchases, já buscado por page.js) — só filtramos, por compra,
// a parcela cujo `billMonth` bate com o ciclo da fatura atual (`current.
// cycleMonth`, já resolvido pelo engine em page.js). Nenhuma parcela nova é
// calculada aqui.
//
// Judgment call / gap conhecido: esta lista só cobre compras PARCELADAS no
// cartão (model Purchase). Uma despesa avulsa lançada direto no cartão
// (model Expense, sem parcelamento) também entra no total oficial da
// fatura (via computeExpectedCardBillTotal) mas não aparece aqui — Expense
// não é buscado por esta página. Por isso o total desta lista pode ficar
// abaixo do "O que já entrou nesta fatura" do hero; a nota de
// hasDetailGap/gapNote no hero já sinaliza exatamente essa diferença.
export default function CardInstallmentsList({ purchases, current }) {
  const currentCycleMonth = current?.cycleMonth ?? null;

  const currentBillItems = currentCycleMonth
    ? purchases
        .map((p) => {
          const installment = (p.installments || []).find((i) => i.billMonth === currentCycleMonth);
          return installment ? { purchase: p, installment } : null;
        })
        .filter(Boolean)
    : [];

  // Campo já calculado em listPurchasesWithProgress — nunca recomputado aqui.
  const runningPurchases = purchases.filter((p) => p.remainingInstallments > 0);

  if (currentBillItems.length === 0 && runningPurchases.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ListCard icon={ShoppingBag} title="Compras desta fatura" items={currentBillItems} empty="Nenhuma parcela cai nesta fatura.">
        {({ purchase, installment }) => (
          <Row
            key={purchase.id}
            label={purchase.description}
            sub={`parcela ${installment.number}/${purchase.installmentCount}`}
            value={formatMoney(installment.amount)}
            pct={Math.min(100, (installment.number / purchase.installmentCount) * 100)}
          />
        )}
      </ListCard>

      <ListCard icon={Layers} title="Parcelas rodando" items={runningPurchases} empty="Nenhuma parcela ativa neste cartão.">
        {(p) => (
          <Row
            key={p.id}
            label={p.description}
            sub={`${p.currentInstallmentNumber}/${p.installmentCount} · ${formatMoney(p.installmentValue)}/mês`}
            value={formatMoney(p.installmentValue)}
            pct={Math.min(100, (p.currentInstallmentNumber / p.installmentCount) * 100)}
          />
        )}
      </ListCard>
    </div>
  );
}

function ListCard({ icon: Icon, title, items, empty, children: renderItem }) {
  return (
    <div className="rounded-card bg-surface shadow-card p-5 sm:p-7">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-chip-bg text-text-secondary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <h2 className="text-card-title text-text-primary">{title}</h2>
      </div>
      {items.length > 0 ? <div>{items.map(renderItem)}</div> : <p className="text-body text-text-muted py-2">{empty}</p>}
    </div>
  );
}

function Row({ label, sub, value, pct }) {
  return (
    <div className="-mx-2 rounded-control border-t border-border-subtle px-2 py-3 transition-colors hover:bg-chip-bg-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-text-secondary">{label}</div>
          <div className="text-caption text-text-muted">{sub}</div>
        </div>
        <div className="tabular shrink-0 text-sm font-medium text-text-primary">{value}</div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-pill bg-track">
        <div className="transition-bar h-full rounded-pill bg-ink" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
