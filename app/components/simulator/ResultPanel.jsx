"use client";

import { ArrowRight } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import Disclosure from "../ui/Disclosure.jsx";
import { FEASIBILITY_COPY, safetyBodyCopy, PROJECTION_CHECKPOINTS } from "@/lib/simulatorPresentation";

// Fase 6.0 (Design Freeze) — RESTYLE PURO sobre o mesmo `result` que
// /api/simulate sempre devolveu (lib/simulation/financialSimulator.js,
// compute-only, nunca reimplementado aqui). Nenhum número novo, nenhuma
// fórmula nova — só composição visual + copy sobre campos reais.
//
// Mapeamento dos 3 veredictos do mock (item central deste restyle):
// o mock aprovado pede 3 bandas de resultado ("Melhor não agora." /
// "Cabe, mas aperta." / "Pode comprar.") derivadas de "o dinheiro livre
// resultante". Em vez de inventar um threshold novo sobre freeMoney bruto
// (ex.: "mais negativo que -150"), reaproveitamos `result.verdict` —
// CANNOT_AUTHORIZE / NOT_SAFE / SAFE — que o engine já computa combinando
// cardFeasibility E budgetSafety (ver financialSimulator.js, bloco
// "Invariante explícita e obrigatória da Fase 5.3E"). Esse enum já é
// estritamente mais correto que um corte sobre freeMoney sozinho: ele
// distingue "o cartão nem autoriza" de "autoriza mas aperta o orçamento",
// uma diferença que um número só nunca capturaria. É a MESMA ideia de
// "mapeamento presentational sobre um bucket que o produto já faz"
// mencionada no pedido (financialStatus) — só que aqui o bucket certo já
// existe pronto, então reusamos em vez de recriar.
const VERDICT_BANDS = {
  CANNOT_AUTHORIZE: { headline: "Melhor não agora.", dot: "bg-sim-caution-1" },
  NOT_SAFE: { headline: "Cabe, mas aperta.", dot: "bg-sim-caution-2" },
  SAFE: { headline: "Pode comprar.", dot: "bg-accent" },
};

function monthLabel(billMonth) {
  const [y, m] = billMonth.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" }).replace(".", "");
}

