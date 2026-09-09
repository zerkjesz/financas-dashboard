import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4C, itens 19/20/21/22/47 — linha compacta de contexto FÍSICO
// (nunca 3 hero cards): "onde estão os números físicos?". CRÉDITO NUNCA
// PARECE RIQUEZA aqui — só a fatura atual + vencimento, nunca limite
// total/disponível (isso fica em /cartoes). VA sempre rotulado "uso
// restrito", nunca parece cash irrestrito.
export default function PhysicalMoneyContext({ liquidity, cards, restricted }) {
  const primaryCard = cards && cards.length > 0 ? cards[0] : null;

  return (
    <div className="rounded-card border border-border-subtle bg-surface-1 p-5">
      <h2 className="text-section-title text-text-primary mb-2">Contexto físico</h2>
      <div className="divide-y divide-border-subtle">
        {/* Item 20 — "Dinheiro na conta", nunca "Caixa livre" (nome contaminado
            pelo vocabulário V1 de /metas). */}
        <Row label="Dinheiro na conta" value={formatMoney(liquidity.unrestrictedCash)} />

        {primaryCard && (
          <Row
            label={`Fatura ${primaryCard.name}`}
            value={formatMoney(primaryCard.currentBill?.totalAmount || 0)}
            sub={primaryCard.currentBill?.dueAt ? `vence ${formatDate(primaryCard.currentBill.dueAt)}` : null}
            href="/cartoes"
          />
        )}

        {restricted && <Row label="Vale Alimentação" value={formatMoney(restricted.vaBalance)} sub="uso restrito" />}
      </div>
    </div>
  );
}

function Row({ label, value, sub, href }) {
  const content = (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-text-secondary truncate">{label}</div>
        {sub && <div className="text-caption text-text-muted">{sub}</div>}
      </div>
      <div className="tabular text-sm font-medium text-text-primary shrink-0">{value}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="focus-ring -mx-2 block rounded-control px-2 transition-colors hover:bg-surface-2">
      {content}
    </Link>
  ) : (
    content
  );
}
