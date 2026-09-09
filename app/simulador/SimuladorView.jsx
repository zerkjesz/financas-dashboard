"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.3E — tela MÍNIMA do simulador (explicitamente NÃO é redesign):
// reaproveita os mesmos tokens visuais do resto do dashboard (rounded-xl
// border-border bg-surface, tabular, text-muted, cores de status já usadas em
// FinancialTruthPanel.jsx) — nenhuma identidade visual nova. Todo número
// exibido aqui vem de /api/simulate, que só COMPÕE lib/simulation/
// financialSimulator.js — nenhum cálculo financeiro acontece neste arquivo.

const inputClass = "bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-info w-full";
const labelClass = "text-xs text-muted mb-1 block";

const SCENARIO_TABS = [
  { type: "CASH_EXPENSE_NOW", label: "Gasto em dinheiro/débito" },
  { type: "CARD_PURCHASE_SINGLE", label: "Compra no cartão (à vista)" },
  { type: "CARD_PURCHASE_INSTALLMENTS", label: "Compra parcelada no cartão" },
  { type: "CONTINGENCY_REALIZATION", label: "Contingência virar gasto real" },
];

const STATUS_STYLE = {
  TRANQUILO: { label: "Tranquilo", classes: "bg-positive/15 text-positive border-positive/30" },
  ATENCAO: { label: "Atenção", classes: "bg-warning/15 text-warning border-warning/30" },
  APERTADO: { label: "Apertado", classes: "bg-warning/15 text-warning border-warning/30" },
  CRITICO: { label: "Crítico", classes: "bg-negative/15 text-negative border-negative/30" },
};

const VERDICT_STYLE = {
  SAFE: { label: "Seguro", classes: "bg-positive/15 text-positive border-positive/30" },
  NOT_SAFE: { label: "Não seguro pro orçamento", classes: "bg-negative/15 text-negative border-negative/30" },
  CANNOT_AUTHORIZE: { label: "Cartão não autorizaria (limite insuficiente)", classes: "bg-negative/15 text-negative border-negative/30" },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] || STATUS_STYLE.ATENCAO;
  return <span className={`text-xs font-medium px-2 py-1 rounded border ${style.classes}`}>{style.label}</span>;
}

function DeltaValue({ value }) {
  const isNeg = value < 0;
  const isZero = Math.abs(value) < 0.005;
  return <span className={`tabular font-medium ${isZero ? "text-muted" : isNeg ? "text-negative" : "text-positive"}`}>{isZero ? "sem mudança" : `${isNeg ? "" : "+"}${formatMoney(value)}`}</span>;
}

function ComparisonRow({ label, before, after }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-border last:border-0 items-center">
      <div className="text-sm text-muted">{label}</div>
      <div className="tabular text-sm text-slate-300">{formatMoney(before)}</div>
      <div className="tabular text-sm font-medium text-white">{formatMoney(after)}</div>
    </div>
  );
}

