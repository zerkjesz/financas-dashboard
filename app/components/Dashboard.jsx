"use client";

import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, PAYMENT_METHODS } from "@/lib/parseTransaction";

const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map((p) => [p.value, p.label]));

const CHART_COLORS = [
  "bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-rose-500",
  "bg-violet-500", "bg-cyan-500", "bg-white/30",
];

function formatMoney(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function downloadCsv(transactions) {
  const header = ["Data", "Tipo", "Valor", "Categoria", "Forma de pagamento", "Fixo", "Descrição"];
  const rows = transactions.map((t) => [
    new Date(t.occurredAt).toLocaleDateString("pt-BR"),
    t.type === "income" ? "Receita" : "Gasto",
    t.amount.toFixed(2).replace(".", ","),
    t.category,
    t.paymentMethod ? PAYMENT_LABELS[t.paymentMethod] : "",
    t.isRecurring ? "Sim" : "",
    `"${(t.description || "").replace(/"/g, '""')}"`,
  ]);
  const csv = [header, ...rows].map((r) => r.join(";")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `financas-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Dashboard() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [monthFilter, setMonthFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/transactions");
    const data = await res.json();
    setTransactions(data);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const availableMonths = useMemo(() => {
    const set = new Set(transactions.map((t) => monthKey(t.occurredAt)));
    return Array.from(set).sort().reverse();
  }, [transactions]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (monthFilter !== "all" && monthKey(t.occurredAt) !== monthFilter) return false;
      if (typeFilter !== "all" && t.type !== typeFilter) return false;
      if (paymentFilter !== "all" && t.paymentMethod !== paymentFilter) return false;
      if (term && !t.description.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [transactions, monthFilter, typeFilter, paymentFilter, search]);

  const summary = useMemo(() => {
    const income = filtered.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = filtered.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    return { income, expense, balance: income - expense };
  }, [filtered]);

  const categoryBreakdown = useMemo(() => {
    const totals = new Map();
    for (const t of filtered) {
      if (t.type !== "expense") continue;
      totals.set(t.category, (totals.get(t.category) || 0) + t.amount);
    }
    const entries = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    const max = entries.length > 0 ? entries[0][1] : 0;
    return { entries, max };
  }, [filtered]);

  const topExpenses = useMemo(() => {
    return filtered
      .filter((t) => t.type === "expense")
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);
  }, [filtered]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((t) => t.id)));
    }
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    setConfirmDialog({
      message: `Excluir ${selected.size} registro(s)?`,
      onConfirm: async () => {
        await fetch("/api/transactions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: Array.from(selected) }),
        });
        setSelected(new Set());
        setConfirmDialog(null);
        load();
      },
    });
  }

  function clearAll() {
    setConfirmDialog({
      message: "Isso vai apagar TODOS os registros. Tem certeza?",
      onConfirm: async () => {
        await fetch("/api/transactions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ all: true }),
        });
        setSelected(new Set());
        setConfirmDialog(null);
        load();
      },
    });
  }

  async function updateTransaction(id, data) {
    await fetch(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    load();
  }

  function deleteOne(id) {
    setConfirmDialog({
      message: "Excluir este registro?",
      onConfirm: async () => {
        await fetch(`/api/transactions/${id}`, { method: "DELETE" });
        setConfirmDialog(null);
        load();
      },
    });
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Finanças</h1>
        <div className="flex gap-2">
          <button
            onClick={() => downloadCsv(filtered)}
            className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-2 text-sm transition-colors"
          >
            Exportar CSV
          </button>
          <button
            onClick={() => setShowAddForm((v) => !v)}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium transition-colors"
          >
            + Adicionar registro
          </button>
        </div>
      </header>

      {showAddForm && (
        <AddForm
          onAdd={async (data) => {
            await fetch("/api/transactions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            });
            setShowAddForm(false);
            load();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryCard label="Receitas" value={summary.income} tone="emerald" />
        <SummaryCard label="Gastos" value={summary.expense} tone="rose" />
        <SummaryCard label="Saldo" value={summary.balance} tone={summary.balance >= 0 ? "emerald" : "rose"} />
      </div>

      {categoryBreakdown.entries.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
          <div className="text-sm text-white/50 mb-3">Gastos por categoria</div>
          <div className="space-y-2">
            {categoryBreakdown.entries.map(([category, total], i) => (
              <div key={category} className="flex items-center gap-3">
                <div className="w-28 text-xs text-white/70 shrink-0 truncate">{category}</div>
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${CHART_COLORS[i % CHART_COLORS.length]}`}
                    style={{ width: `${(total / categoryBreakdown.max) * 100}%` }}
                  />
                </div>
                <div className="w-24 text-xs text-white/70 text-right shrink-0">{formatMoney(total)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {topExpenses.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
          <div className="text-sm text-white/50 mb-3">Maiores gastos do período</div>
          <div className="space-y-1.5">
            {topExpenses.map((t) => (
              <div key={t.id} className="flex items-center justify-between text-sm">
                <span className="text-white/70 truncate pr-4">{t.description}</span>
                <span className="text-rose-400 font-medium shrink-0">{formatMoney(t.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="all">Todos os meses</option>
          {availableMonths.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="all">Tudo</option>
          <option value="income">Receitas</option>
          <option value="expense">Gastos</option>
        </select>

        <select
          value={paymentFilter}
          onChange={(e) => setPaymentFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="all">Qualquer pagamento</option>
          {PAYMENT_METHODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar descrição..."
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[140px]"
        />

        {selected.size > 0 && (
          <button
            onClick={deleteSelected}
            className="rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 px-3 py-1.5 text-sm transition-colors"
          >
            Excluir selecionados ({selected.size})
          </button>
        )}

        <button
          onClick={clearAll}
          className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm text-white/70 transition-colors"
        >
          Limpar tudo
        </button>
      </div>

      <div className="rounded-xl border border-white/10 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="bg-white/5 text-left text-white/50">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && selected.size === filtered.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">Descrição</th>
              <th className="px-3 py-2">Categoria</th>
              <th className="px-3 py-2">Pagamento</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-white/40">Carregando...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-white/40">Nenhum registro ainda.</td></tr>
            )}
            {filtered.map((t) => (
              <tr key={t.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={() => toggleSelect(t.id)}
                  />
                </td>
                <td className="px-3 py-2 text-white/60 whitespace-nowrap">
                  {new Date(t.occurredAt).toLocaleDateString("pt-BR")}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {t.isRecurring && <span title="Fixo/recorrente">🔁</span>}
                    <span>{t.description}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={t.category}
                    onChange={(e) => updateTransaction(t.id, { category: e.target.value })}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={t.paymentMethod || ""}
                    onChange={(e) => updateTransaction(t.id, { paymentMethod: e.target.value || null })}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs"
                  >
                    <option value="">—</option>
                    {PAYMENT_METHODS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </td>
                <td className={`px-3 py-2 text-right font-medium whitespace-nowrap ${t.type === "income" ? "text-emerald-400" : "text-rose-400"}`}>
                  {t.type === "income" ? "+" : "-"}{formatMoney(t.amount)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteOne(t.id)}
                    className="text-white/30 hover:text-rose-400 transition-colors"
                    title="Excluir"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#12161c] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-white/90 mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-sm font-medium transition-colors"
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }) {
  const toneClass = tone === "emerald" ? "text-emerald-400" : "text-rose-400";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs text-white/50 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${toneClass}`}>{formatMoney(value)}</div>
    </div>
  );
}

function AddForm({ onAdd, onCancel }) {
  const [type, setType] = useState("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Outros");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [description, setDescription] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = parseFloat(amount.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return;
    onAdd({ type, amount: value, category, paymentMethod: paymentMethod || null, isRecurring, description });
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div>
        <label className="block text-xs text-white/50 mb-1">Tipo</label>
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm">
          <option value="expense">Gasto</option>
          <option value="income">Receita</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Valor</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-28" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Categoria</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Pagamento</label>
        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm">
          <option value="">—</option>
          {PAYMENT_METHODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-white/50 mb-1">Descrição</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex: mercado da semana" className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-full" />
      </div>
      <label className="flex items-center gap-1.5 text-xs text-white/60 pb-2">
        <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
        Fixo/recorrente
      </label>
      <button type="submit" className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-sm font-medium transition-colors">Salvar</button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-white/5 hover:bg-white/10 px-4 py-1.5 text-sm transition-colors">Cancelar</button>
    </form>
  );
}
