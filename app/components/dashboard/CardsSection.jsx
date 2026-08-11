import { formatMoney } from "@/lib/formatMoney";

export default function CardsSection({ cards }) {
  if (cards.length === 0) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
      <div className="text-sm text-white/50 mb-3">Cartões</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map((card) => (
          <div key={card.id} className="rounded-lg border border-white/10 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">{card.name}</span>
              <span className="text-xs text-white/50">vence dia {card.dueDay}{card.closingDay ? ` · fecha dia ${card.closingDay}` : ""}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-xs text-white/50">Limite</div>
                <div>{formatMoney(card.totalLimit)}</div>
              </div>
              <div>
                <div className="text-xs text-white/50">Disponível</div>
                <div className="text-emerald-400">{formatMoney(card.availableLimit)}</div>
              </div>
              <div>
                <div className="text-xs text-white/50">Fatura atual</div>
                <div className="text-rose-400">{formatMoney(card.currentBill?.totalAmount || 0)}</div>
              </div>
              <div>
                <div className="text-xs text-white/50">Antecipado</div>
                <div>{formatMoney(card.amountAnticipated)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
