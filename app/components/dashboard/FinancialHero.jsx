"use client";

import Link from "next/link";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import Badge from "../ui/Badge.jsx";
import Disclosure from "../ui/Disclosure.jsx";
import {
  STATUS_COPY,
  OBLIGATION_CLASS_LABEL,
  selectDominantReason,
  obligationItemLabel,
  obligationItemDate,
  obligationItemHref,
  freeMoneyLegend,
  shouldSuggestSimulation,
} from "@/lib/homePresentation";

// Fase 5.4C, itens 6/7/8/9/11/12/13/32 — o HERO é o bloco único de decisão:
// status + freeMoney + safeToSpend + motivo dominante no MESMO contexto
// visual (nunca 3 cards separados — eles respondem a mesma pergunta).
// Nenhum cálculo financeiro aqui — só formatação/seleção de apresentação
// sobre `financial` (lib/productFinancialSnapshot.js, a fonte canônica).
const STATUS_BADGE_VARIANT = { TRANQUILO: "positive", ATENCAO: "warning", APERTADO: "danger", CRITICO: "danger" };

export default function FinancialHero({ financial }) {
  const { liquidity, currentObligations } = financial;
  const copy = STATUS_COPY[liquidity.status] ?? STATUS_COPY.ATENCAO;
  const dominant = selectDominantReason(currentObligations.breakdown);
  const restItems = dominant ? currentObligations.breakdown.filter((item) => item !== dominant) : [];
  const legend = freeMoneyLegend(liquidity.freeMoney);
  const suggestSimulate = shouldSuggestSimulation(liquidity.status);

  return (
    <div className="rounded-card border border-border-subtle bg-surface-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-section-title text-text-primary">Situação financeira</h2>
        <Badge variant={STATUS_BADGE_VARIANT[liquidity.status] ?? "neutral"}>{copy.label}</Badge>
      </div>
      <p className="text-body text-text-secondary mb-4">{copy.headline}</p>

      {/* Item 39 — testado ao vivo em 390px: grid-cols-2 fixo deixava a
          coluna estreita demais pra .text-metric-lg com valores negativos
          (ex: "-R$ 302,80" quebrava entre o sinal e o valor). 1 coluna até
          "sm", 2 colunas a partir daí — nunca deixa o número quebrar no meio. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-label text-text-muted mb-1">Dinheiro livre</div>
          {/* Item 8 — nunca só "-R$ 302,80" sozinho: sinal explícito (já vem
              de formatMoney) + cor semântica só quando negativo + legenda. */}
          <div className={`text-metric-lg ${liquidity.freeMoney < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(liquidity.freeMoney)}</div>
          {legend && (
            <div className="text-caption text-text-muted mt-0.5">
              {formatMoney(Math.abs(liquidity.freeMoney))} {legend}
            </div>
          )}
        </div>
        <div>
          <div className="text-label text-text-muted mb-1">Seguro pra gastar</div>
          {/* Item 9 — R$0,00 é um resultado válido, nunca "—"/vazio/disabled. */}
          <div className="text-metric-lg text-text-primary">{formatMoney(liquidity.safeToSpend)}</div>
        </div>
      </div>

      {dominant && (
        <div className="mt-4 pt-3 border-t border-border-subtle">
          <div className="text-label text-text-muted mb-2">Por que</div>
          <BreakdownItem item={dominant} />
          {restItems.length > 0 && (
            <Disclosure summary={`ver mais ${restItems.length} ${restItems.length === 1 ? "item" : "itens"}`} className="mt-1">
              <div className="pt-1 space-y-1.5">
                {restItems.map((item, i) => (
                  <BreakdownItem key={i} item={item} />
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      )}

      {/* Item 32 — CTA discreto, nunca banner extra; só quando o status já
          justifica cautela. Não pré-preenche o simulador (isso é 5.4E). */}
      {suggestSimulate && (
        <div className="mt-4 pt-3 border-t border-border-subtle">
          <Link href="/simulador" className="focus-ring inline-block rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors">
            Simular antes de comprar →
          </Link>
        </div>
      )}
    </div>
  );
}

function BreakdownItem({ item }) {
  const label = obligationItemLabel(item);
  const date = obligationItemDate(item);
  const href = obligationItemHref(item);
  const classLabel = OBLIGATION_CLASS_LABEL[item.class] ?? item.class;

  const content = (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <div className="min-w-0">
        <div className="text-text-secondary truncate">{label}</div>
        {date && (
          <div className="text-caption text-text-muted">
            {classLabel} · até {formatDate(date)}
          </div>
        )}
      </div>
      <div className="tabular text-text-primary font-medium shrink-0">{formatMoney(item.amount)}</div>
    </div>
  );

  // Item 13 — só card bill tem destino real hoje (/cartoes); nunca link fake.
  return href ? (
    <Link href={href} className="focus-ring -mx-2 block rounded-control px-2 transition-colors hover:bg-surface-3">
      {content}
    </Link>
  ) : (
    content
  );
}
