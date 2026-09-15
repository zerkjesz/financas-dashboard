"use client";

import { formatMoney } from "@/lib/formatMoney";

const CHECKPOINTS = [
  { key: "day30", label: "30 dias" },
  { key: "day60", label: "60 dias" },
  { key: "day90", label: "90 dias" },
];

// Fase 6.0 (Design Freeze) — restyle pra "compact summary strip" (posição:
// acima da lista de eventos, dentro do fluxo da página) — mesmo dado real
// de sempre (checkpoints.base/expected/stress), só reapresentado como uma
// faixa curta em vez do card cheio que era antes. BASE ≠ garantia,
// EXPECTED/STRESS ≠ fatos continuam distintos: quando os 3 cenários batem
// pros checkpoints disponíveis, mostra só BASE + uma nota; quando divergem
// (o caso real de haver risco em aberto com data), mostra os 3 números.
export default function FlowCheckpoints({ checkpoints, horizonDays }) {
  const available = CHECKPOINTS.filter((c) => checkpoints.base[c.key] != null && dayFits(c.key, horizonDays));
  if (available.length === 0) return null;

  const scenariosDiffer = available.some((c) => {
    const b = Number(checkpoints.base[c.key].projectedCash);
    const e = Number(checkpoints.expected[c.key].projectedCash);
    const s = Number(checkpoints.stress[c.key].projectedCash);
    return Math.abs(b - e) > 0.01 || Math.abs(b - s) > 0.01;
  });

  return (
    <div className="rounded-card bg-surface shadow-card p-5 sm:p-6">
      <div className="flex flex-col divide-y divide-border-subtle sm:flex-row sm:items-center sm:divide-x sm:divide-y-0">
        {available.map(({ key, label }) => (
          <div key={key} className="py-3 first:pt-0 last:pb-0 sm:flex-1 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0">
            <div className="text-caption text-text-muted mb-1">Saldo em {label} (base)</div>
            <div className={`tabular text-base font-semibold ${Number(checkpoints.base[key].projectedCash) < 0 ? "text-danger-text" : "text-text-primary"}`}>
              {formatMoney(checkpoints.base[key].projectedCash)}
            </div>
          </div>
        ))}
      </div>

      {scenariosDiffer ? (
        <div className="mt-3 border-t border-border-subtle pt-3 space-y-1.5">
          <p className="text-caption text-text-muted">Cenário esperado e cenário de pressão (com o risco em aberto aplicado):</p>
          {available.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between text-caption text-text-muted">
              <span>{label}</span>
              <span className="tabular">
                esperado {formatMoney(checkpoints.expected[key].projectedCash)} · pressão {formatMoney(checkpoints.stress[key].projectedCash)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-caption text-text-muted mt-3 border-t border-border-subtle pt-3">
          Cenário esperado e de pressão batem com a base — nenhum risco em aberto com data prevista desloca esta trajetória.
        </p>
      )}
    </div>
  );
}

function dayFits(key, horizonDays) {
  const days = { day30: 30, day60: 60, day90: 90 }[key];
  return days <= horizonDays;
}
