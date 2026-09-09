import Link from "next/link";
import { Wallet, CreditCard, UtensilsCrossed } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4C.1, item 17 — "compact financial rail": 3 colunas lado a lado
// no desktop (divisores verticais, não uma lista de linhas horizontais —
// deixa de parecer outro card-lista igual aos outros), empilhado em mobile.
// Crédito nunca aparece como riqueza (só fatura atual, nunca limite — item
// 18); VA leva o token `restricted` (item 19) — nunca a cor de "positivo".
export default function PhysicalMoneyContext({ liquidity, cards, restricted }) {
  const primaryCard = cards && cards.length > 0 ? cards[0] : null;

  return (
    <div className="rounded-card bg-surface-1 p-5">
      <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <RailItem icon={Wallet} label="Dinheiro na conta" value={formatMoney(liquidity.unrestrictedCash)} />

        {primaryCard && (
          <RailItem
            icon={CreditCard}
            label={`Fatura ${primaryCard.name}`}
            value={formatMoney(primaryCard.currentBill?.totalAmount || 0)}
            sub={primaryCard.currentBill?.dueAt ? `vence ${formatDate(primaryCard.currentBill.dueAt)}` : null}
            href="/cartoes"
            tone="restricted"
          />
        )}

        {restricted && <RailItem icon={UtensilsCrossed} label="Vale Alimentação" value={formatMoney(restricted.vaBalance)} sub="uso restrito" tone="restricted" />}
      </div>
    </div>
  );
}

function RailItem({ icon: Icon, label, value, sub, href, tone }) {
  const iconClass = tone === "restricted" ? "text-restricted" : "text-text-muted";
  const content = (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0 sm:px-5 sm:py-0 sm:first:pl-0 sm:last:pr-0">
      <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${iconClass}`} aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-caption text-text-muted">{label}</div>
        <div className="tabular text-sm font-medium text-text-primary">{value}</div>
        {sub && <div className="text-caption text-text-muted">{sub}</div>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="focus-ring block rounded-control transition-colors hover:bg-surface-2/60 sm:h-full">
      {content}
    </Link>
  ) : (
    content
  );
}
