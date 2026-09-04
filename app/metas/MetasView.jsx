"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";

const inputClass = "bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-info";

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function MetasView() {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/goals");
    setGoals(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function createGoal(form) {
    await fetch("/api/goals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    setShowForm(false);
    load();
  }

  async function addAmount(goalId, addAmount) {
    if (!addAmount) return;
    await fetch(`/api/goals/${goalId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addAmount }) });
    load();
  }

  async function removeGoal(goalId) {
    if (!confirm("Remover esta meta?")) return;
    await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
    load();
  }

  if (loading) {
    return (
      <div>
        <SkeletonBlock className="h-8 w-32 mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-40" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Metas</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-lg bg-positive hover:bg-positive-soft px-4 py-2 text-sm font-medium text-slate-950 transition-colors cursor-pointer">
          + Nova meta
        </button>
      </header>

      {showForm && <GoalForm onSubmit={createGoal} onCancel={() => setShowForm(false)} />}

      {goals.length === 0 && <div className="text-muted">Nenhuma meta ainda.</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {goals.map((goal) => (
          <GoalCard key={goal.id} goal={goal} onAdd={(v) => addAmount(goal.id, v)} onRemove={() => removeGoal(goal.id)} />
        ))}
      </div>
    </div>
  );
}

function GoalCard({ goal, onAdd, onRemove }) {
  const [addValue, setAddValue] = useState("");
  const pct = Math.min(100, Math.round((goal.savedAmount / goal.targetAmount) * 100));

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-white">{goal.name}</span>
        <button onClick={onRemove} className="text-muted hover:text-negative cursor-pointer" title="Remover" aria-label="Remover">
          <TrashIcon />
        </button>
      </div>
      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mb-2">
        <div className="h-full rounded-full bg-positive" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-muted mb-3 tabular">
        <span>{formatMoney(goal.savedAmount)} guardado</span>
        <span>falta {formatMoney(goal.remaining)}</span>
      </div>
      {goal.forecastDate && (
        <div className="text-xs text-muted mb-3">
          Previsão: {formatDate(goal.forecastDate)}
          {goal.forecastBasis === "taxa_media" ? " (pela taxa média)" : ""}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          placeholder="guardar mais..."
          className={`${inputClass} flex-1 text-xs py-1`}
        />
        <button
          onClick={() => {
            const v = parseFloat(addValue.replace(",", "."));
            if (Number.isFinite(v) && v !== 0) {
              onAdd(v);
              setAddValue("");
            }
          }}
          className="rounded bg-positive hover:bg-positive-soft text-slate-950 px-2 py-1 text-xs font-medium cursor-pointer transition-colors"
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

function GoalForm({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = parseFloat(targetAmount.replace(",", "."));
    if (!name || !Number.isFinite(value) || value <= 0) return;
    onSubmit({ name, targetAmount: value, targetDate: targetDate || undefined });
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-surface p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div>
        <label className="block text-xs text-muted mb-1">Nome</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Valor alvo</label>
        <input value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="0,00" className={`${inputClass} w-28`} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Data alvo (opcional)</label>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={inputClass} />
      </div>
      <button type="submit" className="rounded-lg bg-positive hover:bg-positive-soft px-4 py-1.5 text-sm font-medium text-slate-950 cursor-pointer transition-colors">Salvar</button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-surface-2 hover:bg-border px-4 py-1.5 text-sm text-slate-200 cursor-pointer transition-colors">Cancelar</button>
    </form>
  );
}
