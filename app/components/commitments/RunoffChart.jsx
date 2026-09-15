"use client";

import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — RESTYLE. Mesma lógica de dado/breakpoint da
// 5.4D/5.4D.1.1 (comentários de bug real abaixo preservados — continuam
// válidos, nada estrutural mudou): eixo "+N ocorrência(s) de renda" (nunca
// mês de calendário — o dado não tem data exata pra planos
// AFTER_NEXT_INCOME), corte de orientação em `xl` (medido ao vivo, ver
// histórico). Só a pintura muda: barra do "agora" em bg-ink (mesmo peso
// visual do grupo "Fatura de cartão" de CurrentHorizonSection), ocorrências
// futuras em bg-gray-1/2/3 progressivamente mais claras — nunca a cor
// restricted antiga, que era um cinza só, sem escala.
//
// Fase 5.4D, itens 20-24 — RUNOFF: "quando minhas parcelas externas
// aliviam?". Substitui a lista plana antiga por barras reais (degraus/
// platôs/quedas ficam visíveis de cara). Valor SEMPRE visível como texto
// (nunca só em tooltip de hover — item 24).
//
// BUG REAL corrigido na 5.4D (achado ao vivo em 390px): com muitos planos
// ativos (11 offsets no dado real), colunas lado a lado nunca cabem em
// mobile — corrigido com troca de orientação por breakpoint: barras
// verticais lado a lado numa tela larga, linhas com barra horizontal
// empilhadas verticalmente numa tela estreita (nunca estoura largura, só
// cresce em altura — item 24, "não criar horizontal scroll infinito").
//
// BUG REAL corrigido na 5.4D.1.1 (achado ao vivo em 768px E 1024px, medido
// via scrollWidth/clientWidth): o corte estava em `sm` (640px), mas 11
// colunas de 80px + gaps somam ~1000px — só cabem sem overflow a partir de
// ~1280px. Corte movido pra `xl` (1280px) — linhas seguras cobrem
// 768/1024 inteiros agora.
function barTone(index) {
  if (index === 0) return "bg-ink";
  const tones = ["bg-gray-1", "bg-gray-2", "bg-gray-3"];
  return tones[Math.min(index - 1, tones.length - 1)];
}

export default function RunoffChart({ runoff }) {
  if (!runoff || runoff.length === 0) return null;
  const max = Math.max(...runoff.map((r) => Number(r.monthTotal)), 1);

  return (
    <div className="rounded-card bg-surface p-5 sm:p-7 shadow-card">
      <h2 className="text-eyebrow text-text-muted mb-1">Quando as parcelas externas aliviam</h2>
      <p className="text-caption text-text-muted mb-5">
        Uma parcela de cada plano ativo por ocorrência de renda — não são datas de calendário, é posição.
      </p>

      {/* < xl: linhas empilhadas, barra horizontal — nunca estoura largura,
          nem em 768/1024 (medido — ver comentário acima). */}
      <div className="flex flex-col gap-3 xl:hidden">
        {runoff.map((row, i) => (
          <RunoffRow key={row.offset} row={row} max={max} tone={barTone(i)} />
        ))}
      </div>

      {/* xl+ (1280px, verificado sem overflow): colunas lado a lado — a
          forma "degraus descendentes" fica visível de cara. */}
      <div className="hidden xl:flex items-end gap-3 overflow-x-auto" style={{ minHeight: "140px" }}>
        {runoff.map((row, i) => (
          <RunoffColumn key={row.offset} row={row} max={max} tone={barTone(i)} />
        ))}
      </div>
    </div>
  );
}

function offsetLabel(row) {
  return row.offset === 0 ? "Agora" : `+${row.offset} renda${row.offset > 1 ? "s" : ""}`;
}

function RunoffColumn({ row, max, tone }) {
  const heightPct = max > 0 ? (Number(row.monthTotal) / max) * 100 : 0;
  const isTerminal = row.activePlanCount === 0;
  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-1.5">
      <span className={`w-full tabular text-center text-xs font-medium ${isTerminal ? "text-text-muted" : "text-text-primary"}`}>{isTerminal ? "R$ 0" : formatMoney(row.monthTotal)}</span>
      <div className="flex h-24 w-full items-end">
        <div
          className={`transition-bar w-full rounded-t-control ${isTerminal ? "bg-track" : tone}`}
          style={{ height: `${Math.max(heightPct, isTerminal ? 3 : 6)}%` }}
          role="img"
          aria-label={`${row.label}: ${formatMoney(row.monthTotal)}, ${row.activePlanCount} plano(s) ativo(s)`}
        />
      </div>
      <span className="w-full text-caption text-text-muted text-center leading-tight">{offsetLabel(row)}</span>
      {row.plansFinishingThisOffset.length > 0 && (
        <span className="w-full text-caption text-warning-text text-center leading-tight">termina: {row.plansFinishingThisOffset.join(", ")}</span>
      )}
    </div>
  );
}

function RunoffRow({ row, max, tone }) {
  const widthPct = max > 0 ? (Number(row.monthTotal) / max) * 100 : 0;
  const isTerminal = row.activePlanCount === 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-caption text-text-muted">{offsetLabel(row)}</span>
        <span className={`tabular text-sm font-medium ${isTerminal ? "text-text-muted" : "text-text-primary"}`}>{isTerminal ? "R$ 0" : formatMoney(row.monthTotal)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-pill bg-track">
        <div
          className={`transition-bar h-full rounded-pill ${isTerminal ? "bg-gray-2" : tone}`}
          style={{ width: `${Math.max(widthPct, isTerminal ? 2 : 4)}%` }}
          role="img"
          aria-label={`${row.label}: ${formatMoney(row.monthTotal)}, ${row.activePlanCount} plano(s) ativo(s)`}
        />
      </div>
      {row.plansFinishingThisOffset.length > 0 && <div className="text-caption text-warning-text mt-1">termina: {row.plansFinishingThisOffset.join(", ")}</div>}
    </div>
  );
}
