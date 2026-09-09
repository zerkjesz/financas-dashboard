"use client";

import Link from "next/link";
import { Info, ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import Badge from "../ui/Badge.jsx";
import { CARD_BILL_STATUS_LABEL, CARD_BILL_STATUS_BADGE_VARIANT, detailGapLabel, creditUsageTone } from "@/lib/cardPresentation";

// Fase 5.4D.1 — CARD_DESIGN_SIGNATURE, item 1/5: o hero ganha identidade
// própria (anel de uso do limite, hairline restricted no topo) em vez de
// ser "a Home hero sem wash/status" — mas nunca clona a composição da Home
// (sem status/dominant-reason, sem breakdown). Hierarquia inalterada da
// 5.4D: FATURA ATUAL (.text-metric-lg) > USO DO LIMITE > LIMITE DISPONÍVEL
// (.text-metric-md, nunca headline — item 12). Crédito sempre `restricted`
// (nunca positive verde), mesmo com limite disponível alto.
export default function CardHero({ card, bill }) {
  const usedPct = Number(card.totalLimit) > 0 ? Math.min(100, (Number(card.usedLimit) / Number(card.totalLimit)) * 100) : 0;
  const tone = creditUsageTone(card.usedLimit, card.totalLimit);
  const gapNote = bill ? detailGapLabel(bill) : null;
  const ringColor = tone === "danger" ? "var(--color-danger)" : "var(--color-restricted)";

  return (
    <div className="relative overflow-hidden rounded-card bg-surface-2 p-6 sm:p-7">
      {/* Hairline restricted — sinal mínimo de identidade do hero (item 1 da
          assinatura), sem repetir a semântica de status da Home (aqui não
          há "status financeiro", só um lembrete visual de que este cartão
          trabalha com crédito). */}
      <div className="absolute inset-x-0 top-0 h-[3px] bg-restricted/60" aria-hidden="true" />

      <div className="text-label text-text-muted mb-1">Fatura atual</div>
      {bill ? (
        <>
          <div className="flex flex-wrap items-end gap-3 mb-1.5">
            <div className="text-metric-lg text-text-primary">{formatMoney(bill.totalAmount)}</div>
            <Badge variant={CARD_BILL_STATUS_BADGE_VARIANT[bill.status] || "neutral"}>{CARD_BILL_STATUS_LABEL[bill.status] || bill.status}</Badge>
          </div>
          <div className="text-caption text-text-muted">
            vence {formatDate(bill.dueAt)} · ciclo {bill.cycleMonth}
          </div>

          {/* Item 13 — a nota de gap precisa parecer CONTEXTO DE QUALIDADE DE
              DADO, nunca erro/warning: ícone Info neutro (não danger/warning),
              hairline própria separando do resto da fatura, cor muted — a
              mesma discrição de uma legenda, nunca um banner. */}
          {gapNote && (
            <div className="mt-3 flex items-start gap-1.5 border-t border-border-subtle pt-3">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <p className="text-caption text-text-muted">
                Total confirmado. {gapNote}.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="text-body text-text-muted">Nenhuma fatura corrente para este cartão.</div>
      )}

      {/* Item 11 — anel substitui a barra linear fina: mesmo vocabulário
          geométrico do anel de "Próxima renda" da Home (item 2 da
          assinatura), mas cor/semântica diferentes (restricted = crédito,
          nunca accent). Texto do % nunca escondido — número real ao lado do
          anel, igual à Home (nunca clamp silencioso). */}
      <div className="mt-6 flex items-center gap-4 border-t border-border-subtle pt-4">
        <div
          className="relative h-14 w-14 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${ringColor} ${Math.min(100, usedPct) * 3.6}deg, var(--color-surface-1) 0deg)` }}
          role="img"
          aria-label={`${usedPct.toFixed(0)}% do limite usado`}
        >
          <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-surface-2">
            <span className={`tabular text-xs font-semibold ${tone === "danger" ? "text-danger" : "text-restricted"}`}>{usedPct.toFixed(0)}%</span>
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-label text-text-muted mb-1">Uso do limite</div>
          <div className="tabular text-sm text-text-secondary">
            {formatMoney(card.usedLimit)} de {formatMoney(card.totalLimit)}
          </div>
        </div>
      </div>

      {/* Limite disponível NUNCA é headline (item 12/17): escala .text-metric-md,
          cor restricted (capacidade de dívida, não riqueza). */}
      <div className="mt-4">
        <div className="text-label text-text-muted mb-1">Limite disponível</div>
        <div className="text-metric-md text-restricted">{formatMoney(card.availableLimit)}</div>
      </div>

      {/* Fase 5.4E, item 13/45 — entrada contextual pro Simulador: só
          roteia apresentação (scenario + cardId real), nunca auto-executa
          (o Simulador sempre exige o usuário apertar "Simular" de novo —
          ver SimuladorClient.jsx). Label descritiva e específica deste
          cartão, nunca "Simular" genérico repetido pela tela inteira. */}
      <div className="mt-4 border-t border-border-subtle pt-4">
        <Link
          href={`/simulador?scenario=card_single&cardId=${card.id}`}
          className="focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors"
        >
          Simular uma compra neste cartão
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
