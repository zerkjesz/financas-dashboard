"use client";

import Link from "next/link";
import { Info, ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { detailGapLabel } from "@/lib/cardPresentation";

// Fase 6.0 (Design Freeze) — RESTYLE + composição nova: o hero vira o
// layout de 2 colunas do design aprovado (visual do cartão físico à
// esquerda, fatura+limite empilhados à direita). Mesmos props de sempre
// (`card`, `bill`) — nenhum dado novo buscado, só uma composição visual
// que a página anterior não tinha (o "physical card visual" é inteiramente
// decorativo, construído em cima de campos reais do cartão — nome, ciclo,
// limite — nunca uma segunda fonte de dado).
//
// PAN mascarado — Norte não tem (e nunca teve) campo de número de cartão,
// CVV ou validade no schema (ver prisma/schema.prisma, model Card): isso é
// 100% decorativo, uma constante fixa, nunca calculado/derivado de nada
// real. O mesmo vale pro nome "RICARDO CARDOSO" no verso do cartão — texto
// de persona fixo, não um campo do banco de dados.
const DECORATIVE_MASKED_PAN = "•••• •••• •••• 0000";

function daysRemaining(dueAt) {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  const now = new Date();
  // Diferença em dias de calendário (UTC, mesmo motivo do formatDate: datas
  // de ciclo são meia-noite UTC — comparar em horário local desloca 1 dia
  // em fusos negativos).
  const diffMs = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round(diffMs / 86400000);
}

export default function CardHero({ card, bill }) {
  const usedPct = Number(card.totalLimit) > 0 ? Math.min(100, (Number(card.usedLimit) / Number(card.totalLimit)) * 100) : 0;
  const gapNote = bill ? detailGapLabel(bill) : null;
  const remaining = bill ? daysRemaining(bill.dueAt) : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[0.95fr_1.3fr] gap-4">
      {/* Visual do cartão físico — moldura escura + rosto do cartão. */}
      <div className="rounded-card bg-ink p-5 sm:p-6">
        <PhysicalCard card={card} />

        {bill && (
          <div className="mt-5 grid grid-cols-3 border-t border-white/10 pt-4">
            <Stat label="Fecha" value={bill.closesAt ? formatDate(bill.closesAt) : "—"} />
            <Stat label="Vence" value={bill.dueAt ? formatDate(bill.dueAt) : "—"} border />
            <Stat label="Faltam" value={remaining != null ? `${remaining} dia${Math.abs(remaining) === 1 ? "" : "s"}` : "—"} border />
          </div>
        )}
      </div>

      {/* Fatura + limite, empilhados. */}
      <div className="flex flex-col gap-4">
        <div className="rounded-card bg-surface shadow-card p-5 sm:p-7">
          <p className="text-eyebrow text-text-muted mb-2">O que já entrou nesta fatura</p>
          {bill ? (
            <>
              <div className="tabular text-metric-lg text-text-primary">{formatMoney(bill.totalAmount)}</div>
              <p className="text-caption text-text-muted mt-2">Ainda pode crescer até fechar, no dia {bill.closesAt ? formatDate(bill.closesAt) : "—"}.</p>

              {/* Item 13 (herdado da 5.4D) — nota de gap é contexto de
                  qualidade de dado, nunca erro/warning: ícone Info neutro. */}
              {gapNote && (
                <div className="mt-3 flex items-start gap-1.5 border-t border-border-subtle pt-3">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                  <p className="text-caption text-text-muted">Total confirmado. {gapNote}.</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-body text-text-muted">Nenhuma fatura corrente para este cartão.</p>
          )}
        </div>

        <div className="rounded-card bg-surface shadow-card p-5 sm:p-7">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
            <h2 className="text-card-title text-text-primary">Limite</h2>
            <span className="tabular text-metric-md text-text-primary">
              {formatMoney(card.usedLimit)} <span className="text-sm font-normal text-text-muted">de {formatMoney(card.totalLimit)}</span>
            </span>
          </div>

          <div className="transition-bar h-3 w-full overflow-hidden rounded-pill bg-track">
            <div className="transition-bar h-full rounded-pill bg-ink" style={{ width: `${usedPct}%` }} />
          </div>

          <p className="text-body text-text-secondary mt-3">Sobra de limite {formatMoney(card.availableLimit)}</p>
          <p className="text-caption text-text-muted">é do banco, não seu</p>

          {/* Entrada contextual pro Simulador — mesma rota/params de sempre,
              nunca auto-executa (usuário aperta "Simular" de novo). */}
          <div className="mt-4 border-t border-border-subtle pt-4">
            <Link
              href={`/simulador?scenario=card_single&cardId=${card.id}`}
              className="focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors pointer-coarse:min-h-11"
            >
              Simular uma compra neste cartão
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, border = false }) {
  return (
    <div className={`px-2 text-center ${border ? "border-l border-white/10" : ""}`}>
      <div className="text-eyebrow text-white/50 mb-1">{label}</div>
      <div className="tabular text-sm font-medium text-white">{value}</div>
    </div>
  );
}

function PhysicalCard({ card }) {
  return (
    <div
      className="transition-press mx-auto flex rotate-[-1.2deg] flex-col justify-between rounded-[18px] p-4 shadow-card-orange hover:-translate-y-1 hover:rotate-0 sm:p-5"
      style={{
        aspectRatio: "1.586",
        maxWidth: "330px",
        background: "linear-gradient(135deg,var(--color-card-grad-1) 0%,var(--color-card-grad-2) 42%,var(--color-card-grad-3) 78%,var(--color-card-grad-4) 100%)",
      }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-1.5">
          {/* Marca Norte — decorativa, nunca branding de banco/bandeira
              real (auditoria do ZIP confirma zero referência externa). */}
          <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-white" aria-hidden="true">
            <span className="h-2 w-2 rotate-45" style={{ background: "var(--color-card-grad-2)" }} />
          </span>
          <span className="text-sm font-semibold text-white">Norte</span>
        </div>
        {/* Nome do cartão/conta real, nunca "PLATINUM"/tier de mock. */}
        <span className="text-eyebrow text-white/80">{card.name}</span>
      </div>

      {/* Chip EMV — decorativo. */}
      <div
        className="h-6 w-9 rounded-[4px]"
        style={{ background: "linear-gradient(140deg,var(--color-card-chip-1),var(--color-card-chip-2) 55%,var(--color-card-chip-3))" }}
        aria-hidden="true"
      />

      <div>
        <div className="font-mono text-base tracking-[0.18em] text-white/90 sm:text-lg" aria-hidden="true">
          {DECORATIVE_MASKED_PAN}
        </div>
        <div className="mt-3 flex items-end justify-between">
          <div>
            <div className="text-[9px] uppercase tracking-[0.14em] text-white/50">Titular</div>
            {/* Texto de persona fixo/decorativo — Norte não tem campo de
                nome de titular no cartão, isso nunca vem do banco de dados. */}
            <div className="text-xs font-medium tracking-wide text-white/90">RICARDO CARDOSO</div>
          </div>
          <div className="text-right">
            <div className="text-[9px] uppercase tracking-[0.14em] text-white/50">Validade</div>
            <div className="font-mono text-xs font-medium text-white/90">00/00</div>
          </div>
        </div>
      </div>
    </div>
  );
}
