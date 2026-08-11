"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";

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

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-6">Cartões</h1>

      {cards.length === 0 && <div className="text-white/40">Nenhum cartão cadastrado.</div>}

      {cards.map((card) => (
        <div key={card.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium text-lg">{card.name}</span>
            <button onClick={() => setEditing(editing === card.id ? null : card.id)} className="text-xs text-white/50 hover:text-white/80">
              {editing === card.id ? "cancelar" : "editar"}
            </button>
          </div>

          {editing === card.id ? (
            <EditCardForm card={card} onSave={(form) => saveEdit(card, form)} />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
              <Stat label="Limite" value={formatMoney(card.totalLimit)} />
              <Stat label="Disponível" value={formatMoney(card.availableLimit)} tone="emerald" />
              <Stat label="Fechamento" value={card.closingDay ? `dia ${card.closingDay}` : "não definido"} />
              <Stat label="Vencimento" value={`dia ${card.dueDay}`} />
            </div>
          )}

          <div className="text-xs text-white/50 mb-2">Faturas</div>
          <div className="rounded-lg border border-white/10 overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="bg-white/5 text-left text-white/50">
                  <th className="px-3 py-2">Ciclo</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Vence</th>
                  <th className="px-3 py-2 text-right">Valor</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {(bills[card.id] || []).map((bill) => (
                  <tr key={bill.id} className="border-t border-white/5">
                    <td className="px-3 py-2">{bill.cycleMonth}</td>
                    <td className="px-3 py-2 text-white/60">{new Date(bill.closesAt).toLocaleDateString("pt-BR")}</td>
                    <td className="px-3 py-2 text-white/60">{new Date(bill.dueAt).toLocaleDateString("pt-BR")}</td>
                    <td className="px-3 py-2 text-right">{formatMoney(bill.totalAmount)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        bill.status === "paid" ? "bg-emerald-500/10 text-emerald-400" : bill.status === "closed" ? "bg-amber-500/10 text-amber-400" : "bg-white/10 text-white/60"
                      }`}>
                        {bill.status === "paid" ? "paga" : bill.status === "closed" ? "fechada" : "aberta"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div>
      <div className="text-xs text-white/50">{label}</div>
      <div className={tone === "emerald" ? "text-emerald-400" : ""}>{value}</div>
    </div>
  );
}

function EditCardForm({ card, onSave }) {
  const [totalLimit, setTotalLimit] = useState(String(card.totalLimit));
  const [closingDay, setClosingDay] = useState(card.closingDay ? String(card.closingDay) : "");
  const [dueDay, setDueDay] = useState(String(card.dueDay));

  return (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <div>
        <label className="block text-xs text-white/50 mb-1">Limite total</label>
        <input value={totalLimit} onChange={(e) => setTotalLimit(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-28" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Dia de fechamento</label>
        <input value={closingDay} onChange={(e) => setClosingDay(e.target.value)} placeholder="?" className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-16" />
      </div>
      <div>
        <label className="block text-xs text-white/50 mb-1">Dia de vencimento</label>
        <input value={dueDay} onChange={(e) => setDueDay(e.target.value)} className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm w-16" />
      </div>
      <button onClick={() => onSave({ totalLimit, closingDay, dueDay })} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 text-sm font-medium">
        Salvar
      </button>
    </div>
  );
}
