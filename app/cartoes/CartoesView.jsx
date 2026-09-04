"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/formatMoney";
import { SkeletonBlock } from "../components/Skeleton.jsx";

const STATUS_STYLE = {
  paid: "bg-positive/15 text-positive",
  closed: "bg-warning/15 text-warning",
  open: "bg-surface-2 text-slate-300",
};
const STATUS_LABEL = { paid: "paga", closed: "fechada", open: "aberta" };

export default function CartoesView() {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [bills, setBills] = useState({});
  const [editing, setEditing] = useState(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/cards");
    const data = await res.json();
    setCards(data);
    const billsByCard = {};
    for (const card of data) {
      const r = await fetch(`/api/cards/${card.id}/bills`);
      billsByCard[card.id] = await r.json();
    }
    setBills(billsByCard);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function saveEdit(card, form) {
    await fetch(`/api/cards/${card.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalLimit: parseFloat(form.totalLimit),
        closingDay: form.closingDay ? parseInt(form.closingDay, 10) : null,
        dueDay: parseInt(form.dueDay, 10),
      }),
    });
    setEditing(null);
    load();
  }

  if (loading) {
    return (
      <div>
        <SkeletonBlock className="h-8 w-40 mb-6" />
        <SkeletonBlock className="h-56" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Cartões</h1>

      {cards.length === 0 && <div className="text-muted">Nenhum cartão cadastrado.</div>}

      {cards.map((card) => {
        const usedPct = card.totalLimit > 0 ? Math.min(100, (1 - card.availableLimit / card.totalLimit) * 100) : 0;
        return (
          <div key={card.id} className="rounded-xl border border-border bg-surface p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="font-medium text-lg text-white">{card.name}</span>
              <button onClick={() => setEditing(editing === card.id ? null : card.id)} className="text-xs text-muted hover:text-white cursor-pointer">
                {editing === card.id ? "cancelar" : "editar"}
              </button>
            </div>

            {editing === card.id ? (
              <EditCardForm card={card} onSave={(form) => saveEdit(card, form)} />
            ) : (
              <>
                <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden mb-1.5">
                  <div className="h-full rounded-full bg-info" style={{ width: `${usedPct}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted mb-4">
                  <span className="tabular">{formatMoney(card.availableLimit)} disponível de {formatMoney(card.totalLimit)}</span>
                  <span>fecha {card.closingDay ? `dia ${card.closingDay}` : "—"} · vence dia {card.dueDay}</span>
                </div>
              </>
            )}

            <div className="text-xs font-medium text-muted mb-2 uppercase tracking-wide">Faturas</div>
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead>
                  <tr className="bg-surface-2 text-left text-muted text-xs uppercase tracking-wide">
                    <th className="px-3 py-2 font-medium">Ciclo</th>
                    <th className="px-3 py-2 font-medium">Fecha</th>
                    <th className="px-3 py-2 font-medium">Vence</th>
                    <th className="px-3 py-2 font-medium text-right">Valor</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(bills[card.id] || []).map((bill) => (
                    <tr key={bill.id}>
                      <td className="px-3 py-2 text-slate-200">{bill.cycleMonth}</td>
                      <td className="px-3 py-2 text-muted">{formatDate(bill.closesAt)}</td>
                      <td className="px-3 py-2 text-muted">{formatDate(bill.dueAt)}</td>
                      <td className="px-3 py-2 text-right tabular text-white">{formatMoney(bill.totalAmount)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[bill.status] || STATUS_STYLE.open}`}>
                          {STATUS_LABEL[bill.status] || bill.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EditCardForm({ card, onSave }) {
  const [totalLimit, setTotalLimit] = useState(String(card.totalLimit));
  const [closingDay, setClosingDay] = useState(card.closingDay ? String(card.closingDay) : "");
  const [dueDay, setDueDay] = useState(String(card.dueDay));
  const inputClass = "bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-info";

  return (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <div>
        <label className="block text-xs text-muted mb-1">Limite total</label>
        <input value={totalLimit} onChange={(e) => setTotalLimit(e.target.value)} className={`${inputClass} w-28`} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Dia de fechamento</label>
        <input value={closingDay} onChange={(e) => setClosingDay(e.target.value)} placeholder="?" className={`${inputClass} w-16`} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Dia de vencimento</label>
        <input value={dueDay} onChange={(e) => setDueDay(e.target.value)} className={`${inputClass} w-16`} />
      </div>
      <button onClick={() => onSave({ totalLimit, closingDay, dueDay })} className="rounded-lg bg-positive hover:bg-positive-soft px-4 py-1.5 text-sm font-medium text-slate-950 cursor-pointer transition-colors">
        Salvar
      </button>
    </div>
  );
}
