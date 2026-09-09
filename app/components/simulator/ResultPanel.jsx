"use client";

import { CircleDashed } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import Badge from "../ui/Badge.jsx";
import Disclosure from "../ui/Disclosure.jsx";
import HypotheticalAmbientSurface from "./HypotheticalAmbientSurface.jsx";
import { STATUS_COPY, VERDICT_COPY, FEASIBILITY_COPY, safetyBodyCopy, PROJECTION_CHECKPOINTS } from "@/lib/simulatorPresentation";

const VERDICT_TEXT_CLASS = { positive: "text-positive", warning: "text-warning", danger: "text-danger" };
const VERDICT_BAR_CLASS = { positive: "bg-positive", warning: "bg-warning", danger: "bg-danger" };

// Fase 5.4E — RESULT HERO (item 21): depois de simular, o resultado vira o
// foco visual único. Estrutura conceitual ANTES → DEPOIS → DECISÃO, nunca
// 8 KPI cards iguais (item 38, card wall check). Item 1 — CENÁRIO SIMULADO
// nunca se confunde com o real: hairline hypothetical no topo do painel
// inteiro (mesmo vocabulário do hairline de status da Home, cor diferente),
// label permanente "CENÁRIO SIMULADO" — não é só cor, é label + estrutura.
export default function ResultPanel({ result }) {
  const verdict = VERDICT_COPY[result.verdict] || VERDICT_COPY.NOT_SAFE;
  const statusCopy = STATUS_COPY[result.simulated.status.status] ?? STATUS_COPY.ATENCAO;

  return (
    <div className="relative overflow-hidden rounded-card bg-surface-2 p-6 sm:p-7">
      {/* Fase 5.4E.1 — assinatura visual do cenário simulado (item 4/24):
          atmosfera extremamente sutil, progressive enhancement (item 11) —
          sem isso, o painel continua idêntico ao de 5.4E, 100% funcional.
          Fica ANTES do hairline/label na ordem do DOM só por organização;
          z-index:-1 embutido no próprio componente garante que renderiza
          atrás de tudo, nunca por cima do texto (item 8). */}
      <HypotheticalAmbientSurface />
      <div className="absolute inset-x-0 top-0 h-[3px] bg-hypothetical/70" aria-hidden="true" />

      <div className="flex items-center gap-2 mb-1">
        <span className="h-2 w-2 rounded-full bg-hypothetical" aria-hidden="true" />
        <span className="text-label text-hypothetical">Cenário simulado</span>
      </div>
      <h2 className={`text-page-title mb-1.5 ${VERDICT_TEXT_CLASS[verdict.tone]}`}>{verdict.label}</h2>
      <div className="flex items-center gap-2 mb-6">
        <span className="text-caption text-text-muted">situação simulada:</span>
        <Badge variant={result.simulated.status.status === "TRANQUILO" ? "positive" : result.simulated.status.status === "ATENCAO" ? "warning" : "danger"}>{statusCopy.label}</Badge>
      </div>

      {/* ANTES → DEPOIS — rail vertical com direção explícita, nunca uma
          tabela fria de 2 colunas competindo com a Home. */}
      <div className="rounded-lg bg-surface-1/70 p-4 mb-6">
        <BeforeAfterRow label="Dinheiro livre" before={result.baseline.freeMoney} after={result.simulated.freeMoney} delta={result.delta.freeMoney} />
        <BeforeAfterRow label="Seguro pra gastar hoje" before={result.baseline.safeToSpend} after={result.simulated.safeToSpend} delta={result.delta.safeToSpend} last />
      </div>

      {/* Feasibility (item 26, restricted/neutral — nunca green gigante) e
          Safety (item 27, semantic, copy factual) SEMPRE separados, lado a
          lado quando ambos existem — nunca uma frase só fundindo os dois. */}
      <div className={`grid grid-cols-1 gap-3 mb-6 ${result.cardFeasibility ? "sm:grid-cols-2" : ""}`}>
        {result.cardFeasibility && (
          <div className="rounded-lg bg-surface-1 p-4">
            <div className="text-label text-text-muted mb-2">Capacidade do cartão</div>
            <div className={`text-sm font-medium mb-1 ${result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "text-restricted" : "text-danger"}`}>
              {result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "O limite comporta" : "O limite não comporta"}
            </div>
            <p className="text-caption text-text-muted">{FEASIBILITY_COPY[result.cardFeasibility.verdict]}</p>
            <div className="mt-2 text-caption text-text-muted">
              disponível depois: <span className="tabular text-text-secondary">{formatMoney(result.cardFeasibility.availableLimitAfter)}</span>
            </div>
          </div>
        )}
        <div className="rounded-lg bg-surface-1 p-4">
          <div className="text-label text-text-muted mb-2">Cabe no orçamento?</div>
          <div className={`text-sm font-medium mb-1 ${result.budgetSafety.verdict === "SAFE" ? "text-positive" : "text-warning"}`}>
            {result.budgetSafety.verdict === "SAFE" ? "Sim" : "Aperta"}
          </div>
          <p className="text-caption text-text-muted">{safetyBodyCopy(result.budgetSafety.verdict, result.baseline.status.status)}</p>
        </div>
      </div>

      {/* Item 28/29 — parcelas: rail compacto, nunca tabela gigante nem
          runoff duplicado (esse detalhe pertence a Compromissos). */}
      {result.installmentSchedule && result.installmentSchedule.length > 0 && <InstallmentRail schedule={result.installmentSchedule} />}

      {/* Item 30 — delta de projeção compacto, mesma linguagem de Fluxo
          (checkpoints 30/60/90), nunca um segundo gráfico. */}
      <ProjectionDeltaRail delta={result.delta.projectionCheckpoints.base} />

      {result.explanation?.length > 0 && (
        <Disclosure summary="Como isso foi calculado" className="mt-6 border-t border-border-subtle pt-4">
          <ul className="pt-1 space-y-1.5">
            {result.explanation.map((line, i) => (
              <li key={i} className="text-caption text-text-muted">
                {line}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

function BeforeAfterRow({ label, before, after, delta, last = false }) {
  const isZero = Math.abs(delta) < 0.005;
  const isNeg = delta < 0;
  return (
    <div className={`${last ? "" : "mb-4 border-b border-border-subtle pb-4"}`}>
      <div className="text-caption text-text-muted mb-1.5">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular text-sm text-text-muted line-through decoration-border-strong">{formatMoney(before)}</span>
        <span className="text-text-muted" aria-hidden="true">
          →
        </span>
        <span className={`tabular text-metric-md ${after < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(after)}</span>
        <span className={`text-caption ${isZero ? "text-text-muted" : isNeg ? "text-danger" : "text-positive"}`}>
          ({isZero ? "sem mudança" : `${isNeg ? "" : "+"}${formatMoney(delta)}`})
        </span>
      </div>
    </div>
  );
}

function InstallmentRail({ schedule }) {
  const shown = schedule.slice(0, 3);
  const rest = schedule.slice(3);
  return (
    <div className="mb-6">
      <div className="text-label text-text-muted mb-2">Parcelas simuladas</div>
      <div className="grid grid-cols-1 divide-y divide-border-subtle rounded-lg bg-surface-1 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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
    <div>
      <div className="text-label text-text-muted mb-2">Isso muda sua projeção em</div>
      <div className="grid grid-cols-1 divide-y divide-border-subtle rounded-lg bg-surface-1 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {PROJECTION_CHECKPOINTS.map(({ key, label }) => {
          const value = delta[key];
          const isZero = Math.abs(value) < 0.005;
          const isNeg = value < 0;
          return (
            <div key={key} className="p-3">
              <div className="text-caption text-text-muted">{label}</div>
              <div className={`tabular text-sm font-medium ${isZero ? "text-text-muted" : isNeg ? "text-danger" : "text-positive"}`}>
                {isZero ? "sem mudança" : `${isNeg ? "" : "+"}${formatMoney(value)}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
