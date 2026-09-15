"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — RESTYLE. 4º "group card" do design aprovado:
// mesma forma visual dos 3 grupos de CurrentHorizonSection.jsx (light card,
// icon tile + título + total à direita, linhas date/label/valor), mas
// nenhum valor deste grupo é um fato — todo valor leva o prefixo "~ "
// (item explícito do design: é a ÚNICA distinção tipográfica entre risco e
// confirmado, nunca uma cor nova). expectedExposure/maximumExposure/
// expectedAmount/maxAmount continuam vindo prontos de
// lib/productFinancialSnapshot.js (contingency), nunca recalculados aqui.
const GRID_COLS = "grid-cols-[64px_minmax(0,1fr)_84px] sm:grid-cols-[96px_minmax(0,1fr)_140px]";

function approx(value) {
  return `~ ${formatMoney(value)}`;
}

export default function RiskSection({ contingency }) {
  if (!contingency || !contingency.items || contingency.items.length === 0) return null;

  return (
    <div className="rounded-card bg-surface p-5 sm:p-7 shadow-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-warning-bg text-warning-text">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 className="text-card-title truncate text-text-primary">Riscos em aberto</h2>
        </div>
        <span className="text-eyebrow shrink-0 text-text-muted">não reduz dinheiro livre</span>
        <span className="tabular ml-auto shrink-0 text-metric-md text-text-primary">{approx(contingency.expectedExposure)}</span>
      </div>
      <p className="text-caption text-text-muted mb-3">máximo possível {approx(contingency.maximumExposure)}</p>

      <div className="mt-3">
        {contingency.items.map((item) => (
          <div key={item.id} className="border-t border-border-subtle py-3">
            <div className={`grid ${GRID_COLS} items-start gap-2`}>
              <span className="tabular text-xs text-text-muted">{item.expectedDate ? formatDate(item.expectedDate) : "—"}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm text-text-secondary">{item.description}</span>
                <span className="block text-caption text-text-muted">
                  máximo {approx(item.maxAmount)} · {item.expectedDate ? `previsto ${formatDate(item.expectedDate)}` : "timing desconhecido"}
                </span>
              </span>
              <span className="tabular text-right text-sm font-medium text-text-primary">
                {item.expectedAmount != null ? approx(item.expectedAmount) : "desconhecido"}
              </span>
            </div>
            {/* Fase 5.4E.1.1 — MEDIDO ao vivo: 20px real. pointer-coarse:min-h-11
                só em touch, mesma disciplina dos links equivalentes em
                FinancialHero.jsx/CardHero.jsx. */}
            <Link
              href={`/simulador?scenario=risk&contingencyId=${item.id}`}
              className="focus-ring mt-1.5 inline-flex items-center gap-1 rounded-control text-sm font-medium text-accent hover:text-accent-hover transition-colors pointer-coarse:min-h-11"
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