export default function SimuladorView() {
  const [scenarioType, setScenarioType] = useState("CASH_EXPENSE_NOW");
  const [cards, setCards] = useState([]);
  const [contingencies, setContingencies] = useState([]);
  const [form, setForm] = useState({ amount: "", totalAmount: "", installmentCount: "6", cardId: "", contingencyId: "", amountField: "expected", timing: "NOW", description: "" });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/cards")
      .then((r) => r.json())
      .then((data) => setCards(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((data) => setContingencies(data?.financial?.contingency?.items || []))
      .catch(() => {});
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSimulate(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    let payload = { type: scenarioType };
    if (scenarioType === "CASH_EXPENSE_NOW") {
      payload.amount = Number(form.amount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CARD_PURCHASE_SINGLE") {
      payload.cardId = form.cardId;
      payload.amount = Number(form.amount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CARD_PURCHASE_INSTALLMENTS") {
      payload.cardId = form.cardId;
      payload.totalAmount = Number(form.totalAmount);
      payload.installmentCount = Number(form.installmentCount);
      if (form.description) payload.description = form.description;
    } else if (scenarioType === "CONTINGENCY_REALIZATION") {
      payload.contingencyId = form.contingencyId;
      payload.timing = form.timing;
      if (form.amount) payload.amount = Number(form.amount);
      else payload.amountField = form.amountField;
    }

    try {
      const res = await fetch("/api/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Erro ao simular");
      } else {
        setResult(data);
      }
    } catch {
      setError("Erro de rede ao simular");
    } finally {
      setLoading(false);
    }
  }

  const verdictStyle = result ? VERDICT_STYLE[result.verdict] || VERDICT_STYLE.NOT_SAFE : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white mb-1">Simulador financeiro</h1>
        <p className="text-sm text-muted">
          Responde &quot;e se...&quot; usando exatamente a mesma verdade financeira do dashboard.{" "}
          <span className="text-slate-300 font-medium">Simulação não altera seus dados</span> — nenhum lançamento é criado.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {SCENARIO_TABS.map((tab) => (
          <button
            key={tab.type}
            type="button"
            onClick={() => {
              setScenarioType(tab.type);
              setResult(null);
              setError(null);
            }}
            className={`text-sm px-3 py-1.5 rounded-lg border cursor-pointer transition-colors ${
              scenarioType === tab.type ? "bg-surface-2 border-border-strong text-white" : "border-border text-muted hover:text-white hover:bg-surface"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSimulate} className="rounded-xl border border-border bg-surface p-4 space-y-4">
        {(scenarioType === "CARD_PURCHASE_SINGLE" || scenarioType === "CARD_PURCHASE_INSTALLMENTS") && (
          <div>
            <label className={labelClass}>Cartão</label>
            <select className={inputClass} value={form.cardId} onChange={(e) => set("cardId", e.target.value)} required>
              <option value="">Selecione um cartão</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — limite disponível {formatMoney(c.availableLimit)}
                </option>
              ))}
            </select>
          </div>
        )}

        {(scenarioType === "CASH_EXPENSE_NOW" || scenarioType === "CARD_PURCHASE_SINGLE") && (
          <div>
            <label className={labelClass}>Valor (R$)</label>
            <input className={inputClass} type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => set("amount", e.target.value)} required />
          </div>
        )}

        {scenarioType === "CARD_PURCHASE_INSTALLMENTS" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Valor total (R$)</label>
              <input className={inputClass} type="number" step="0.01" min="0.01" value={form.totalAmount} onChange={(e) => set("totalAmount", e.target.value)} required />
            </div>
            <div>
              <label className={labelClass}>Número de parcelas</label>
              <input className={inputClass} type="number" step="1" min="1" max="60" value={form.installmentCount} onChange={(e) => set("installmentCount", e.target.value)} required />
            </div>
          </div>
        )}

        {scenarioType === "CONTINGENCY_REALIZATION" && (
          <>
            <div>
              <label className={labelClass}>Contingência</label>
              <select className={inputClass} value={form.contingencyId} onChange={(e) => set("contingencyId", e.target.value)} required>
                <option value="">Selecione uma contingência</option>
                {contingencies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.description} (esperado {c.expectedAmount != null ? formatMoney(c.expectedAmount) : "—"}, máximo {formatMoney(c.maxAmount)})
                  </option>
                ))}
              </select>
              {contingencies.length === 0 && <p className="text-xs text-muted mt-1">Nenhuma contingência cadastrada ainda.</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Valor (opcional — em branco usa o valor abaixo)</label>
                <input className={inputClass} type="number" step="0.01" min="0.01" placeholder="ex: 1200" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Se em branco, usar</label>
                <select className={inputClass} value={form.amountField} onChange={(e) => set("amountField", e.target.value)} disabled={!!form.amount}>
                  <option value="expected">Valor esperado</option>
                  <option value="max">Valor máximo</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelClass}>Quando isso aconteceria?</label>
              <select className={inputClass} value={form.timing === "NOW" ? "NOW" : "DATE"} onChange={(e) => set("timing", e.target.value === "NOW" ? "NOW" : "")}>
                <option value="NOW">Agora</option>
                <option value="DATE">Em uma data específica</option>
              </select>
              {form.timing !== "NOW" && (
                <input className={`${inputClass} mt-2`} type="date" value={form.timing} onChange={(e) => set("timing", new Date(`${e.target.value}T00:00:00.000Z`).toISOString())} required />
              )}
            </div>
          </>
        )}

        {scenarioType !== "CONTINGENCY_REALIZATION" && (
          <div>
            <label className={labelClass}>Descrição (opcional)</label>
            <input className={inputClass} type="text" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="ex: Notebook novo" />
          </div>
        )}

        <button type="submit" disabled={loading} className="bg-info text-slate-950 font-medium text-sm px-4 py-2 rounded-lg cursor-pointer disabled:opacity-50 hover:brightness-110 transition">
          {loading ? "Simulando..." : "Simular"}
        </button>
      </form>

      {error && <div className="rounded-lg border border-negative/30 bg-negative/10 text-negative text-sm p-3">{error}</div>}

      {result && (
        <div className="space-y-4">
          <div className={`rounded-xl border p-4 flex items-center justify-between gap-3 ${verdictStyle.classes}`}>
            <span className="font-medium text-sm">{verdictStyle.label}</span>
            <StatusBadge status={result.simulated.status.status} />
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="grid grid-cols-3 gap-2 pb-2 border-b border-border-strong text-xs text-muted font-medium">
              <div>Indicador</div>
              <div>Hoje (real)</div>
              <div>Simulado</div>
            </div>
            <ComparisonRow label="Dinheiro livre (freeMoney)" before={result.baseline.freeMoney} after={result.simulated.freeMoney} />
            <ComparisonRow label="Seguro pra gastar (safeToSpend)" before={result.baseline.safeToSpend} after={result.simulated.safeToSpend} />
            <ComparisonRow label="Dívida já incorrida (cartão)" before={result.baseline.incurredLiabilities} after={result.simulated.incurredLiabilities} />
            <ComparisonRow
              label="Comprometido da próxima renda"
              before={result.baseline.nextIncomeCommitment.committedAmount}
              after={result.simulated.nextIncomeCommitment.committedAmount}
            />
          </div>

          {result.cardFeasibility && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="text-sm font-medium text-white mb-3">Limite do cartão ({result.cardFeasibility.cardName}) — CARD_FEASIBILITY</div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted">Disponível antes</div>
                  <div className="tabular text-slate-200">{formatMoney(result.cardFeasibility.availableLimitBefore)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted">Disponível depois</div>
                  <div className="tabular text-slate-200">{formatMoney(result.cardFeasibility.availableLimitAfter)}</div>
                </div>
              </div>
              <div className={`mt-3 text-xs font-medium px-2 py-1 rounded border inline-block ${result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "bg-positive/15 text-positive border-positive/30" : "bg-negative/15 text-negative border-negative/30"}`}>
                {result.cardFeasibility.verdict === "CAN_AUTHORIZE" ? "Cartão autorizaria" : `Cartão NÃO autorizaria — faltam ${formatMoney(result.cardFeasibility.shortfall)}`}
              </div>
              <p className="text-xs text-muted mt-2">
                Isto é só a capacidade técnica do cartão — separado de saber se cabe no seu orçamento (ver abaixo).
              </p>
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="text-sm font-medium text-white mb-2">Cabe no orçamento? (BUDGET_SAFETY)</div>
            <p className="text-sm text-muted">
              {result.budgetSafety.verdict === "SAFE"
                ? "Sim — a situação financeira simulada continua Tranquila ou em Atenção."
                : "Não — a situação financeira simulada ficaria Apertada ou Crítica."}
            </p>
          </div>

          {result.installmentSchedule && (
            <div className="rounded-xl border border-border bg-surface p-4 overflow-x-auto">
              <div className="text-sm font-medium text-white mb-3">Parcelas simuladas</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted text-left">
                    <th className="pb-2">Parcela</th>
                    <th className="pb-2">Valor</th>
                    <th className="pb-2">Ciclo</th>
                    <th className="pb-2">Vencimento</th>
                  </tr>
                </thead>
                <tbody>
                  {result.installmentSchedule.map((row) => (
                    <tr key={row.number} className="border-t border-border">
                      <td className="py-1.5 text-slate-300">{row.number}</td>
                      <td className="py-1.5 tabular text-slate-200">{formatMoney(row.amount)}</td>
                      <td className="py-1.5 text-muted">{row.billMonth}</td>
                      <td className="py-1.5 text-muted">{formatDate(row.dueAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="text-sm font-medium text-white mb-2">Impacto na projeção (cenário base)</div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted">Daqui 30 dias</div>
                <DeltaValue value={result.delta.projectionCheckpoints.base.day30} />
              </div>
              <div>
                <div className="text-xs text-muted">Daqui 60 dias</div>
                <DeltaValue value={result.delta.projectionCheckpoints.base.day60} />
              </div>
              <div>
                <div className="text-xs text-muted">Daqui 90 dias</div>
                <DeltaValue value={result.delta.projectionCheckpoints.base.day90} />
              </div>
            </div>
          </div>

          {result.explanation?.length > 0 && (
            <div className="rounded-xl border border-border bg-surface-2/40 p-4">
              <div className="text-xs text-muted font-medium mb-2">Como isso foi calculado</div>
              <ul className="space-y-1">
                {result.explanation.map((line, i) => (
                  <li key={i} className="text-sm text-slate-300">
                    • {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
