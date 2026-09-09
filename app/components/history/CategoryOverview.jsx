"use client";

import { formatMoney } from "@/lib/formatMoney";
import { CATEGORY_COLORS } from "@/lib/categoryRules";

// Fase 5.4D, itens 46/47/48/49 — CATEGORY é o topo da hierarquia
// (categoria → destaque → transações, nunca 3 componentes paralelos
// mostrando a mesma coisa). Reaproveita a MESMA paleta refinada na 5.4C.2
// (nenhuma cor semântica reusada, nenhum rainbow) e a mesma gramática de
// barra da Home (SpendingSection) — bars+list em vez de donut (item 47: só
// vale a pena um donut se a lib escolhida tornar isso simples/acessível;
// CHART_LIBRARY_DECISION desta fase foi "nenhuma lib" — bars continuam
// perfeitamente aceitáveis). Clicar numa categoria filtra a lista abaixo
// (item 49) — sem reload, é só estado do componente pai.
//
// Fase 5.4D.1 — elevado pra `bg-surface-2` (mesmo grau da Home hero/Cartão
// hero/Compromissos "Horizonte atual"): sem isso, Histórico era 2 caixas
// `bg-surface-1` do mesmo peso — nenhuma pista de qual é a informação
// primária (a categoria é o "insight", a lista é o "detalhe" — item 46).
// Tons internos (track da barra, estado selecionado) descem um degrau
// (surface-1/surface-3) pra continuar contrastando contra o novo fundo.
export default function CategoryOverview({ totals, total, selected, onSelect }) {
  if (totals.length === 0) {
    return (
      <div className="rounded-card bg-surface-2 p-6">
        <h2 className="text-label text-text-muted mb-2">Por categoria</h2>
        <p className="text-body text-text-muted">Nenhum gasto registrado neste ciclo ainda.</p>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-surface-2 p-6">
      <h2 className="text-label text-text-muted mb-4">Por categoria (ciclo atual)</h2>
      <div className="space-y-3">
        {totals.map(([category, value]) => {
          const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Outros;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          const isSelected = selected === category;
          return (
            // Fase 5.4E.1.1 — MEDIDO ao vivo: -mx-2 px-2 py-1.5 dava 43px de
            // hit target real, 1px abaixo de 44px. `pointer-coarse:min-h-11`
            // só em touch fecha a diferença sem alterar a densidade em
            // desktop.
            <button
              key={category}
              onClick={() => onSelect(isSelected ? null : category)}
              aria-pressed={isSelected}
              className={`focus-ring block w-full rounded-control text-left transition-colors cursor-pointer pointer-coarse:min-h-11 ${isSelected ? "bg-surface-3" : "hover:bg-surface-3/60"} -mx-2 px-2 py-1.5`}
            >
              <div className="flex items-baseline justify-between mb-1 gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate text-sm text-text-secondary">{category}</span>
                  <span className="text-caption shrink-0 text-text-muted">{pct}%</span>
                </div>
                <span className="tabular shrink-0 text-sm font-medium text-text-primary">{formatMoney(value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-pill bg-surface-1">
                <div className="h-full rounded-pill" style={{ width: `${total > 0 ? (value / totals[0][1]) * 100 : 0}%`, backgroundColor: color }} />
              </div>
            </button>
          );
        })}
      </div>
      {selected && (
        <button
          onClick={() => onSelect(null)}
          className="focus-ring inline-flex items-center mt-3 text-caption text-accent hover:text-accent-hover cursor-pointer pointer-coarse:min-h-11"
        >
          limpar filtro
        </button>
      )}
    </div>
  );
}
