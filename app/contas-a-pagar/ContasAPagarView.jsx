"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { CATEGORIES } from "@/lib/categoryRules";

const STATUS_LABELS = { pending: "pendente", overdue: "atrasada", paid: "paga", cancelled: "cancelada" };
const STATUS_TONE = {
  pending: "bg-white/10 text-white/70",
  overdue: "bg-rose-500/10 text-rose-400",
  paid: "bg-emerald-500/10 text-emerald-400",
  cancelled: "bg-white/5 text-white/30",
};

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

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Contas a Pagar</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium transition-colors">
          + Nova conta
        </button>
      </header>

      {showForm && <BillForm accounts={accounts} onSubmit={createBill} onCancel={() => setShowForm(false)} />}

      <div className="flex gap-2 mb-4">
        {["all", "pending", "overdue", "paid", "cancelled"].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${statusFilter === s ? "bg-emerald-600 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"}`}
          >
            {s === "all" ? "Todas" : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-white/10 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="bg-white/5 text-left text-white/50">
              <th className="px-3 py-2">Descrição</th>
              <th className="px-3 py-2">Categoria</th>
              <th className="px-3 py-2">Vencimento</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 w-40"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-white/40">Nenhuma conta aqui.</td></tr>
            )}
            {filtered.map((bill) => (
              <tr key={bill.id} className="border-t border-white/5">
                <td className="px-3 py-2">{bill.description}</td>
                <td className="px-3 py-2 text-white/60">{bill.category}</td>
                <td className="px-3 py-2 text-white/60">{formatDate(bill.dueDate)}</td>
                <td className="px-3 py-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_TONE[bill.status]}`}>{STATUS_LABELS[bill.status]}</span>
                </td>
                <td className="px-3 py-2 text-right">{formatMoney(bill.amount)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {(bill.status === "pending" || bill.status === "overdue") && (
                    <>
                      <button onClick={() => setPayingId(payingId === bill.id ? null : bill.id)} className="text-emerald-400 hover:text-emerald-300 text-xs mr-3">
                        pagar
                      </button>
                      <button onClick={() => cancelBill(bill.id)} className="text-white/40 hover:text-white/70 text-xs mr-3">
                        cancelar
                      </button>
                    </>
                  )}
                  <button onClick={() => deleteBill(bill.id)} className="text-white/30 hover:text-rose-400" title="Excluir">✕</button>
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
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs">
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <button onClick={() => onPay(accountId)} className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-xs">Confirmar</button>
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
    <form onSubmit={submit} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-white/50 mb-1">Descrição</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-full" />
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
        <label className="block text-xs text-white/50 mb-1">Vencimento</label>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Conta de origem</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm">
          <option value="">—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
      <button type="submit" className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-sm font-medium">Salvar</button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-white/5 hover:bg-white/10 px-4 py-1.5 text-sm">Cancelar</button>
    </form>
  );
}
