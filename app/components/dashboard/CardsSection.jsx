import { formatMoney } from "@/lib/formatMoney";

export default function CardsSection({ cards }) {
  if (cards.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-4 h-full">
      <div className="text-sm font-medium text-white mb-3">Cartões</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((card) => {
          const usedPct = card.totalLimit > 0 ? Math.min(100, (1 - card.availableLimit / card.totalLimit) * 100) : 0;
          return (
            <div key={card.id} className="rounded-lg border border-border bg-surface-2/40 p-3.5">
              <div className="flex items-center justify-between mb-3">
                <span className="font-medium text-white">{card.name}</span>
                <span className="text-xs text-muted">vence dia {card.dueDay}{card.closingDay ? ` · fecha dia ${card.closingDay}` : ""}</span>
              </div>

              <div className="h-1.5 rounded-full bg-surface overflow-hidden mb-1">
                <div className="h-full rounded-full bg-info" style={{ width: `${usedPct}%` }} />
              </div>
              <div className="flex justify-between text-xs text-muted mb-3">
                <span className="tabular">{formatMoney(card.availableLimit)} disponível</span>
                <span className="tabular">de {formatMoney(card.totalLimit)}</span>
              </div>

              <div className="grid grid-cols-2 gap-y-2 text-sm">
                <div>
                  <div className="text-xs text-muted">Fatura atual</div>
                  <div className="tabular text-negative font-medium">{formatMoney(card.currentBill?.totalAmount || 0)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Antecipado</div>
                  <div className="tabular">{formatMoney(card.amountAnticipated)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
