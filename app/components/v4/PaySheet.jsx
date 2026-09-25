"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "./Icons.jsx";
import { fmt, parseBR } from "./format.js";

// Fase 9.1 — "Marcar como paga" (modal no desktop, bottom sheet no mobile). Visual = protótipo v4.
// O sheet NÃO decide nada financeiro: coleta origem/data/valor, chama onConfirm (que fala com a API)
// e só comemora quando o backend confirma. Erro do backend aparece aqui, sem animação nenhuma.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PaySheet({ item, accounts, onClose, onConfirm, onPrime, onCelebrate }) {
  const eligible = useMemo(() => (accounts || []).filter((a) => a.type !== "food_voucher"), [accounts]);
  const ownValue = item.needsValue || item.approx;
  const [valueText, setValueText] = useState(item.approx && item.value ? String(item.value).replace(".", ",") : "");
  const value = ownValue ? parseBR(valueText) : item.value || 0;
  const [src, setSrc] = useState(null);
  const [when, setWhen] = useState("hoje");
  const [date, setDate] = useState(todayISO());
  const [noExpense, setNoExpense] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const btnRef = useRef(null);
  const dialogRef = useRef(null);

  // origem padrão: a da conta (Itaú) se cobrir o valor; senão a primeira que cobrir.
  useEffect(() => {
    const pick = eligible.find((a) => a.id === item.defaultAccountId && a.balance >= value) || eligible.find((a) => a.balance >= value) || eligible.find((a) => a.id === item.defaultAccountId) || eligible[0];
    setSrc((prev) => (prev && eligible.find((a) => a.id === prev && a.balance >= value) ? prev : pick?.id ?? null));
  }, [eligible, value, item.defaultAccountId]);

  useEffect(() => {
    dialogRef.current?.querySelector("button, input")?.focus();
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const srcAccount = eligible.find((a) => a.id === src);
  const dateOk = when !== "outra" || (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= todayISO());
  const canConfirm = !busy && !done && value > 0 && dateOk && (noExpense || (srcAccount && srcAccount.balance >= value));

  async function confirm() {
    if (!canConfirm) return;
    onPrime?.(); // gesto do usuário: prepara o áudio antes de qualquer await
    const rect = btnRef.current?.getBoundingClientRect();
    setBusy(true);
    setError(null);
    const res = await onConfirm({ accountId: noExpense ? undefined : src, when: when === "outra" ? date : when, amount: ownValue ? value : undefined, recordExpense: !noExpense });
    if (!res?.ok) {
      setBusy(false);
      setError(res?.error || "Não consegui registrar o pagamento. Nada foi gravado.");
      return;
    }
    setDone(true); // só agora: o backend confirmou
    onCelebrate?.(rect);
    setTimeout(() => onClose(res), 650);
  }

  const title = item.title;
  return (
    <div className="n4-layer">
      <div className="n4-scrim" onClick={() => !busy && onClose()} />
      <div className="n4-sheet" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}>
        <div className="n4-sheet-in">
          <div className="n4-sheet-handle" />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div className="n4-mono" style={{ color: "#565c63", letterSpacing: "0.14em" }}>{title}</div>
            <button type="button" onClick={() => !busy && onClose()} aria-label="Fechar" style={{ width: 44, height: 44, border: 0, borderRadius: 12, background: "#f2f3f5", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Ico name="close" size={14} stroke="#0b0b0c" width={1.9} />
            </button>
          </div>

          <div className="n4-sheet-box">
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>{item.name}</div>
            <div style={{ fontSize: 13, color: "#565c63", marginTop: 3 }}>{item.detail}</div>
            {item.to && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#565c63", marginTop: 2 }}>
                <Ico name="person" size={13} />
                <span>Pagamento para {item.to}</span>
              </div>
            )}
            {!ownValue && <div className="n4-tab" style={{ fontSize: 30, letterSpacing: "-0.035em", marginTop: 12 }}>{fmt(item.value)}</div>}
            {ownValue && (
              <div style={{ marginTop: 14 }}>
                <label htmlFor="n4-value" style={{ fontSize: 12.5, color: "#565c63" }}>{item.needsValue ? "Valor desta conta" : "Valor pago (ajuste se precisar)"}</label>
                <div className="n4-input-line">
                  <span style={{ fontSize: 18, color: "#6e747b" }}>R$</span>
                  <input id="n4-value" inputMode="decimal" aria-label={`Valor de ${item.name}`} value={valueText} onChange={(e) => setValueText(e.target.value)} placeholder="0,00" />
                </div>
                {item.hint && <div style={{ fontSize: 12, color: "#6e747b", marginTop: 7 }}>{item.hint}</div>}
              </div>
            )}
          </div>

          {!noExpense && (
            <>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginTop: 20 }}>De onde saiu o dinheiro?</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }} role="radiogroup" aria-label="Origem do dinheiro">
                {eligible.map((a) => {
                  const insuf = value > 0 && a.balance < value;
                  const on = src === a.id && !insuf;
                  return (
                    <button type="button" key={a.id} role="radio" aria-checked={on} disabled={insuf} className={`n4-opt ${on ? "is-on" : ""} ${insuf ? "is-off" : ""}`} onClick={() => setSrc(a.id)}>
                      <span className="dot">{on && <Ico name="check" size={11} stroke="#0b0b0c" width={3} />}</span>
                      <span style={{ fontSize: 14, flex: 1 }}>{a.name}</span>
                      <span className="n4-tab" style={{ fontSize: 12.5, color: on ? "rgba(255,255,255,0.68)" : "#565c63" }}>{insuf ? "Saldo insuficiente" : a.type === "cash" ? `${fmt(a.balance)} em mãos` : `${fmt(a.balance)} na conta`}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div style={{ fontSize: 13.5, fontWeight: 500, marginTop: 18 }}>Quando?</div>
          <div className="n4-when" role="group" aria-label="Quando foi pago">
            {[["hoje", "Hoje"], ["ontem", "Ontem"], ["outra", "Outra data"]].map(([k, label]) => (
              <button type="button" key={k} aria-pressed={when === k} onClick={() => setWhen(k)}>{label}</button>
            ))}
          </div>
          {when === "outra" && (
            <div style={{ marginTop: 8 }}>
              <input type="date" aria-label="Data do pagamento" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", border: 0, borderRadius: 12, background: "#f2f3f5", padding: "12px 14px", fontSize: 14, fontFamily: "inherit", minHeight: 44 }} />
              {!dateOk && <div style={{ fontSize: 12, color: "#8a5a12", marginTop: 6 }}>A data não pode ser no futuro.</div>}
            </div>
          )}

          <button type="button" onClick={() => setNoExpense((v) => !v)} className="n4-undo-link" style={{ marginTop: 12 }} aria-pressed={noExpense}>
            {noExpense ? "Voltar a lançar a despesa" : "Já paguei antes, fora do Norte — só marcar"}
          </button>
          {noExpense && <div style={{ fontSize: 12, color: "#6e747b", marginTop: 2 }}>Não lança despesa nem mexe no saldo: use quando o pagamento já está refletido no seu saldo.</div>}

          {error && <div className="n4-error" role="alert">{error}</div>}

          <div style={{ marginTop: 22 }}>
            {done ? (
              <div className="n4-confirm is-done" role="status">
                <Ico name="check" size={18} stroke="#0b0b0c" width={2.6} className="n4-pop" />
                <span>Pago</span>
              </div>
            ) : (
              <button type="button" ref={btnRef} className="n4-confirm" disabled={!canConfirm} onClick={confirm}>
                {busy ? (
                  <span>Registrando…</span>
                ) : value > 0 ? (
                  <>
                    <span>{noExpense ? "Só marcar como paga" : item.confirmLabel || "Confirmar pagamento"}</span>
                    <span className="n4-tab" style={{ color: "#c9ff29" }}>{fmt(value)}</span>
                  </>
                ) : (
                  <span>Informe o valor para confirmar</span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
