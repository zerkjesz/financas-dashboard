"use client";

import { formatMoney, formatDate } from "@/lib/formatMoney";
import Badge from "../ui/Badge.jsx";
import { CARD_BILL_STATUS_LABEL, CARD_BILL_STATUS_BADGE_VARIANT, detailGapLabel, creditUsageTone } from "@/lib/cardPresentation";

// Fase 5.4D, itens 10-13 — Cartão responde "o que eu já comprometi no
// crédito, quanto pesa, quando alivia" — NUNCA "quanto posso gastar" (isso é
// Home/Simulador). Hierarquia visual explícita, do maior pro menor peso
// tipográfico: FATURA ATUAL (.text-metric-lg) > USO DO LIMITE (barra +
// proporção) > LIMITE DISPONÍVEL (.text-metric-md, nunca headline — item 11).
// Crédito sempre no token `restricted` (item 12: capacidade de dívida, nunca
// riqueza) — mesmo com limite disponível alto, nunca vira `positive` verde.
export default function CardHero({ card, bill }) {
  const usedPct = Number(card.totalLimit) > 0 ? Math.min(100, (Number(card.usedLimit) / Number(card.totalLimit)) * 100) : 0;
  const tone = creditUsageTone(card.usedLimit, card.totalLimit);
  const gapNote = bill ? detailGapLabel(bill) : null;

  return (
    <div className="rounded-card bg-surface-2 p-6 sm:p-7">
      <div className="text-label text-text-muted mb-1">Fatura atual</div>
      {bill ? (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-1.5">
            <div className="text-metric-lg text-text-primary">{formatMoney(bill.totalAmount)}</div>
            <Badge variant={CARD_BILL_STATUS_BADGE_VARIANT[bill.status] || "neutral"}>{CARD_BILL_STATUS_LABEL[bill.status] || bill.status}</Badge>
          </div>
          <div className="text-caption text-text-muted mb-1">
            vence {formatDate(bill.dueAt)} · ciclo {bill.cycleMonth}
          </div>
          {/* Item 16 — nota discreta de transparência, nunca chamada de
              "ajuste"/"despesa": o total é o confirmado de verdade, só nem
              tudo dele está detalhado item a item ainda. */}
          {gapNote && <div className="text-caption text-text-muted mt-1">{gapNote} — total confirmado, detalhamento parcial.</div>}
        </>
      ) : (
        <div className="text-body text-text-muted">Nenhuma fatura corrente para este cartão.</div>
      )}

      <div className="mt-6 border-t border-border-subtle pt-4">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <span className="text-label text-text-muted">Uso do limite</span>
          <span className={`tabular text-sm font-medium ${tone === "danger" ? "text-danger" : "text-restricted"}`}>{usedPct.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-pill bg-surface-1">
          <div className={`h-full rounded-pill ${tone === "danger" ? "bg-danger" : "bg-restricted"}`} style={{ width: `${Math.min(100, usedPct)}%` }} />
        </div>
        <div className="mt-1.5 text-caption text-text-muted">
          {formatMoney(card.usedLimit)} usado de {formatMoney(card.totalLimit)}
        </div>
      </div>

      {/* Item 11 — limite disponível NUNCA é headline: escala .text-metric-md,
          cor restricted (capacidade de dívida, não riqueza — item 12). */}
      <div className="mt-4">
        <div className="text-label text-text-muted mb-1">Limite disponível</div>
        <div className="text-metric-md text-restricted">{formatMoney(card.availableLimit)}</div>
      </div>
    </div>
  );
}
