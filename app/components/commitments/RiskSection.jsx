"use client";

import Link from "next/link";
import { CircleDashed, ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4D, itens 31/32 — mesma linguagem visual de RiskSurface na Home
// (borda tracejada, ícone tracejado, nunca preenchimento sólido de alerta):
// risco é informação válida mas incerta, nunca um fato. expectedAmount/
// maxAmount/expectedDate mostrados separados — nunca resumidos num único
// número que finja certeza.
//
// Fase 5.4E, item 13/45 — o link genérico "Simular o cenário de pressão"
// (sem contingencyId) foi substituído por um "Simular este risco" POR
// ITEM, que é o prefill contextual real que o comentário acima já previa
// pra esta fase: routes com `?scenario=risk&contingencyId=<id real>`, o
// Simulador valida o id contra a lista real antes de pré-preencher (nunca
// confia cegamente na query string) e NUNCA auto-executa — só troca pra
// aba "Risco virar realidade" com o risco já selecionado; o usuário ainda
// aperta "Simular".
export default function RiskSection({ contingency }) {
  if (!contingency || !contingency.items || contingency.items.length === 0) return null;

  return (
    <div className="rounded-card border border-dashed border-warning/30 bg-surface-1 p-6">
      <div className="flex items-center gap-2 mb-1">
        <CircleDashed className="h-4 w-4 text-warning" aria-hidden="true" />
        <h2 className="text-label text-text-muted">Riscos em aberto — não reduz dinheiro livre</h2>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-caption text-text-muted mb-4">
        <span>esperado {formatMoney(contingency.expectedExposure)}</span>
        <span>máximo {formatMoney(contingency.maximumExposure)}</span>
      </div>

      <div className="space-y-3">
        {contingency.items.map((item) => (
          <div key={item.id} className="text-sm border-t border-border-subtle/60 pt-3 first:border-t-0 first:pt-0">
            <div className="text-text-secondary">{item.description}</div>
            <div className="text-caption text-text-muted mb-2">
              esperado {item.expectedAmount != null ? formatMoney(item.expectedAmount) : "desconhecido"} · máximo {formatMoney(item.maxAmount)} ·{" "}
              {item.expectedDate ? `previsto ${formatDate(item.expectedDate)}` : "timing desconhecido"}
            </div>
            {/* Fase 5.4E.1.1 — MEDIDO ao vivo: 20px real. pointer-coarse:min-h-11
                só em touch, mesma disciplina dos links equivalentes em
                FinancialHero.jsx/CardHero.jsx. */}
            <Link
              href={`/simulador?scenario=risk&contingencyId=${item.id}`}
              className="focus-ring inline-flex items-center gap-1 rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors pointer-coarse:min-h-11"
            >
              Simular este risco
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
