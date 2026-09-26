import { Ico5 } from "./Icons5.jsx";

// Fase 10 — cartões físicos do protótipo v5. NENHUM dado fictício: sem número, titular ou validade inventados
// (o Norte não os conhece) — número mascarado e, no rodapé, só o que é real (fechamento/vencimento; VA).
export function PhysicalItauCard({ closingDay, dueDay, className = "" }) {
  return (
    <div className={`n5-plastic itau ${className}`} role="img" aria-label="Cartão Itaú, crédito">
      <div style={{ position: "absolute", top: -60, right: -40, width: 240, height: 240, borderRadius: "50%", background: "radial-gradient(closest-side, rgba(255,255,255,0.22), rgba(255,255,255,0))" }} />
      <div style={{ position: "absolute", bottom: -120, left: -40, width: 260, height: 260, borderRadius: "50%", background: "rgba(11,11,12,0.09)" }} />
      <div className="brand"><b>Itaú</b><span style={{ color: "rgba(255,255,255,0.85)" }}>CRÉDITO</span></div>
      <div className="chiprow">
        <div className="chip" style={{ background: "linear-gradient(140deg,#F6DFA8,#D6B26A 55%,#B8934C)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.35)" }} />
        <Ico5 name="wifi" className="wifi" style={{ stroke: "rgba(255,255,255,0.85)" }} />
      </div>
      <div style={{ position: "relative" }}>
        <div className="num" style={{ textShadow: "0 1px 2px rgba(11,11,12,0.22)" }}>•••• •••• •••• ••••</div>
        <div className="foot"><span>{closingDay ? `FECHA DIA ${String(closingDay).padStart(2, "0")}` : "FATURA"}</span><span>{dueDay ? `VENCE ${String(dueDay).padStart(2, "0")}` : ""}</span></div>
      </div>
    </div>
  );
}

export function PhysicalCajuCard({ className = "" }) {
  return (
    <div className={`n5-plastic caju ${className}`} role="img" aria-label="Cartão Caju, vale-alimentação">
      <div style={{ position: "absolute", right: -70, bottom: -90, width: 250, height: 250, borderRadius: "50%", background: "#9E2B51" }} />
      <div style={{ position: "absolute", right: 40, bottom: 58, width: 64, height: 64, borderRadius: "50%", background: "#F1E3D4", opacity: 0.18 }} />
      <div className="brand"><b style={{ color: "#9E2B51" }}>Caju</b><span style={{ color: "#7A2240" }}>ALIMENTAÇÃO</span></div>
      <div className="chiprow">
        <div className="chip" style={{ background: "linear-gradient(140deg,#EDEFF2,#C8CDD3 55%,#A9AFB6)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.6)" }} />
        <Ico5 name="wifi" className="wifi" style={{ stroke: "#9E2B51" }} />
      </div>
      <div style={{ position: "relative" }}>
        <div className="num">•••• •••• •••• ••••</div>
        <div className="foot"><span>VALE-ALIMENTAÇÃO</span><span style={{ color: "#fff" }}>VA</span></div>
      </div>
    </div>
  );
}
