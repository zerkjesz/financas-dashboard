import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4C, itens 14/15/16 — próxima renda: data + valor-base + quanto já
// tem destino. Nenhum valor hardcoded — tudo vem de `financial.nextIncome`/
// `financial.nextIncomeCommitment` (lib/productFinancialSnapshot.js).
export default function NextIncomeCard({ nextIncome, nextIncomeCommitment }) {
  const percent = nextIncomeCommitment.baseCommittedPercent;
  // Item 16 — NUNCA clampar visualmente pra fingir 100%: a barra enche até
  // 100 (limite físico de largura), mas o NÚMERO exibido é o real (pode
  // passar de 100%) e um aviso textual explícito aparece quando isso ocorre —
  // isso é "número + barra + overflow semantics", nunca um clamp silencioso.
  const barPercent = percent != null ? Math.min(100, Math.max(0, percent)) : 0;
  const overCommitted = percent != null && percent > 100;

  return (
    <div className="rounded-card border border-border-subtle bg-surface-1 p-5">
      <h2 className="text-section-title text-text-primary mb-3">Próxima renda</h2>

      {nextIncome.expectedDate ? (
        <>
          <div className="text-metric-md text-text-primary">{formatMoney(nextIncome.baseAmount)}</div>
          {/* Item 15 — salário-base nunca é promessa; microcopy sempre visível,
              nunca escondida atrás de tooltip, nunca mostra "UNKNOWN" técnico. */}
          <div className="text-caption text-text-muted mb-1">
            {formatDate(nextIncome.expectedDate)} · valor-base — o real só confirma quando cair
          </div>
          {/* Item 25 — ACTION_REQUIRED genuinamente operacional, separado do
              status/contexto: a renda esperada já deveria ter chegado. Nunca
              confundido com o badge de situação financeira. */}
          {nextIncome.status === "OVERDUE" && (
            <div className="text-caption text-warning mt-1">Já deveria ter caído e ainda não foi lançada.</div>
          )}
        </>
      ) : (
        <div className="text-body text-text-muted">Nenhuma renda esperada configurada.</div>
      )}

      {percent != null && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <span className="text-label text-text-muted">Já comprometido</span>
            <span className="tabular text-sm font-medium text-text-primary">
              {formatMoney(nextIncomeCommitment.committedAmount)} (~{percent.toFixed(1)}%)
            </span>
          </div>
          <div className="h-1.5 rounded-pill bg-surface-2 overflow-hidden">
            <div className={`h-full rounded-pill transition-[width] ${overCommitted ? "bg-danger" : "bg-border-strong"}`} style={{ width: `${barPercent}%` }} />
          </div>
          {overCommitted && <div className="text-caption text-danger mt-1">Mais de 100% da base já tem destino.</div>}
        </div>
      )}
    </div>
  );
}
