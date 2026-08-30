import { formatMoney } from "@/lib/formatMoney";
import SummaryCard from "../SummaryCard.jsx";

export default function BalanceCards({ balances }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
      <SummaryCard label="Caixa atual" value={balances.caixaAtual} tone="emerald" />
      <SummaryCard label="Saldo em Pix" value={balances.pix} />
      <SummaryCard label="Saldo em dinheiro" value={balances.dinheiro} />
      <SummaryCard label="Saldo VA" value={balances.va} />
      <div className="rounded-xl border border-positive/25 bg-positive/[0.06] p-4">
        <div className="text-xs text-muted mb-1.5">Saldo total</div>
        <div className="tabular text-xl font-semibold text-white">{formatMoney(balances.saldoTotal)}</div>
      </div>
    </div>
  );
}