export default function ResultPanel({ result }) {
  const band = VERDICT_BANDS[result.verdict] || VERDICT_BANDS.NOT_SAFE;
  const deltaFreeMoney = Number(result.delta.freeMoney);
  const isNegDelta = deltaFreeMoney < -0.005;
  const nextIncomeDate = result.baseline.nextIncomeCommitment?.periodStart;

  // "Peso nos próximos meses" — só quando o próprio motor devolve uma
  // projeção de mais de um mês (installmentSchedule, um valor real por
  // billMonth). O mock pede duas séries empilhadas (lime = esta compra,
  // cinza = já existia) — a API de simulação NUNCA devolve o total de
  // fatura já existente por mês (só cardFeasibility no snapshot atual e o
  // schedule da compra hipotética), então a série cinza foi OMITIDA em vez
  // de inventada; mostramos só a série real (esta compra) — ver relatório
  // final.
  const monthlySchedule = result.installmentSchedule && result.installmentSchedule.length > 1 ? result.installmentSchedule : null;
  const maxInstallment = monthlySchedule ? Math.max(...monthlySchedule.map((r) => Number(r.amount))) : 0;

  return (
    <div className="space-y-4">
      {/* Veredito — hero escuro, único módulo de destaque máximo da tela. */}
      <div className="rounded-card bg-ink text-white shadow-hero p-7">
        <div className="flex items-center gap-2 mb-3">
          <span className={`h-2.5 w-2.5 rounded-full ${band.dot}`} aria-hidden="true" />
          <span className="text-eyebrow text-white/60">Resposta</span>
        </div>
        <h2 className="text-page-title mb-3">{band.headline}</h2>
        <p className="text-body text-white/70">
          {isNegDelta
            ? `Depois dessa compra, seu dinheiro livre cai ${formatMoney(Math.abs(deltaFreeMoney))}, indo para ${formatMoney(result.simulated.freeMoney)}.`
            : `Seu dinheiro livre continua ${formatMoney(result.simulated.freeMoney)} depois dessa compra — praticamente sem mudança.`}
          {nextIncomeDate ? ` Sua próxima renda entra em ${formatDate(nextIncomeDate)}.` : ""}
        </p>
      </div>

      {/* Antes → Depois */}
      <div className="rounded-card bg-surface shadow-card p-6 sm:p-7">
        <div className="text-eyebrow text-text-muted mb-5">Antes e depois</div>
        <div className="flex items-start gap-3 sm:gap-6">
          <div className="flex-1 min-w-0 space-y-4">
            <div className="text-caption text-text-muted">Hoje</div>
            <Metric label="Dinheiro livre" value={result.baseline.freeMoney} />
            <Metric label="Seguro pra gastar hoje" value={result.baseline.safeToSpend} />
            {result.cardFeasibility && <Metric label="Limite disponível" value={result.cardFeasibility.availableLimitBefore} />}
          </div>
          <div className="pt-7 text-text-muted shrink-0">
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0 space-y-4">
            <div className="text-caption text-text-muted">Se comprar</div>
            <Metric label="Dinheiro livre" value={result.simulated.freeMoney} delta={result.delta.freeMoney} />
            <Metric label="Seguro pra gastar hoje" value={result.simulated.safeToSpend} delta={result.delta.safeToSpend} />
            {result.cardFeasibility && (
              <Metric
                label="Limite disponível"
                value={result.cardFeasibility.availableLimitAfter}
                delta={Number(result.cardFeasibility.availableLimitAfter) - Number(result.cardFeasibility.availableLimitBefore)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Feasibility (capacidade técnica do cartão) e safety (cabe no
          orçamento) sempre separados — nunca uma frase só fundindo os dois. */}
      <div className={`grid grid-cols-1 gap-3 ${result.cardFeasibility ? "sm:grid-cols-2" : ""}`}>
        {result.cardFeasibility && (
          <div className="rounded-card bg-surface shadow-card p-5">
            <div className="text-eyebrow text-text-muted mb-2">Capacidade do cartão</div>
            <div className={`text-sm font-medium mb-1 ${result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "text-text-primary" : "text-danger-text"}`}>
              {result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "O limite comporta" : "O limite não comporta"}
            </div>
            <p className="text-caption text-text-muted">{FEASIBILITY_COPY[result.cardFeasibility.verdict]}</p>
          </div>
        )}
        <div className="rounded-card bg-surface shadow-card p-5">
          <div className="text-eyebrow text-text-muted mb-2">Cabe no orçamento?</div>
          <div className={`text-sm font-medium mb-1 ${result.budgetSafety.verdict === "SAFE" ? "text-text-primary" : "text-warning-text"}`}>
            {result.budgetSafety.verdict === "SAFE" ? "Sim" : "Aperta"}
          </div>
          <p className="text-caption text-text-muted">{safetyBodyCopy(result.budgetSafety.verdict, result.baseline.status.status)}</p>
        </div>
      </div>

      {/* "O peso nos próximos meses" — só quando o motor devolve mesmo uma
          projeção de mais de um mês (parcelamento). Uma única série real
          (esta compra); ver comentário no topo do arquivo sobre a série
          "já existia" não existir na resposta da API. */}
      {monthlySchedule && (
        <div className="rounded-card bg-surface shadow-card p-6 sm:p-7">
          <div className="text-eyebrow text-text-muted mb-4">O peso nos próximos meses</div>
          <div className="space-y-2.5">
            {monthlySchedule.map((row) => {
              const pct = maxInstallment > 0 ? (Number(row.amount) / maxInstallment) * 100 : 0;
              return (
                <div key={row.number} className="flex items-center gap-3">
                  <div className="w-10 shrink-0 text-caption text-text-muted capitalize">{monthLabel(row.billMonth)}</div>
                  <div className="flex-1 h-2.5 rounded-pill bg-gray-2 overflow-hidden">
                    <div className="transition-bar h-full rounded-pill bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="w-20 shrink-0 text-right tabular text-caption text-text-secondary">{formatMoney(row.amount)}</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border-subtle">
            <span className="h-2.5 w-2.5 rounded-pill bg-accent" aria-hidden="true" />
            <span className="text-caption text-text-muted">esta compra</span>
          </div>
        </div>
      )}

      {/* Parcelas simuladas — detalhe por parcela (dueAt real), continua
          separado do módulo de peso mensal acima. */}
      {result.installmentSchedule && result.installmentSchedule.length > 0 && <InstallmentRail schedule={result.installmentSchedule} />}

      <ProjectionDeltaRail delta={result.delta.projectionCheckpoints.base} />

      {result.explanation?.length > 0 && (
        <div className="rounded-card bg-surface shadow-card p-5">
          <Disclosure summary="Como isso foi calculado">
            <ul className="pt-1 space-y-1.5">
              {result.explanation.map((line, i) => (
                <li key={i} className="text-caption text-text-muted">
                  {line}
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, delta }) {
  const hasDelta = delta != null;
  const isZero = hasDelta && Math.abs(delta) < 0.005;
  const isNeg = hasDelta && delta < 0;
  return (
    <div>
      <div className="text-caption text-text-muted mb-1">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`tabular text-metric-md ${Number(value) < 0 ? "text-danger-text" : "text-text-primary"}`}>{formatMoney(value)}</span>
        {hasDelta && (
          <span className={`text-caption rounded-pill px-1.5 py-0.5 ${isZero ? "text-text-muted bg-chip-bg" : isNeg ? "text-danger-text bg-danger-bg" : "text-positive bg-positive/10"}`}>
            {isZero ? "igual" : `${isNeg ? "" : "+"}${formatMoney(delta)}`}
          </span>
        )}
      </div>
    </div>
  );
}

function InstallmentRail({ schedule }) {
  const shown = schedule.slice(0, 3);
  const rest = schedule.slice(3);
  return (
    <div className="rounded-card bg-surface shadow-card p-6 sm:p-7">
      <div className="text-eyebrow text-text-muted mb-3">Parcelas simuladas</div>
      <div className="grid grid-cols-1 divide-y divide-border-subtle rounded-tile bg-surface-2 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {shown.map((row) => (
          <div key={row.number} className="p-3">
            <div className="text-caption text-text-muted">
              parcela {row.number}/{schedule.length}
            </div>
            <div className="tabular text-sm font-medium text-text-primary">{formatMoney(row.amount)}</div>
            <div className="text-caption text-text-muted">vence {formatDate(row.dueAt)}</div>
          </div>
        ))}
      </div>
      {rest.length > 0 && (
        <Disclosure summary={`ver todas as parcelas (${rest.length} mais)`} className="mt-2">
          <div className="divide-y divide-border-subtle pt-1">
            {rest.map((row) => (
              <div key={row.number} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="text-text-secondary">
                  parcela {row.number}/{schedule.length}
                </span>
                <span className="tabular text-text-primary">
                  {formatMoney(row.amount)} · {formatDate(row.dueAt)}
                </span>
              </div>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function ProjectionDeltaRail({ delta }) {
  return (
    <div className="rounded-card bg-surface shadow-card p-6 sm:p-7">
      <div className="text-eyebrow text-text-muted mb-3">Isso muda sua projeção em</div>
      <div className="grid grid-cols-1 divide-y divide-border-subtle rounded-tile bg-surface-2 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {PROJECTION_CHECKPOINTS.map(({ key, label }) => {
          const value = delta[key];
          const isZero = Math.abs(value) < 0.005;
          const isNeg = value < 0;
          return (
            <div key={key} className="p-3">
              <div className="text-caption text-text-muted">{label}</div>
              <div className={`tabular text-sm font-medium ${isZero ? "text-text-muted" : isNeg ? "text-danger-text" : "text-positive"}`}>
                {isZero ? "sem mudança" : `${isNeg ? "" : "+"}${formatMoney(value)}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
