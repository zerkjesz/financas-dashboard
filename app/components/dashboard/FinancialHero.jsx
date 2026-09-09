"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import Disclosure from "../ui/Disclosure.jsx";
import {
  STATUS_COPY,
  OBLIGATION_CLASS_LABEL,
  selectDominantReason,
  obligationItemLabel,
  obligationItemDate,
  obligationItemHref,
  freeMoneyLegend,
  shouldSuggestSimulation,
} from "@/lib/homePresentation";

// Fase 5.4C.1 — HERO como composição única (não 3 mini-cards dentro de um
// card). Diferenciação de profundidade: só o Hero recebe `bg-surface-2`
// (um degrau mais claro que as superfícies secundárias, que ficam em
// `surface-1`) + uma hairline superior na cor do status + um wash radial
// muito sutil — nunca borda pesada, nunca gradient chamativo (item 8/30).
// Status deixa de ser "badge no canto": vira parte da tipografia
// (STATUS_COPY.label em .text-page-title, cor semântica), com um marcador
// de forma (ponto) em vez de bolinha colorida sozinha.
const STATUS_TEXT_CLASS = {
  TRANQUILO: "text-positive",
  ATENCAO: "text-warning",
  APERTADO: "text-danger",
  CRITICO: "text-danger",
};
const STATUS_BAR_CLASS = {
  TRANQUILO: "bg-positive",
  ATENCAO: "bg-warning",
  APERTADO: "bg-danger",
  CRITICO: "bg-danger",
};
const STATUS_WASH = {
  TRANQUILO: "34,197,94",
  ATENCAO: "224,169,74",
  APERTADO: "248,113,113",
  CRITICO: "248,113,113",
};

export default function FinancialHero({ financial }) {
  const { liquidity, currentObligations } = financial;
  const copy = STATUS_COPY[liquidity.status] ?? STATUS_COPY.ATENCAO;
  const dominant = selectDominantReason(currentObligations.breakdown);
  const restItems = dominant ? currentObligations.breakdown.filter((item) => item !== dominant) : [];
  const legend = freeMoneyLegend(liquidity.freeMoney);
  const suggestSimulate = shouldSuggestSimulation(liquidity.status);
  const wash = STATUS_WASH[liquidity.status] ?? STATUS_WASH.ATENCAO;

  return (
    <div className="relative overflow-hidden rounded-card bg-surface-2 p-6 sm:p-7">
      {/* hairline de status — substitui o badge isolado; a cor do status já
          está presente antes de qualquer texto ser lido. */}
      <div className={`absolute inset-x-0 top-0 h-[3px] ${STATUS_BAR_CLASS[liquidity.status] ?? "bg-border-strong"}`} aria-hidden="true" />
      {/* wash radial muito sutil, só nesta superfície (item 8) — profundidade,
          nunca decoração chamativa. */}
      <div
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
        style={{ background: `rgba(${wash}, 0.07)` }}
        aria-hidden="true"
      />

      <div className="relative">
        <div className="flex items-center gap-2 mb-1">
          <span className={`h-2 w-2 rounded-full ${STATUS_BAR_CLASS[liquidity.status] ?? "bg-border-strong"}`} aria-hidden="true" />
          <span className="text-label text-text-muted">Situação financeira</span>
        </div>
        <h2 className={`text-page-title mb-1.5 ${STATUS_TEXT_CLASS[liquidity.status] ?? "text-text-primary"}`}>{copy.label}</h2>
        <p className="text-body text-text-secondary mb-6 max-w-md">{copy.headline}</p>

        {/* Fase 5.4C.2, item 1 — CORRIGIDO: `sm:items-end` alinhava as duas
            colunas pela base da CAIXA, não pelo NÚMERO. Quando freeMoney é
            negativo ela ganha uma legenda extra abaixo do número — a caixa
            fica mais alta, e alinhar pela base empurrava o número de
            safeToSpend ~32px pra baixo (medido ao vivo), quebrando a leitura
            de par. `sm:items-start` alinha os dois RÓTULOS no topo (mesma
            altura sempre) e cada número segue o próprio rótulo — correto
            com ou sem legenda. */}
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-10">
          <div>
            <div className="text-label text-text-muted mb-1">Dinheiro livre</div>
            <div className={`text-metric-lg ${liquidity.freeMoney < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(liquidity.freeMoney)}</div>
            {legend && (
              <div className="text-caption text-text-muted mt-1">
                {formatMoney(Math.abs(liquidity.freeMoney))} {legend}
              </div>
            )}
          </div>
          {/* Item 11 — safeToSpend nunca disputa protagonismo com freeMoney:
              escala tipográfica menor (.text-metric-md), sem card próprio. */}
          <div>
            <div className="text-label text-text-muted mb-1">Seguro pra gastar hoje</div>
            <div className="text-metric-md text-text-primary">{formatMoney(liquidity.safeToSpend)}</div>
          </div>
        </div>

        {/* Fase 5.4C.2, item 3 — CORRIGIDO: a caixa `bg-surface-1/70
            rounded-lg` lia como "card dentro do card" (fundo + raio
            próprios, visivelmente separada do hero). Substituída por uma
            divisória simples — a MESMA gramática que NextIncomeCard já usa
            pro próprio rodapé ("Já comprometido") — reduz aninhamento visual
            sem inventar um tratamento novo. */}
        {dominant && (
          <div className="mt-6 border-t border-border-subtle pt-4">
            <div className="text-label text-text-muted mb-2">Por que</div>
            <BreakdownItem item={dominant} />
            {restItems.length > 0 && (
              <Disclosure summary={`ver mais ${restItems.length} ${restItems.length === 1 ? "item" : "itens"}`} className="mt-1">
                <div className="pt-1 space-y-1.5">
                  {restItems.map((item, i) => (
                    <BreakdownItem key={i} item={item} />
                  ))}
                </div>
              </Disclosure>
            )}
          </div>
        )}

        {suggestSimulate && (
          <div className="mt-5">
            {/* Item 4 — seta tipográfica "→" trocada por ArrowRight (Lucide),
                mesma linguagem visual do conector de ProjectionSummary. */}
            <Link
              href="/simulador"
              className="focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors"
            >
              Simular antes de comprar
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function BreakdownItem({ item }) {
  const label = obligationItemLabel(item);
  const date = obligationItemDate(item);
  const href = obligationItemHref(item);
  const classLabel = OBLIGATION_CLASS_LABEL[item.class] ?? item.class;

  const content = (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <div className="min-w-0">
        <div className="text-text-secondary truncate">{label}</div>
        {date && (
          <div className="text-caption text-text-muted">
            {classLabel} · até {formatDate(date)}
          </div>
        )}
      </div>
      <div className="tabular text-text-primary font-medium shrink-0">{formatMoney(item.amount)}</div>
    </div>
  );

  return href ? (
    <Link href={href} className="focus-ring -mx-2 block rounded-control px-2 transition-colors hover:bg-surface-2/60">
      {content}
    </Link>
  ) : (
    content
  );
}
