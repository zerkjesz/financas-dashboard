"use client";

import { useState } from "react";
import { CATEGORIES } from "@/lib/categoryRules";

const TYPES = [
  { value: "expense", label: "Despesa" },
  { value: "income", label: "Receita" },
  { value: "transfer", label: "Transferência" },
  { value: "installment_purchase", label: "Compra parcelada" },
  { value: "bill_payment", label: "Pagamento de fatura" },
  { value: "balance_adjustment", label: "Ajuste de saldo" },
  { value: "limit_update", label: "Ajuste de limite do cartão" },
];

const inputClass = "bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-slate-200 placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-info";

export default function AddForm({ accounts, cards, onSubmitted, onCancel }) {
  const [type, setType] = useState("expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Outros");
  const [description, setDescription] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [toAccountId, setToAccountId] = useState(accounts[0]?.id || "");
  const [payTarget, setPayTarget] = useState(accounts[0] ? `account:${accounts[0].id}` : "");
  const [cardId, setCardId] = useState(cards[0]?.id || "");
  const [installmentCount, setInstallmentCount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const value = parseFloat(amount.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) {
      setError("Informe um valor válido.");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      if (type === "income") {
        await postJson("/api/incomes", { amount: value, description, category, accountId, isRecurring });
      } else if (type === "expense") {
        const [kind, id] = payTarget.split(":");
        await postJson("/api/expenses", {
          amount: value,
          description,
          category,
          accountId: kind === "account" ? id : null,
          cardId: kind === "card" ? id : null,
          isRecurring,
        });
      } else if (type === "transfer") {
        await postJson("/api/transfers", { amount: value, description, fromAccountId: accountId, toAccountId });
      } else if (type === "installment_purchase") {
        const count = parseInt(installmentCount, 10);
        if (!count || count < 1) throw new Error("Informe a quantidade de parcelas.");
        await postJson("/api/purchases", { description, totalAmount: value, installmentCount: count, cardId, category });
      } else if (type === "bill_payment") {
        const card = cards.find((c) => c.id === cardId);
        if (!card?.currentBill) throw new Error("Fatura atual não encontrada.");
        // currentBill pode ser uma PROJEÇÃO (id: null, Fase 4.1.3) — usa um
        // placeholder na URL e manda cycleMonth pro backend materializar sob
        // demanda, só porque isto é um pagamento (mutação), nunca um GET.
        await postJson(`/api/cards/${cardId}/bills/${card.currentBill.id || "projected"}/pay`, {
          fromAccountId: accountId,
          amount: value,
          description,
          cycleMonth: card.currentBill.cycleMonth,
        });
      } else if (type === "balance_adjustment") {
        await postJson(`/api/accounts/${accountId}/adjustments`, { newBalance: value, note: description });
      } else if (type === "limit_update") {
        await postJson(`/api/cards/${cardId}/limit-updates`, { reportedAvailable: value, note: description });
      }
      onSubmitted();
    } catch (err) {
      setError(err.message || "Erro ao salvar.");
    } finally {
      setSubmitting(false);
    }
  }

  const amountLabel =
    type === "balance_adjustment" ? "Novo saldo" : type === "limit_update" ? "Limite disponível" : "Valor";

  return (
    <form onSubmit={submit} className="rounded-xl border border-border bg-surface p-4 mb-6 flex flex-wrap gap-3 items-end">
      <div>
        <label className="block text-xs text-muted mb-1">Tipo</label>
        <select value={type} onChange={(e) => setType(e.target.value)} className={inputClass}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">{amountLabel}</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" className={`${inputClass} w-28`} />
      </div>

      {(type === "income" || type === "expense" || type === "installment_purchase") && (
        <div>
          <label className="block text-xs text-muted mb-1">Categoria</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      )}

      {type === "income" && (
        <SelectField label="Conta" value={accountId} onChange={setAccountId} options={accounts.map((a) => [a.id, a.name])} />
      )}

      {type === "expense" && (
        <SelectField
          label="Pagar com"
          value={payTarget}
          onChange={setPayTarget}
          options={[
            ...accounts.map((a) => [`account:${a.id}`, a.name]),
            ...cards.map((c) => [`card:${c.id}`, `Cartão ${c.name}`]),
          ]}
        />
      )}

      {type === "transfer" && (
        <>
          <SelectField label="De" value={accountId} onChange={setAccountId} options={accounts.map((a) => [a.id, a.name])} />
          <SelectField label="Para" value={toAccountId} onChange={setToAccountId} options={accounts.map((a) => [a.id, a.name])} />
        </>
      )}

      {type === "installment_purchase" && (
        <>
          <SelectField label="Cartão" value={cardId} onChange={setCardId} options={cards.map((c) => [c.id, c.name])} />
          <div>
            <label className="block text-xs text-muted mb-1">Parcelas</label>
            <input value={installmentCount} onChange={(e) => setInstallmentCount(e.target.value)} placeholder="10" className={`${inputClass} w-20`} />
          </div>
        </>
      )}

      {type === "bill_payment" && (
        <>
          <SelectField label="Cartão" value={cardId} onChange={setCardId} options={cards.map((c) => [c.id, c.name])} />
          <SelectField label="Pagar com" value={accountId} onChange={setAccountId} options={accounts.map((a) => [a.id, a.name])} />
        </>
      )}

      {type === "balance_adjustment" && (
        <SelectField label="Conta" value={accountId} onChange={setAccountId} options={accounts.map((a) => [a.id, a.name])} />
      )}

      {type === "limit_update" && (
        <SelectField label="Cartão" value={cardId} onChange={setCardId} options={cards.map((c) => [c.id, c.name])} />
      )}

      <div className="flex-1 min-w-[160px]">
        <label className="block text-xs text-muted mb-1">Descrição</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex: mercado da semana" className={`${inputClass} w-full`} />
      </div>

      {(type === "income" || type === "expense") && (
        <label className="flex items-center gap-1.5 text-xs text-muted pb-2 cursor-pointer">
          <input type="checkbox" className="cursor-pointer accent-info" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
          Fixo/recorrente
        </label>
      )}

      {error && <div className="w-full text-xs text-negative">{error}</div>}

      <button type="submit" disabled={submitting} className="rounded-lg bg-positive hover:bg-positive-soft disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-slate-950 transition-colors cursor-pointer">
        {submitting ? "Salvando..." : "Salvar"}
      </button>
      <button type="button" onClick={onCancel} className="rounded-lg bg-surface-2 hover:bg-border px-4 py-1.5 text-sm text-slate-200 transition-colors cursor-pointer">
        Cancelar
      </button>
    </form>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        {options.map(([val, text]) => (
          <option key={val} value={val}>{text}</option>
        ))}
      </select>
    </div>
  );
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Erro ao salvar.");
  }
  return res.json();
}
