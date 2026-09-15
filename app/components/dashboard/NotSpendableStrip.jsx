import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — "Isso aqui não é dinheiro livre": dispositivo
// explícito pra impedir que VA e limite de cartão sejam contados como
// dinheiro disponível de verdade (nenhum dos dois entra em freeMoney/
// safeToSpend — lib/freeMoney.js). Puramente informativo, dados reais.
export default function NotSpendableStrip({ restricted, cards }) {
  const primaryCard = cards && cards.length > 0 ? cards[0] : null;
  if (!restricted && !primaryCard) return null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-eyebrow text-text-muted">Isso aqui não é dinheiro livre</span>
      {restricted && (
        <span className="inline-flex items-center gap-2 rounded-pill bg-surface px-3.5 py-2 text-sm shadow-card">
          <span className="text-text-secondary">Vale-alimentação</span>
          <span className="tabular font-semibold text-text-primary">{formatMoney(restricted.vaBalance)}</span>
        </span>
      )}
      {primaryCard && (
        <span className="inline-flex items-center gap-2 rounded-pill bg-surface px-3.5 py-2 text-sm shadow-card">
          <span className="text-text-secondary">Limite do cartão</span>
          <span className="tabular font-semibold text-text-primary">{formatMoney(primaryCard.availableLimit)}</span>
        </span>
      )}
      <span className="text-caption text-text-muted">Limite é do banco, não seu.</span>
    </div>
  );
}
