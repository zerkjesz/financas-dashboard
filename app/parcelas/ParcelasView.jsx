"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/formatMoney";

export default function ParcelasView() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/purchases");
    setPurchases(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id) {
    if (!confirm("Excluir esta compra parcelada e todas as parcelas?")) return;
    await fetch(`/api/purchases/${id}`, { method: "DELETE" });
    load();
  }

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-8 text-white/40">Carregando...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-6">Parcelas</h1>

      {purchases.length === 0 && <div className="text-white/40">Nenhuma compra parcelada registrada.</div>}

      <div className="rounded-xl border border-white/10 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="bg-white/5 text-left text-white/50">
              <th className="px-3 py-2">Compra</th>
              <th className="px-3 py-2 text-right">Valor total</th>
              <th className="px-3 py-2 text-center">Parcelas</th>
              <th className="px-3 py-2 text-center">Atual</th>
              <th className="px-3 py-2 text-center">Restantes</th>
              <th className="px-3 py-2 text-right">Valor mensal</th>
              <th className="px-3 py-2">Última parcela</th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} className="border-t border-white/5">
                <td className="px-3 py-2">{p.description}</td>
                <td className="px-3 py-2 text-right">{formatMoney(p.totalAmount)}</td>
                <td className="px-3 py-2 text-center">{p.installmentCount}x</td>
                <td className="px-3 py-2 text-center">{p.currentInstallmentNumber}</td>
                <td className="px-3 py-2 text-center">{p.remainingInstallments}</td>
                <td className="px-3 py-2 text-right">{formatMoney(p.installmentValue)}</td>
                <td className="px-3 py-2 text-white/60">{p.lastInstallmentMonth}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => remove(p.id)} className="text-white/30 hover:text-rose-400" title="Excluir">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
