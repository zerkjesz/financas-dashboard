import { formatMoney } from "@/lib/formatMoney";
import { STATUS_COPY } from "@/lib/homePresentation";

// Fase 6.0 (Design Freeze) — "Dá para gastar hoje", o hero escuro da
// referência aprovada. A resposta primária da Home é `safeToSpend` (o
// mesmo número canônico de sempre, lib/freeMoney.js — nunca recalculado
// aqui), nunca `freeMoney` (que aparece só no rodapé, como um dos 3 fatos
// de apoio). 3 segmentos (Tranquilo/Atenção/Apertado) mapeiam os 4 estados
// reais do engine — CRÍTICO acende o mesmo 3º segmento de Apertado (é uma
// variação mais severa do mesmo "sem margem", não um 4º degrau visual novo
// que o design não tem).
const SEGMENT_INDEX = { TRANQUILO: 0, ATENCAO: 1, APERTADO: 2, CRITICO: 2 };
const SEGMENTS = ["Tranquilo", "Atenção", "Apertado"];

function daysUntil(date) {
  if (!date) return null;
  const ms = new Date(date).setUTCHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round(ms / 86400000));
}

export default function SpendableTodayCard({ financial }) {
  const { liquidity, nextIncome } = financial;
  const copy = STATUS_COPY[liquidity.status] ?? STATUS_COPY.ATENCAO;
  const activeSegment = SEGMENT_INDEX[liquidity.status] ?? 1;
  const days = daysUntil(nextIncome?.expectedDate);

  return (
    <div className="relative overflow-hidden rounded-card bg-ink p-9 shadow-hero text-white flex flex-col justify-between min-h-[380px]">
      {/* wash decorativo — lime, puramente cosmético, nunca informação. */}
      <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />

      <div className="relative">
        <div className="text-eyebrow text-white/66 mb-3">Dá para gastar hoje</div>
        <div className="text-display font-light tracking-tight">{formatMoney(liquidity.safeToSpend)}</div>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/72">{copy.headline}</p>
      </div>

      <div className="relative mt-8">
        <div className="flex gap-1.5" role="img" aria-label={`Situação financeira: ${copy.label}`}>
          {SEGMENTS.map((label, i) => (
            <div key={label} className={`h-1.5 flex-1 rounded-pill ${i === activeSegment ? "bg-accent shadow-[0_0_0_5px_rgba(201,255,41,0.28)]" : "bg-white/16"}`} />
          ))}
        </div>
        <div className="mt-2 flex gap-1.5">
          {SEGMENTS.map((label, i) => (
            <div key={label} className={`flex-1 text-eyebrow ${i === activeSegment ? "text-accent" : "text-white/40"}`}>
              {label}
            </div>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-5">
          <Stat label="Está livre" value={formatMoney(liquidity.freeMoney)} tone={liquidity.freeMoney < 0 ? "muted" : "default"} />
          <Stat label="Na conta" value={formatMoney(liquidity.unrestrictedCash)} />
          <Stat
            label={days != null ? `Entra em ${days} ${days === 1 ? "dia" : "dias"}` : "Próxima renda"}
            value={formatMoney(nextIncome?.baseAmount ?? 0)}
            tone="accent"
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "default" }) {
  const valueClass = tone === "accent" ? "text-accent" : tone === "muted" ? "text-white/70" : "text-white";
  return (
    <div className="min-w-0">
      <div className="text-eyebrow text-white/50 mb-1 leading-tight">{label}</div>
      <div className={`tabular text-[13px] sm:text-sm font-semibold whitespace-nowrap ${valueClass}`}>{value}</div>
    </div>
  );
}
