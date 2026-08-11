"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

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

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Metas</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium transition-colors">
          + Nova meta
        </button>
      </header>

      {showForm && <GoalForm onSubmit={createGoal} onCancel={() => setShowForm(false)} />}

      {goals.length === 0 && <div className="text-white/40">Nenhuma meta ainda.</div>}

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
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium">{goal.name}</span>
        <button onClick={onRemove} className="text-white/30 hover:text-rose-400 text-xs">✕</button>
      </div>
      <div className="h-2 rounded-full bg-white/5 overflow-hidden mb-2">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-white/60 mb-3">
        <span>{formatMoney(goal.savedAmount)} guardado</span>
        <span>falta {formatMoney(goal.remaining)}</span>
      </div>
      {goal.forecastDate && (
        <div className="text-xs text-white/40 mb-3">
          Previsão: {formatDate(goal.forecastDate)}
          {goal.forecastBasis === "taxa_media" ? " (pela taxa média)" : ""}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          placeholder="guardar mais..."
          className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs flex-1"
        />
        <button
          onClick={() => {
            const v = parseFloat(addValue.replace(",", "."));
            if (Number.isFinite(v) && v !== 0) {
              onAdd(v);
              setAddValue("");
            }
          }}
          className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs"
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
    <form onSubmit={submit} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div>
        <label className="block text-xs text-white/50 mb-1">Nome</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Valor alvo</label>
        <input value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="0,00" className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-28" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Data alvo (opcional)</label>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm" />
      </div>
      <button type="submit" className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-sm font-medium">Salvar</button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-white/5 hover:bg-white/10 px-4 py-1.5 text-sm">Cancelar</button>
    </form>
  );
}
