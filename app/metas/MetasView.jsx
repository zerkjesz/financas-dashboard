"use client";

import { useEffect, useState } from "react";
import { PiggyBank, Target, Trash2, Plus } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";
import Button from "../components/ui/Button.jsx";
import Input from "../components/ui/Input.jsx";

// Fase 6.0 (restyle Metas) — wiring de dados 100% preservado (GET/POST/PATCH/
// DELETE em /api/goals, já existente — ver app/api/goals/route.js e
// app/api/goals/[id]/route.js). Só a apresentação muda.
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
        <div className="space-y-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-40" />
        </div>
      </div>
    );
  }

  // Fase 6.0 — "featured" (card escuro/destaque) é uma escolha de
  // APRESENTAÇÃO, não uma regra financeira: exatamente 1 meta por tela ganha
  // o tratamento dark-hero — a que está com maior % concluído (mais perto de
  // bater). Empate → a primeira encontrada (ordem já vem de lib/goals.js:
  // createdAt asc, preservada).
  const featuredId =
    goals.length > 0
      ? goals.reduce((best, g) => {
          const pct = g.targetAmount > 0 ? g.savedAmount / g.targetAmount : 0;
          const bestPct = best.targetAmount > 0 ? best.savedAmount / best.targetAmount : 0;
          return pct > bestPct ? g : best;
        }, goals[0]).id
      : null;

  return (
    <div>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <p className="text-eyebrow text-text-muted mb-1.5">Metas</p>
          <h1 className="text-page-title text-text-primary">Para onde está indo</h1>
        </div>
        {/* Item necessário além do mock aprovado: o design de referência só
            mostrava o CTA "Criar meta" no estado vazio (nunca exercitou o
            fluxo com metas já existentes). Com metas existentes, precisa
            existir uma forma de criar mais uma — botão secundário
            persistente perto do header. */}
        {goals.length > 0 && (
          <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nova meta
          </Button>
        )}
      </header>

      {showForm && <GoalForm onSubmit={createGoal} onCancel={() => setShowForm(false)} />}

      {goals.length === 0 && !showForm && (
        <div className="rounded-card bg-surface shadow-card p-10 flex flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-tile bg-surface-3">
            <Target className="h-5 w-5 text-text-muted" aria-hidden="true" />
          </div>
          <p className="text-section-title text-text-primary mb-1">Nenhuma meta ainda</p>
          <p className="text-caption text-text-secondary mb-5 max-w-xs">
            Escolha algo que você quer comprar e o Norte acompanha o quanto falta.
          </p>
          <Button variant="accent" onClick={() => setShowForm(true)}>
            Criar meta
          </Button>
        </div>
      )}

      <div className="space-y-4">
        {goals.map((goal) => (
          <GoalCard key={goal.id} goal={goal} featured={goal.id === featuredId} onAdd={(v) => addAmount(goal.id, v)} onRemove={() => removeGoal(goal.id)} />
        ))}
      </div>
    </div>
  );
}

function GoalCard({ goal, featured, onAdd, onRemove }) {
  const [addValue, setAddValue] = useState("");
  const pct = goal.targetAmount > 0 ? Math.min(100, Math.round((goal.savedAmount / goal.targetAmount) * 100)) : 0;

  return (
    <div className={`rounded-card p-7 ${featured ? "bg-ink text-white shadow-hero" : "bg-surface shadow-card"}`}>
      {/* Desktop: 2 colunas (conteúdo | números). Mobile: empilhado (item do
          spec — "same vertical stack, single-column card content"). */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(230px,300px)] gap-6 md:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile ${featured ? "bg-accent/20" : "bg-surface-3"}`}>
              <PiggyBank className={`h-4 w-4 ${featured ? "text-accent" : "text-text-secondary"}`} aria-hidden="true" />
            </div>
            <span className={`text-section-title truncate ${featured ? "text-white" : "text-text-primary"}`}>{goal.name}</span>
            <button
              onClick={onRemove}
              className={`focus-ring ml-auto shrink-0 rounded-control p-1.5 cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${
                featured ? "text-white/50 hover:text-white" : "text-text-muted hover:text-text-primary"
              }`}
              title="Remover"
              aria-label={`Remover meta ${goal.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* goal.notes é real (Goal.notes no schema) — sem fallback
              fabricado: se não existir, a linha simplesmente não aparece. */}
          {goal.notes && <p className={`text-caption mb-3 ${featured ? "text-white/70" : "text-text-secondary"}`}>{goal.notes}</p>}

          <div className={`h-2 overflow-hidden rounded-pill ${featured ? "bg-white/15" : "bg-track"}`}>
            <div className={`h-full rounded-pill transition-bar ${featured ? "bg-accent" : "bg-ink"}`} style={{ width: `${pct}%` }} />
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-4">
            <Input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder="Guardar mais..."
              aria-label={`Guardar mais em ${goal.name}`}
              className={`w-36 ${featured ? "!bg-white/10 !border-white/15 !text-white placeholder:!text-white/40" : ""}`}
            />
            <Button
              variant={featured ? "accent" : "secondary"}
              onClick={() => {
                const v = parseFloat(addValue.replace(",", "."));
                if (Number.isFinite(v) && v !== 0) {
                  onAdd(v);
                  setAddValue("");
                }
              }}
            >
              Guardar
            </Button>
          </div>
        </div>

        {/* "Já tem" / "Falta" — savedAmount e remaining reais (remaining já
            vem floor(0) de lib/goals.js: estimateGoalForecast, nunca
            recalculado aqui). */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className={`text-eyebrow mb-1 ${featured ? "text-white/50" : "text-text-muted"}`}>Já tem</p>
            <p className={`text-metric-md tabular ${featured ? "text-white" : "text-text-primary"}`}>{formatMoney(goal.savedAmount)}</p>
          </div>
          <div>
            <p className={`text-eyebrow mb-1 ${featured ? "text-white/50" : "text-text-muted"}`}>Falta</p>
            <p className={`text-metric-md tabular ${featured ? "text-white" : "text-text-primary"}`}>{formatMoney(goal.remaining)}</p>
          </div>
        </div>
      </div>

      {goal.forecastDate && (
        <p className={`text-caption mt-4 ${featured ? "text-white/50" : "text-text-muted"}`}>
          Previsão: {formatDate(goal.forecastDate)}
          {goal.forecastBasis === "taxa_media" ? " (pela taxa média)" : ""}
        </p>
      )}
    </div>
  );
}

function GoalForm({ onSubmit, onCancel }) {
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [notes, setNotes] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = parseFloat(targetAmount.replace(",", "."));
    if (!name || !Number.isFinite(value) || value <= 0) return;
    onSubmit({ name, targetAmount: value, targetDate: targetDate || undefined, notes: notes || undefined });
  }

  return (
    <form onSubmit={submit} className="rounded-card bg-surface shadow-card p-6 mb-6 flex flex-wrap gap-3 items-end">
      <div className="min-w-[160px] flex-1">
        <label className="text-eyebrow text-text-muted mb-1.5 block">Nome</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: Viagem pra praia" />
      </div>
      <div>
        <label className="text-eyebrow text-text-muted mb-1.5 block">Valor alvo</label>
        <Input value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="0,00" className="w-28" />
      </div>
      <div>
        <label className="text-eyebrow text-text-muted mb-1.5 block">Data alvo (opcional)</label>
        <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="w-40" />
      </div>
      <div className="min-w-[180px] flex-1">
        <label className="text-eyebrow text-text-muted mb-1.5 block">Notas (opcional)</label>
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex: economizar 500/mês" />
      </div>
      <Button type="submit" variant="accent">
        Salvar
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}
