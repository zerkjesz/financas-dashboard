"use client";
import { useState } from "react";
import { fmt } from "./format.js";

// Fase 10.6 — "Repasses do Caju": gastos que saíram do Itaú/cartão mas deveriam ter saído do Caju. NÃO é despesa nem receita: é uma
// obrigação interna (Caju → Itaú). O saldo real do Caju só muda quando o usuário confirma o repasse ("Marcar repasse como feito"),
// que cria UM Transfer Caju → Itaú (idempotente). Enquanto pendente, mostra só "disponível após repasses" (leitura).
export default function RepassesCaju({ data, onChanged }) {
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  if (!data || (data.items.length === 0 && !note)) return null;

  async function settle(item) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/compromissos/repasses/liquidar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.message || "Não consegui registrar o repasse.");
      setNote(j.status === "ALREADY_SETTLED" ? "Esse repasse já estava feito." : `Repasse de ${fmt(item.amount)} registrado: saiu do Caju e entrou no Itaú.`);
      setConfirming(null);
      onChanged?.();
    } catch (e) {
      setError(e.message || "Não consegui registrar o repasse.");
    }
    setBusy(false);
  }

  return (
    <section className="n4-card n4-repasses" aria-label="Repasses do Caju" data-testid="repasses-caju">
      <div className="n4-repasses-head">
        <div>
          <div className="n4-mono" style={{ color: "#6e747b", fontSize: 10.5, letterSpacing: "0.15em" }}>REPASSES DO CAJU</div>
          <h2 className="n4-repasses-title">{data.items.length > 0 ? `${fmt(data.pendingTotal)} pendentes` : "Nenhum repasse pendente"}</h2>
        </div>
        {data.items.length > 0 && <span className="n4-chip is-warn">{data.items.length} {data.items.length === 1 ? "repasse" : "repasses"}</span>}
      </div>
      {data.items.length > 0 && (
        <p className="n4-repasses-sub">Gastos que saíram do Itaú mas deveriam ter saído do Caju. Não é despesa nem receita: é dinheiro do Caju voltando ao Itaú.</p>
      )}
      <div className="n4-repasses-balance">
        <div><div className="l">Saldo do Caju (real)</div><div className="v n4-tab">{fmt(data.accountBalance)}</div></div>
        <div><div className="l">Após os repasses</div><div className="v n4-tab">{fmt(data.availableAfterPending)}</div></div>
      </div>
      <ul className="n4-repasses-list">
        {data.items.map((it) => (
          <li key={it.id} className="n4-repasse-row">
            <div className="n4-repasse-main">
              <div className="n4-repasse-name">{it.description}</div>
              <div className="n4-repasse-ctx">Caju → {it.toAccountName ?? "Itaú"}{it.sourceLabel ? ` · ${it.sourceLabel}` : ""}</div>
            </div>
            <div className="n4-repasse-val n4-tab n4-nowrap">{fmt(it.amount)}</div>
            {confirming === it.id ? (
              <div className="n4-repasse-confirm" role="group" aria-label={`Confirmar repasse de ${fmt(it.amount)}`}>
                <button type="button" className="n4-ink-btn" onClick={() => settle(it)} disabled={busy}>{busy ? "Registrando…" : `Confirmar ${fmt(it.amount)}`}</button>
                <button type="button" className="n4-undo-link" onClick={() => setConfirming(null)} disabled={busy}>Cancelar</button>
              </div>
            ) : (
              <button type="button" className="n4-ghost-btn" onClick={() => { setError(null); setNote(null); setConfirming(it.id); }}>Marcar repasse como feito</button>
            )}
          </li>
        ))}
      </ul>
      {error && <div role="alert" className="n4-repasses-error">{error}</div>}
      {note && <div role="status" className="n4-repasses-note">{note}</div>}
    </section>
  );
}
