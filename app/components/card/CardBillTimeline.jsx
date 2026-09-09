"use client";

import Badge from "../ui/Badge.jsx";
import Disclosure from "../ui/Disclosure.jsx";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { CARD_BILL_STATUS_LABEL, CARD_BILL_STATUS_BADGE_VARIANT, detailGapLabel } from "@/lib/cardPresentation";

// Fase 5.4D, item 14 — CURRENT/NEXT/LATER substitui a grade de 10+ meses
// (a fatura atual já vive em CardHero; aqui só NEXT — as 3 próximas
// relevantes, em rail — e LATER atrás de "ver todas", nunca 10 linhas de
// R$0,00 com o mesmo peso visual das que importam agora).
export default function CardBillTimeline({ next, later }) {
  if (next.length === 0 && later.length === 0) return null;

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-4">Próximas faturas</h2>

      {next.length > 0 ? (
        <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {next.map((bill) => (
            <BillRailItem key={bill.cycleMonth} bill={bill} />
          ))}
        </div>
      ) : (
        <p className="text-body text-text-muted">Nenhuma fatura futura conhecida ainda.</p>
      )}

      {later.length > 0 && (
        <Disclosure summary={`ver todas as faturas (${later.length} mais)`} className="mt-4 border-t border-border-subtle pt-3">
          <div className="divide-y divide-border-subtle pt-1">
            {later.map((bill) => (
              <div key={bill.cycleMonth} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="text-text-secondary">{bill.cycleMonth}</div>
                  <div className="text-caption text-text-muted">vence {formatDate(bill.dueAt)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular text-text-primary">{formatMoney(bill.totalAmount)}</span>
                  <Badge variant={CARD_BILL_STATUS_BADGE_VARIANT[bill.status] || "neutral"}>{CARD_BILL_STATUS_LABEL[bill.status] || bill.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function BillRailItem({ bill }) {
  const gapNote = detailGapLabel(bill);
  return (
    <div className="py-3 first:pt-0 last:pb-0 sm:px-5 sm:py-0 sm:first:pl-0 sm:last:pr-0">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-caption text-text-muted">{bill.cycleMonth}</span>
        <Badge variant={CARD_BILL_STATUS_BADGE_VARIANT[bill.status] || "neutral"}>{CARD_BILL_STATUS_LABEL[bill.status] || bill.status}</Badge>
      </div>
      <div className="tabular text-sm font-medium text-text-primary">{formatMoney(bill.totalAmount)}</div>
      <div className="text-caption text-text-muted">vence {formatDate(bill.dueAt)}</div>
      {gapNote && <div className="text-caption text-text-muted mt-0.5">{gapNote}</div>}
    </div>
  );
}
