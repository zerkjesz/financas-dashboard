import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4C.1, itens 14/15 — composição PRÓPRIA, não um clone menor do
// hero: anel de progresso (conic-gradient puro, sem lib de gráfico) em vez
// da barra linear genérica, número da renda ao lado em vez de empilhado.
// Superfície secundária (surface-1, sem borda) — profundidade só por
// luminosidade, igual ao resto dos cards de contexto (item 28).
export default function NextIncomeCard({ nextIncome, nextIncomeCommitment }) {
  const percent = nextIncomeCommitment.baseCommittedPercent;
  // Item 16 — o ANEL nunca finge 100%: o ângulo visual satura em 360°, mas o
  // NÚMERO exibido é sempre o real (pode passar de 100%) + a cor muda pra
  // danger nesse caso — "número + anel + overflow semantics", nunca clamp
  // silencioso.
  const ringPercent = percent != null ? Math.min(100, Math.max(0, percent)) : 0;
  const overCommitted = percent != null && percent > 100;
  const ringColor = overCommitted ? "var(--color-danger)" : "var(--color-accent)";

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <div className="text-label text-text-muted mb-3">Próxima renda</div>

      {nextIncome.expectedDate ? (
        <div className="flex items-center gap-4">
          {percent != null && (
            <div
              className="relative h-16 w-16 shrink-0 rounded-full"
              style={{ background: `conic-gradient(${ringColor} ${ringPercent * 3.6}deg, var(--color-surface-2) 0deg)` }}
              role="img"
              aria-label={`${percent.toFixed(1)}% da próxima renda já comprometido`}
            >
              <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-surface-1">
                <span className={`tabular text-xs font-semibold ${overCommitted ? "text-danger" : "text-text-primary"}`}>{percent.toFixed(0)}%</span>
              </div>
            </div>
          )}
          <div className="min-w-0">
            <div className="text-metric-md text-text-primary">{formatMoney(nextIncome.baseAmount)}</div>
            <div className="text-caption text-text-muted">{formatDate(nextIncome.expectedDate)}</div>
          </div>
        </div>
      ) : (
        <div className="text-body text-text-muted">Nenhuma renda esperada configurada.</div>
      )}

      {nextIncome.expectedDate && (
        <>
          {/* Item 15 — salário-base nunca é promessa; microcopy sempre
              visível, nunca "UNKNOWN" técnico. */}
          <div className="text-caption text-text-muted mt-3">valor-base — o real só confirma quando cair</div>
          {nextIncome.status === "OVERDUE" && <div className="text-caption text-warning mt-1">Já deveria ter caído e ainda não foi lançada.</div>}
        </>
      )}

      {percent != null && (
        <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-border-subtle pt-3 text-sm">
          <span className="text-text-muted">Já comprometido</span>
          <span className="tabular font-medium text-text-primary">{formatMoney(nextIncomeCommitment.committedAmount)}</span>
        </div>
      )}
      {overCommitted && <div className="text-caption text-danger mt-1">Mais de 100% da base já tem destino.</div>}
    </div>
  );
}
