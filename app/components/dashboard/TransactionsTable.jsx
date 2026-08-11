"use client";

import { useMemo, useState } from "react";
import { CATEGORIES } from "@/lib/categoryRules";
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
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm">
          <option value="all">Todos os meses</option>
          {availableMonths.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm">
          <option value="all">Tudo</option>
          <option value="income">Receitas</option>
          <option value="expense">Gastos</option>
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar descrição..."
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[140px]"
        />

        <button onClick={() => downloadCsv(filtered)} className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm transition-colors">
          Exportar CSV
        </button>

        {selected.size > 0 && (
          <button onClick={deleteSelected} className="rounded-lg bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 px-3 py-1.5 text-sm transition-colors">
            Excluir selecionados ({selected.size})
          </button>
        )}
      </div>

      <div className="rounded-xl border border-white/10 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="bg-white/5 text-left text-white/50">
              <th className="px-3 py-2 w-8">
                <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleSelectAll} />
              </th>
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">Descrição</th>
              <th className="px-3 py-2">Categoria</th>
              <th className="px-3 py-2">Conta/Cartão</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-white/40">Nenhum registro ainda.</td></tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="px-3 py-2">
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelect(e.id)} />
                </td>
                <td className="px-3 py-2 text-white/60 whitespace-nowrap">{new Date(e.occurredAt).toLocaleDateString("pt-BR")}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {e.isRecurring && <span title="Fixo/recorrente">🔁</span>}
                    <span>{e.description}</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select value={e.category} onChange={(ev) => updateCategory(e, ev.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs">
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={e.cardId ? `card:${e.cardId}` : e.accountId ? `account:${e.accountId}` : ""}
                    onChange={(ev) => updateTarget(e, ev.target.value)}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs"
                  >
                    {targetOptions.map(([val, text]) => (
                      <option key={val} value={val}>{text}</option>
                    ))}
                  </select>
                </td>
                <td className={`px-3 py-2 text-right font-medium whitespace-nowrap ${e.type === "income" ? "text-emerald-400" : "text-rose-400"}`}>
                  {e.type === "income" ? "+" : "-"}{formatMoney(e.amount)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => deleteOne(e)} className="text-white/30 hover:text-rose-400 transition-colors" title="Excluir">✕</button>
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
