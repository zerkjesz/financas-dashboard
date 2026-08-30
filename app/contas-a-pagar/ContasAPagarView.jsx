"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { CATEGORIES } from "@/lib/categoryRules";
import { SkeletonBlock } from "../components/Skeleton.jsx";

const STATUS_LABELS = { pending: "pendente", overdue: "atrasada", paid: "paga", cancelled: "cancelada" };
const STATUS_TONE = {
  pending: "bg-surface-2 text-slate-300",
  overdue: "bg-negative/15 text-negative",
  paid: "bg-positive/15 text-positive",
  cancelled: "bg-surface-2 text-muted",
};
const inputClass = "bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-info";

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2m2 0v13a2 2 0 01-2 2H9a2 2 0 01-2-2V7h10z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ContasAPagarView() {
  const [bills, setBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [payingId, setPayingId] = useState(null);

  async function load() {
    setLoading(true);
    const [billsRes, accountsRes] = await Promise.all([fetch("/api/bills"), fetch("/api/accounts")]);
    setBills(await billsRes.json());
    setAccounts(await accountsRes.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function createBill(form) {
    await fetch("/api/bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setShowForm(false);
    load();
  }

  async function payBill(billId, accountId) {
    await fetch(`/api/bills/${billId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    setPayingId(null);
    load();
  }

  async function cancelBill(billId) {
    if (!confirm("Cancelar esta conta?")) return;
    await fetch(`/api/bills/${billId}/cancel`, { method: "POST" });
    load();
  }

  async function deleteBill(billId) {
    if (!confirm("Excluir esta conta a pagar?")) return;
    await fetch(`/api/bills/${billId}`, { method: "DELETE" });
    load();
  }

  const filtered = statusFilter === "all" ? bills : bills.filter((b) => b.status === statusFilter);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <SkeletonBlock className="h-8 w-48 mb-6" />
        <SkeletonBlock className="h-56" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Contas a Pagar</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-lg bg-positive hover:bg-positive-soft px-4 py-2 text-sm font-medium text-slate-950 transition-colors cursor-pointer">
          + Nova conta
        </button>
      </header>

      {showForm && <BillForm accounts={accounts} onSubmit={createBill} onCancel={() => setShowForm(false)} />}

      <div className="flex gap-2 mb-4">
        {["all", "pending", "overdue", "paid", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors cursor-pointer ${statusFilter === s ? "bg-surface-2 text-white border border-border-strong" : "text-muted hover:text-white hover:bg-surface-2/50"}`}
          >
            {s === "all" ? "Todas" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="bg-surface-2 text-left text-muted text-xs uppercase tracking-wide">
              <th className="px-3 py-2.5 font-medium">Descrição</th>
              <th className="px-3 py-2.5 font-medium">Categoria</th>
              <th className="px-3 py-2.5 font-medium">Vencimento</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium text-right">Valor</th>
              <th className="px-3 py-2.5 w-40"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted">Nenhuma conta aqui.</td></tr>
            )}
            {filtered.map((bill) => (
              <tr key={bill.id}>
                <td className="px-3 py-2.5 text-slate-200">{bill.description}</td>
                <td className="px-3 py-2.5 text-muted">{bill.category}</td>
                <td className="px-3 py-2.5 text-muted">{formatDate(bill.dueDate)}</td>
                <td className="px-3 py-2.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_TONE[bill.status]}`}>{STATUS_LABELS[bill.status]}</span>
                </td>
                <td className="px-3 py-2.5 text-right tabular text-white">{formatMoney(bill.amount)}</td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">
                  {(bill.status === "pending" || bill.status === "overdue") && (
                    <>
                      <button onClick={() => setPayingId(payingId === bill.id ? null : bill.id)} className="text-positive hover:text-positive-soft text-xs mr-3 cursor-pointer">
                        pagar
                      </button>
                      <button onClick={() => cancelBill(bill.id)} className="text-muted hover:text-white text-xs mr-3 cursor-pointer">
                        cancelar
                      </button>
                    </>
                  )}
                  <button onClick={() => deleteBill(bill.id)} className="text-muted hover:text-negative cursor-pointer align-middle" title="Excluir" aria-label="Excluir">
                    <TrashIcon />
                  </button>
                  {payingId === bill.id && (
                    <div className="mt-2">
                      <PayForm accounts={accounts} defaultAccountId={bill.accountId} onPay={(accountId) => payBill(bill.id, accountId)} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PayForm({ accounts, defaultAccountId, onPay }) {
  const [accountId, setAccountId] = useState(defaultAccountId || accounts[0]?.id || "");
  return (
    <div className="flex items-center gap-2 justify-end">
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={`${inputClass} py-1 text-xs`}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <button onClick={() => onPay(accountId)} className="rounded bg-positive hover:bg-positive-soft text-slate-950 px-2 py-1 text-xs font-medium cursor-pointer">Confirmar</button>
    </div>
  );
}

function BillForm({ accounts, onSubmit, onCancel }) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Outros");
  const [dueDate, setDueDate] = useState("");
  const [accountId, setAccountId] = useState("");

  function submit(e) {
    e.preventDefault();
    const value = parseFloat(amount.replace(",", "."));
    if (!description || !Number.isFinite(value) || value <= 0 || !dueDate) return;
    onSubmit({ description, amount: value, category, dueDate, accountId: accountId || undefined });
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-surface p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-muted mb-1">Descrição</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputClass} w-full`} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Valor</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" className={`${inputClass} w-28`} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Categoria</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Vencimento</label>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Conta de origem</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputClass}>
          <option value="">—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded-lg bg-positive hover:bg-positive-soft px-4 py-1.5 text-sm font-medium text-slate-950 cursor-pointer transition-colors">Salvar</button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-surface-2 hover:bg-border px-4 py-1.5 text-sm text-slate-200 cursor-pointer transition-colors">Cancelar</button>
    </form>
  );
}
