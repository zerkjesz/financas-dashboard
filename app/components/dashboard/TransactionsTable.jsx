"use client";

import { useMemo, useState } from "react";
import { CATEGORIES, CATEGORY_COLORS } from "@/lib/categoryRules";
import { formatMoney, monthKey } from "@/lib/formatMoney";
import ConfirmDialog from "../ConfirmDialog.jsx";

function downloadCsv(entries) {
  const header = ["Data", "Tipo", "Valor", "Categoria", "Conta/Cartão", "Fixo", "Descrição"];
  const rows = entries.map((e) => [
    new Date(e.occurredAt).toLocaleDateString("pt-BR"),
    e.type === "income" ? "Receita" : "Gasto",
    e.amount.toFixed(2).replace(".", ","),
    e.category,
    e.targetName,
    e.isRecurring ? "Sim" : "",
    `"${(e.description || "").replace(/"/g, '""')}"`,
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

const selectClass = "bg-surface-2 border border-border rounded-md px-2 py-1 text-xs text-slate-200 cursor-pointer focus:outline-none focus:ring-1 focus:ring-info";
const inputClass = "bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-info";

function RecurringIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-info shrink-0" aria-hidden="true">
      <path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function TransactionsTable({ entries, accounts, cards, onChanged }) {
  const [selected, setSelected] = useState(new Set());
  const [monthFilter, setMonthFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [confirmDialog, setConfirmDialog] = useState(null);

  const availableMonths = useMemo(() => {
    const set = new Set(entries.map((e) => monthKey(e.occurredAt)));
    return Array.from(set).sort().reverse();
  }, [entries]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (monthFilter !== "all" && monthKey(e.occurredAt) !== monthFilter) return false;
      if (typeFilter !== "all" && e.type !== typeFilter) return false;
      if (term && !e.description.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [entries, monthFilter, typeFilter, search]);

  function toggleSelect(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map((e) => e.id)));
  }

  async function deleteEntry(entry) {
    const url = entry.type === "income" ? `/api/incomes/${entry.id}` : `/api/expenses/${entry.id}`;
    await fetch(url, { method: "DELETE" });
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    const targets = filtered.filter((e) => selected.has(e.id));
    setConfirmDialog({
      message: `Excluir ${selected.size} registro(s)?`,
      onConfirm: async () => {
        await Promise.all(targets.map(deleteEntry));
        setSelected(new Set());
        setConfirmDialog(null);
        onChanged();
      },
    });
  }

  function deleteOne(entry) {
    setConfirmDialog({
      message: "Excluir este registro?",
      onConfirm: async () => {
        await deleteEntry(entry);
        setConfirmDialog(null);
        onChanged();
      },
    });
  }

  async function updateCategory(entry, category) {
    const url = entry.type === "income" ? `/api/incomes/${entry.id}` : `/api/expenses/${entry.id}`;
    await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category }) });
    onChanged();
  }

  async function updateTarget(entry, value) {
    const [kind, id] = value.split(":");
    if (entry.type === "income") {
      await fetch(`/api/incomes/${entry.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: id }) });
    } else {
      await fetch(`/api/expenses/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: kind === "account" ? id : null, cardId: kind === "card" ? id : null }),
      });
    }
    onChanged();
  }

  const targetOptions = [
    ...accounts.map((a) => [`account:${a.id}`, a.name]),
    ...cards.map((c) => [`card:${c.id}`, `Cartão ${c.name}`]),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 mb-4">
        <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className={`${inputClass} py-1.5`}>
          <option value="all">Todos os meses</option>
          {availableMonths.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${inputClass} py-1.5`}>
          <option value="all">Tudo</option>
          <option value="income">Receitas</option>
          <option value="expense">Gastos</option>
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar descrição..."
          className={`${inputClass} flex-1 min-w-[140px]`}
        />

        <button onClick={() => downloadCsv(filtered)} className="rounded-lg border border-border bg-surface-2 hover:bg-border px-3 py-1.5 text-sm text-slate-200 transition-colors cursor-pointer">
          Exportar CSV
        </button>

        {selected.size > 0 && (
          <button onClick={deleteSelected} className="rounded-lg bg-negative/15 text-negative hover:bg-negative/25 px-3 py-1.5 text-sm transition-colors cursor-pointer">
            Excluir selecionados ({selected.size})
          </button>
        )}
      </div>

      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="bg-surface-2 text-left text-muted text-xs uppercase tracking-wide">
              <th className="px-3 py-2.5 w-8">
                <input type="checkbox" className="cursor-pointer accent-info" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleSelectAll} />
              </th>
              <th className="px-3 py-2.5 font-medium">Data</th>
              <th className="px-3 py-2.5 font-medium">Descrição</th>
              <th className="px-3 py-2.5 font-medium">Categoria</th>
              <th className="px-3 py-2.5 font-medium">Conta/Cartão</th>
              <th className="px-3 py-2.5 font-medium text-right">Valor</th>
              <th className="px-3 py-2.5 w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted">Nenhum registro ainda.</td></tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="hover:bg-surface-2/50 transition-colors">
                <td className="px-3 py-2">
                  <input type="checkbox" className="cursor-pointer accent-info" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} />
                </td>
                <td className="px-3 py-2 text-muted whitespace-nowrap tabular text-xs">{new Date(e.occurredAt).toLocaleDateString("pt-BR")}</td>
                <td className="px-3 py-2 max-w-[280px]">
                  <div className="flex items-center gap-1.5">
                    {e.isRecurring && <RecurringIcon />}
                    <span className="truncate text-slate-200">{e.description}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[e.category] || CATEGORY_COLORS.Outros }} />
                    <select value={e.category} onChange={(ev) => updateCategory(e, ev.target.value)} className={selectClass}>
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={e.cardId ? `card:${e.cardId}` : e.accountId ? `account:${e.accountId}` : ""}
                    onChange={(ev) => updateTarget(e, ev.target.value)}
                    className={selectClass}
                  >
                    {targetOptions.map(([val, text]) => (
                      <option key={val} value={val}>{text}</option>
                    ))}
                  </select>
                </td>
                <td className={`px-3 py-2 text-right font-medium tabular whitespace-nowrap ${e.type === "income" ? "text-positive" : "text-white"}`}>
                  {e.type === "income" ? "+" : "-"}{formatMoney(e.amount)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => deleteOne(e)} className="text-muted hover:text-negative transition-colors cursor-pointer" title="Excluir" aria-label="Excluir">
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDialog && (
        <ConfirmDialog message={confirmDialog.message} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />
      )}
    </>
  );
}
