"use client";

import { formatMoney } from "@/lib/formatMoney";

// Fase 5.4D, itens 20-24 — RUNOFF: "quando minhas parcelas externas
// aliviam?". Substitui a lista plana antiga por barras reais (degraus/
// platôs/quedas ficam visíveis de cara). Eixo temporal é sempre "+N
// ocorrência(s) de renda" — NUNCA mês de calendário (item 21: o dado não
// tem data exata pra planos AFTER_NEXT_INCOME, inventar uma seria mentir).
// Valor SEMPRE visível como texto (nunca só em tooltip de hover — item 24).
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
// ~1280px (medido: 1024px overflowing=true, scrollWidth 1000 > clientWidth
// 920; 1280px overflowing=false, 1056=1056). `sm:flex` deixava 640-1023px
// inteiro (incluindo 768, onde o nav já foi corrigido duas vezes por esse
// mesmo tipo de erro de breakpoint) com um `overflow-x-auto` ativo — um
// "horizontal scroll trap" de verdade, exatamente o que o item 24 proíbe.
// Corte movido pra `xl` (1280px, breakpoint padrão do Tailwind, não um
// valor inventado) — linhas seguras cobrem 768/1024 inteiros agora.
export default function RunoffChart({ runoff }) {
  if (!runoff || runoff.length === 0) return null;
  const max = Math.max(...runoff.map((r) => Number(r.monthTotal)), 1);

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <h2 className="text-label text-text-muted mb-1">Quando as parcelas externas aliviam</h2>
      <p className="text-caption text-text-muted mb-5">
        Uma parcela de cada plano ativo por ocorrência de renda — não são datas de calendário, é posição.
      </p>

      {/* < xl: linhas empilhadas, barra horizontal — nunca estoura largura,
          nem em 768/1024 (medido — ver comentário acima). */}
      <div className="flex flex-col gap-3 xl:hidden">
        {runoff.map((row) => (
          <RunoffRow key={row.offset} row={row} max={max} />
        ))}
      </div>

      {/* xl+ (1280px, verificado sem overflow): colunas lado a lado — a
          forma "degraus descendentes" fica visível de cara. */}
      <div className="hidden xl:flex items-end gap-3 overflow-x-auto" style={{ minHeight: "140px" }}>
        {runoff.map((row) => (
          <RunoffColumn key={row.offset} row={row} max={max} />
        ))}
      </div>
    </div>
  );
}

function offsetLabel(row) {
  return row.offset === 0 ? "Agora" : `+${row.offset} renda${row.offset > 1 ? "s" : ""}`;
}

function RunoffColumn({ row, max }) {
  const heightPct = max > 0 ? (Number(row.monthTotal) / max) * 100 : 0;
  const isTerminal = row.activePlanCount === 0;
  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-1.5">
      {/* Fase 5.4D.1.1 — BUG REAL corrigido (medido ao vivo, 1280px): este
          span não tinha `w-full`/`text-center` — "R$ 1.472,09" media 79px
          de largura própria contra uma coluna de 64px, vazando ~7,6px pra
          cada lado (confirmado via getBoundingClientRect). Coluna alargada
          pra 80px (w-20) + `w-full text-center` como defesa: cabe numa
          linha só no caso comum, e nunca mais overflow se algum valor
          futuro for mais largo ainda (quebra dentro da própria coluna). */}
      <span className={`w-full tabular text-center text-xs font-medium ${isTerminal ? "text-text-muted" : "text-text-primary"}`}>{isTerminal ? "R$ 0" : formatMoney(row.monthTotal)}</span>
      <div className="flex h-24 w-full items-end">
        <div
          className={`w-full rounded-t-control transition-all ${isTerminal ? "bg-surface-2" : "bg-restricted"}`}
          style={{ height: `${Math.max(heightPct, isTerminal ? 3 : 6)}%` }}
          role="img"
          aria-label={`${row.label}: ${formatMoney(row.monthTotal)}, ${row.activePlanCount} plano(s) ativo(s)`}
        />
      </div>
      {/* Fase 5.4D.1 — BUG REAL corrigido (medido ao vivo): sem `w-full`, o
          <span> cresce pelo conteúdo (nome de plano longo) em vez de
          respeitar os 64px da coluna — texto vazava até 21px pra dentro das
          colunas vizinhas (confirmado via getBoundingClientRect). `w-full`
          força o span a quebrar linha dentro da própria coluna. */}
      <span className="w-full text-caption text-text-muted text-center leading-tight">{offsetLabel(row)}</span>
      {row.plansFinishingThisOffset.length > 0 && (
        <span className="w-full text-caption text-restricted text-center leading-tight">termina: {row.plansFinishingThisOffset.join(", ")}</span>
      )}
    </div>
  );
}

function RunoffRow({ row, max }) {
  const widthPct = max > 0 ? (Number(row.monthTotal) / max) * 100 : 0;
  const isTerminal = row.activePlanCount === 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-caption text-text-muted">{offsetLabel(row)}</span>
        <span className={`tabular text-sm font-medium ${isTerminal ? "text-text-muted" : "text-text-primary"}`}>{isTerminal ? "R$ 0" : formatMoney(row.monthTotal)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-pill bg-surface-2">
        <div
          className={`h-full rounded-pill ${isTerminal ? "bg-surface-3" : "bg-restricted"}`}
          style={{ width: `${Math.max(widthPct, isTerminal ? 2 : 4)}%` }}
          role="img"
          aria-label={`${row.label}: ${formatMoney(row.monthTotal)}, ${row.activePlanCount} plano(s) ativo(s)`}
        />
      </div>
      {row.plansFinishingThisOffset.length > 0 && <div className="text-caption text-restricted mt-1">termina: {row.plansFinishingThisOffset.join(", ")}</div>}
    </div>
  );
}
