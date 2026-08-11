import SummaryCard from "../SummaryCard.jsx";

export default function BalanceCards({ balances }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
      <SummaryCard label="Caixa Atual" value={balances.caixaAtual} />
      <SummaryCard label="Saldo em Pix" value={balances.pix} />
      <SummaryCard label="Saldo em dinheiro" value={balances.dinheiro} />
      <SummaryCard label="Saldo VA" value={balances.va} />
      <SummaryCard label="Saldo total" value={balances.saldoTotal} tone="white" />
    </div>
  );
}
