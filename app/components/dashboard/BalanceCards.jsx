import { formatMoney } from "@/lib/formatMoney";
import SummaryCard from "../SummaryCard.jsx";

export default function BalanceCards({ balances }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="rounded-xl border border-positive/25 bg-gradient-to-br from-positive/10 via-surface to-surface p-5 flex flex-col justify-center">
        <div className="text-xs text-muted mb-1.5">Saldo total</div>
        <div className="tabular text-3xl font-semibold text-white tracking-tight">{formatMoney(balances.saldoTotal)}</div>
        <div className="text-xs text-muted mt-2">
          Caixa atual: <span className="tabular text-slate-300">{formatMoney(balances.caixaAtual)}</span>
        </div>
      </div>
      <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryCard label="Saldo em Pix" value={balances.pix} />
        <SummaryCard label="Saldo em dinheiro" value={balances.dinheiro} />
        <SummaryCard label="Saldo VA" value={balances.va} />
      </div>
    </div>
  );
}
