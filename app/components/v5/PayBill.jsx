"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmt } from "../v4/format.js";
import { Ico5 } from "./Icons5.jsx";
import { dmyLabel } from "./cartoesView.js";

// Fase 10.5 — "Marcar fatura como paga" / estado "✓ Fatura paga" / "Desfazer pagamento". Só quitação INTEGRAL.
// Pagar fatura não é despesa: registra o pagamento (conta → cartão) e quita a fatura. O modal é renderizado num portal (o
// container da página usa container-query e prenderia um `position: fixed` dentro dele).
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, j };
}

function Dialog({ labelId, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector("input, button:not([data-secondary])")?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="n5-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="n5-modal" role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref} onKeyDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );
}

function PayDialog({ payment, onClose, onDone }) {
  const [date, setDate] = useState(payment.defaultDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { ok, j } = await post("/api/cartoes/fatura/pagar", { cardId: payment.cardId, cycleMonth: payment.cycleMonth, fromAccountId: payment.fromAccount?.id, paidAt: date });
      if (!ok) throw new Error(j.message || "Não consegui registrar o pagamento.");
      onDone(j);
    } catch (e) {
      setError(e.message || "Não consegui registrar o pagamento.");
      setBusy(false);
    }
  }
  return (
    <Dialog labelId="n5-pay-title" onClose={busy ? () => {} : onClose}>
      <div className="n5-modal-k">Pagamento da fatura</div>
      <h2 id="n5-pay-title" className="n5-modal-title">Confirmar pagamento</h2>
      <dl className="n5-modal-rows">
        <div><dt>Fatura</dt><dd className="n5-tab">{fmt(payment.amount)}</dd></div>
        <div><dt>Vence em</dt><dd className="n5-tab">{dmyLabel(payment.dueAt)}</dd></div>
        <div>
          <dt><label htmlFor="n5-pay-date">Pago em</label></dt>
          <dd><input id="n5-pay-date" type="date" className="n5-modal-input" value={date} max={payment.defaultDate} onChange={(e) => setDate(e.target.value)} required /></dd>
        </div>
        <div><dt>Saiu de</dt><dd>{payment.fromAccount?.name ?? "—"}</dd></div>
      </dl>
      <p className="n5-modal-note">O valor sai do saldo da conta e a fatura fica quitada. Não entra como despesa: as compras já foram contadas.</p>
      {error && <div className="n5-modal-error" role="alert">{error}</div>}
      <div className="n5-modal-actions">
        <button type="button" className="n5-modal-btn ghost" data-secondary onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className="n5-modal-btn" onClick={confirm} disabled={busy || !date}>{busy ? "Registrando…" : "Confirmar pagamento"}</button>
      </div>
    </Dialog>
  );
}

function UndoDialog({ paidBill, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { ok, j } = await post("/api/cartoes/fatura/desfazer", { cardBillId: paidBill.cardBillId });
      if (!ok) throw new Error(j.message || "Não consegui desfazer o pagamento.");
      onDone(j);
    } catch (e) {
      setError(e.message || "Não consegui desfazer o pagamento.");
      setBusy(false);
    }
  }
  return (
    <Dialog labelId="n5-undo-title" onClose={busy ? () => {} : onClose}>
      <div className="n5-modal-k">Correção de erro</div>
      <h2 id="n5-undo-title" className="n5-modal-title">Desfazer pagamento?</h2>
      <p className="n5-modal-note" style={{ marginTop: 0 }}>
        A fatura de {paidBill.monthLong} volta a ficar em aberto e {fmt(paidBill.amount)} volta ao saldo{paidBill.accountName ? ` de ${paidBill.accountName}` : ""}. Suas compras e parcelas não mudam.
      </p>
      {error && <div className="n5-modal-error" role="alert">{error}</div>}
      <div className="n5-modal-actions">
        <button type="button" className="n5-modal-btn ghost" data-secondary onClick={onClose} disabled={busy}>Manter pago</button>
        <button type="button" className="n5-modal-btn danger" onClick={confirm} disabled={busy}>{busy ? "Desfazendo…" : "Desfazer pagamento"}</button>
      </div>
    </Dialog>
  );
}

// Bloco discreto dentro do painel da fatura: CTA (fatura fechada e não paga) ou estado "✓ Fatura paga".
export function BillPaymentAction({ state, onChanged }) {
  const [dialog, setDialog] = useState(null); // "pay" | "undo" | null
  const [flash, setFlash] = useState(null);
  const done = (msg) => { setDialog(null); setFlash(msg); onChanged?.(); };
  if (state.mode === "none") return null;
  return (
    <>
      {state.mode === "cta" && (
        <div className="n5-pay">
          <button type="button" className="n5-pay-btn" onClick={() => setDialog("pay")}>Marcar fatura como paga</button>
          <span className="n5-pay-hint">Vence {dmyLabel(state.payment.dueAt)} · {fmt(state.payment.amount)}</span>
        </div>
      )}
      {state.mode === "paid" && (
        <div className="n5-paid">
          <span className="n5-paid-mark" aria-hidden="true"><Ico5 name="check" /></span>
          <div className="n5-paid-text">
            <div className="t">Fatura de {state.paidBill.monthLong} paga</div>
            <div className="s n5-tab">Pago em {dmyLabel(state.paidBill.paidAt)} · {fmt(state.paidBill.amount)}{state.paidBill.accountName ? ` · ${state.paidBill.accountName}` : ""}</div>
            {state.paidBill.reconciledWithBank && <div className="s">Conferido com o extrato do banco.</div>}
          </div>
          {state.paidBill.undoable && <button type="button" className="n5-paid-undo" onClick={() => setDialog("undo")}>Desfazer pagamento</button>}
        </div>
      )}
      {flash && <div className="n5-note" role="status">{flash}</div>}
      {dialog === "pay" && state.mode === "cta" && (
        <PayDialog payment={state.payment} onClose={() => setDialog(null)} onDone={(j) => done(j.status === "ALREADY_PAID" ? "Esta fatura já estava paga." : j.warnings?.includes("PAYMENT_BEFORE_LAST_BALANCE_CHECK") ? "Pagamento registrado. Como o dia é anterior ao último saldo conferido, o saldo já incluía esse pagamento." : null)} />
      )}
      {dialog === "undo" && state.mode === "paid" && <UndoDialog paidBill={state.paidBill} onClose={() => setDialog(null)} onDone={() => done("Pagamento desfeito. A fatura voltou a ficar em aberto.")} />}
    </>
  );
}
