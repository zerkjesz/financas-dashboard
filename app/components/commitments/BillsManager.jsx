"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { CATEGORIES } from "@/lib/categoryRules";
import { BILL_STATUS_LABEL, BILL_STATUS_BADGE_VARIANT } from "@/lib/commitmentsPresentation";
import Badge from "../ui/Badge.jsx";
import Button from "../ui/Button.jsx";
import Input from "../ui/Input.jsx";
import Select from "../ui/Select.jsx";

const STATUS_FILTERS = ["all", "pending", "overdue", "paid", "cancelled"];

// Fase 5.4D, item 33 — MESMA escrita de sempre (createBill/markBillPaid/
// cancelBill/deleteBill via as rotas /api/bills* já existentes) — só a
// apresentação muda pros primitives da 5.4B, e o layout vira linhas
// responsivas (não uma <table> de 6 colunas espremida em mobile — item 50
// aplicado aqui também, mesmo sendo o CRUD de Compromissos, não Histórico).
export default function BillsManager({ bills, accounts, onChanged }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [payingId, setPayingId] = useState(null);

  async function createBill(form) {
    await fetch("/api/bills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    setShowForm(false);
    onChanged();
  }
  async function payBill(billId, accountId) {
    await fetch(`/api/bills/${billId}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId }) });
    setPayingId(null);
    onChanged();
  }
  async function cancelBill(billId) {
    if (!confirm("Cancelar esta conta?")) return;
    await fetch(`/api/bills/${billId}/cancel`, { method: "POST" });
    onChanged();
  }
  async function deleteBill(billId) {
    if (!confirm("Excluir esta conta a pagar?")) return;
    await fetch(`/api/bills/${billId}`, { method: "DELETE" });
    onChanged();
  }

  const filtered = statusFilter === "all" ? bills : bills.filter((b) => b.status === statusFilter);

  return (
    <div className="rounded-card bg-surface-1 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-label text-text-muted">Gerenciar contas avulsas</h2>
        <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
          + Nova conta
        </Button>
      </div>

      {showForm && <BillForm accounts={accounts} onSubmit={createBill} onCancel={() => setShowForm(false)} />}

      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`focus-ring rounded-control px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              statusFilter === s ? "bg-surface-2 text-text-primary border border-border-strong" : "text-text-muted hover:text-text-primary hover:bg-surface-2/50"
            }`}
          >
            {s === "all" ? "Todas" : BILL_STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-body text-text-muted py-4">Nenhuma conta aqui.</p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {filtered.map((bill) => (
            <div key={bill.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <div className="min-w-0">
                  <div className="text-sm text-text-secondary truncate">{bill.description}</div>
                  <div className="text-caption text-text-muted">
                    {bill.category} · vence {formatDate(bill.dueDate)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="tabular text-sm font-medium text-text-primary">{formatMoney(bill.amount)}</span>
                  <Badge variant={BILL_STATUS_BADGE_VARIANT[bill.status]}>{BILL_STATUS_LABEL[bill.status]}</Badge>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {(bill.status === "pending" || bill.status === "overdue") && (
                  <>
                    <button onClick={() => setPayingId(payingId === bill.id ? null : bill.id)} className="focus-ring rounded-control text-xs font-medium text-positive hover:text-positive-soft cursor-pointer">
                      pagar
                    </button>
                    <button onClick={() => cancelBill(bill.id)} className="focus-ring rounded-control text-xs text-text-muted hover:text-text-primary cursor-pointer">
                      cancelar
                    </button>
                  </>
                )}
                <button onClick={() => deleteBill(bill.id)} className="focus-ring ml-auto rounded-control text-text-muted hover:text-danger cursor-pointer" title="Excluir" aria-label="Excluir">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
              {payingId === bill.id && (
                <div className="mt-2">
                  <PayForm accounts={accounts} defaultAccountId={bill.accountId} onPay={(accountId) => payBill(bill.id, accountId)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PayForm({ accounts, defaultAccountId, onPay }) {
  const [accountId, setAccountId] = useState(defaultAccountId || accounts[0]?.id || "");
  return (
    <div className="flex items-center gap-2 justify-end">
      <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-auto py-1 text-xs">
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <Button variant="primary" className="px-2 py-1 text-xs" onClick={() => onPay(accountId)}>
        Confirmar
      </Button>
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
    <form onSubmit={submit} className="rounded-control bg-surface-2 p-4 mb-4 flex flex-wrap gap-3 items-end">
      <div className="flex-1 min-w-[160px]">
        <label className="text-caption text-text-muted mb-1 block">Descrição</label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="text-caption text-text-muted mb-1 block">Valor</label>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" className="w-28" />
      </div>
      <div>
        <label className="text-caption text-text-muted mb-1 block">Categoria</label>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-auto">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="text-caption text-text-muted mb-1 block">Vencimento</label>
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-auto" />
      </div>
      <div>
        <label className="text-caption text-text-muted mb-1 block">Conta de origem</label>
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-auto">
          <option value="">—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit">Salvar</Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}
