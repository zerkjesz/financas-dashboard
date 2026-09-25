import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.3B — TRUTH WIRING (não redesign): primeira superfície do produto a
// mostrar freeMoney/safeToSpend/status, a mostrar um ConfirmedCommitment real
// (currentObligations.breakdown) e a mostrar o "quanto do próximo salário já
// está comprometido", tudo 100% vindo de lib/productFinancialSnapshot.js
// (data.financial) — nenhum número aqui é recalculado neste componente, só
// formatado pra exibição.
//
// Reaproveita os MESMOS tokens visuais dos outros cards do dashboard
// (rounded-xl border-border bg-surface, tabular, text-muted) — nenhuma
// identidade visual nova.

const STATUS_STYLE = {
  TRANQUILO: { label: "Tranquilo", classes: "bg-positive/15 text-positive border-positive/30" },
  ATENCAO: { label: "Atenção", classes: "bg-warning/15 text-warning border-warning/30" },
  APERTADO: { label: "Apertado", classes: "bg-warning/15 text-warning border-warning/30" },
  CRITICO: { label: "Crítico", classes: "bg-negative/15 text-negative border-negative/30" },
};

const CLASS_LABEL = {
  INCURRED_LIABILITY: "dívida já incorrida",
  CURRENT_HORIZON_OBLIGATION: "compromisso até a próxima renda",
};

function itemLabel(item) {
  if (item.type === "CardBill") return `Fatura ${item.cardName} (${item.cycleMonth})`;
  return item.description;
}

function itemDueDate(item) {
  return item.dueDate ?? item.dueAt ?? null;
}

export default function FinancialTruthPanel({ financial }) {
  if (!financial) return null;
  const { liquidity, currentObligations, nextIncome, nextIncomeCommitment, externalInstallments, contingency } = financial;
  const statusStyle = STATUS_STYLE[liquidity.status] || STATUS_STYLE.ATENCAO;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface-2 p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <span className="text-sm font-medium text-white">Situação financeira</span>
        <span className={`text-xs font-medium px-2 py-1 rounded border ${statusStyle.classes}`}>{statusStyle.label}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-lg border border-border bg-surface-2/40 p-3">
          <div className="text-xs text-muted mb-1">Dinheiro livre</div>
          <div className={`tabular text-lg font-semibold ${liquidity.freeMoney < 0 ? "text-negative" : "text-positive"}`}>{formatMoney(liquidity.freeMoney)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface-2/40 p-3">
          <div className="text-xs text-muted mb-1">Seguro pra gastar</div>
          <div className="tabular text-lg font-semibold text-white">{formatMoney(liquidity.safeToSpend)}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface-2/40 p-3">
          <div className="text-xs text-muted mb-1">Caixa irrestrito</div>
          <div className="tabular text-lg font-semibold text-white">{formatMoney(liquidity.unrestrictedCash)}</div>
        </div>
      </div>

      {currentObligations.breakdown.length > 0 && (
        <div className="mb-4">
          <div className="text-xs text-muted mb-2">Por que o dinheiro livre está assim</div>
          <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {currentObligations.breakdown.map((item, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 text-sm bg-surface-2/20">
                <div className="min-w-0">
                  <div className="text-slate-200 truncate">{itemLabel(item)}</div>
                  <div className="text-xs text-muted">
                    {item.type === "ConfirmedCommitment" && !itemDueDate(item)
                      ? (item.status === "FUNDED" ? "Dinheiro separado · Sem prazo definido" : "Sem prazo definido")
                      : `${CLASS_LABEL[item.class] || item.class}${itemDueDate(item) ? ` · até ${formatDate(itemDueDate(item))}` : ""}`}
                  </div>
                </div>
                <span className="tabular text-white font-medium shrink-0 pl-2">{formatMoney(item.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted mb-1">
            Próxima renda · {formatDate(nextIncome.expectedDate)}
          </div>
          <div className="tabular text-base font-semibold text-white">{formatMoney(nextIncome.baseAmount)} (base esperada)</div>
          <div className="text-xs text-muted mt-0.5">valor real só é confirmado quando cair</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted mb-1">Já comprometido dessa renda</div>
          <div className="tabular text-base font-semibold text-white">
            {formatMoney(nextIncomeCommitment.committedAmount)}
            {nextIncomeCommitment.baseCommittedPercent != null && (
              <span className="text-muted font-normal text-sm"> (~{nextIncomeCommitment.baseCommittedPercent.toFixed(1)}%)</span>
            )}
          </div>
          <div className="text-xs text-muted mt-0.5">
            cartão {formatMoney(nextIncomeCommitment.cardAmount)} · parcelas externas {formatMoney(nextIncomeCommitment.externalAmount)}
          </div>
        </div>
      </div>

      {externalInstallments.activePlanCount > 0 && (
        <div className="rounded-lg border border-border p-3 mb-4">
          <div className="text-xs text-muted mb-1">Parcelas externas ativas</div>
          <div className="text-sm text-slate-200">
            {externalInstallments.activePlanCount} plano(s) · {externalInstallments.nextWindowCount} vencem na próxima renda ({formatMoney(externalInstallments.nextWindowAmount)}) ·{" "}
            {externalInstallments.futureCount} mais adiante ({formatMoney(externalInstallments.futureAmount)})
          </div>
          <a href="/parcelas" className="text-xs text-info hover:underline">
            ver detalhes e runoff →
          </a>
        </div>
      )}

      {contingency.items.length > 0 && (
        <div className="rounded-lg border border-border/60 border-dashed p-3">
          <div className="text-xs text-muted mb-1">Riscos (não reduz dinheiro livre por padrão)</div>
          {contingency.items.map((c) => (
            <div key={c.id} className="text-sm text-slate-300">
              {c.description}: até {formatMoney(c.maxAmount)} {c.expectedAmount != null ? `(esperado ~${formatMoney(c.expectedAmount)})` : ""} — orçamento pendente
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
