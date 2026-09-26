"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fmt, fmtS } from "../v4/format.js";
import { Ico5 } from "./Icons5.jsx";
import Slider from "./Slider.jsx";
import { ratioOf, localAssessment, purchaseVerdict, capacityCells, optionLabel } from "./cartoesView.js";
import { installmentValueOf } from "../../../lib/cardsItauPure.js";

// Fase 10 — "Se eu comprar algo hoje": DUAS perguntas separadas (passa no cartão? cabe na sua vida?).
//  * LIMITE: função pura de lib/cardsItauPure.js (o Norte não tem limite disponível autoritativo → estados honestos).
//  * ORÇAMENTO: 100% do motor financeiro (o MESMO simulador do /simulador). Os tetos por parcelamento vêm de uma
//    busca determinística no backend; o veredito do slider é instantâneo contra esses tetos, e o detalhe
//    (pior mês, impacto no seguro) vem de uma simulação real POST /api/cartoes/capacidade (zero escrita).
const OCHRE = "#E0A94A";

export default function PurchaseSimulator({ itau }) {
  const sim = itau.purchaseSimulator;
  const limit = useMemo(() => ({ low: itau.limit.estimate.low, high: itau.limit.estimate.high, ceiling: itau.limit.ceilingAvailable }), [itau]);
  const [amount, setAmount] = useState(() => Math.min(sim.maxAmount, Math.max(sim.minAmount, 500)));
  const [n, setN] = useState(3);
  const [caps, setCaps] = useState(null);
  const [capsError, setCapsError] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const seq = useRef(0);

  async function loadCaps() {
    setCapsError(false);
    try {
      const res = await fetch("/api/cartoes/capacidade", { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      setCaps((await res.json()).budgetCaps);
    } catch { setCapsError(true); }
  }
  useEffect(() => { loadCaps(); }, []);

  // detalhe real (simulação do motor) com debounce — o veredito local não espera por ele
  useEffect(() => {
    const id = ++seq.current;
    setDetailLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/cartoes/capacidade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount, installments: n }) });
        if (!res.ok) throw new Error("http " + res.status);
        const j = await res.json();
        if (id === seq.current) { setDetail({ ...j, key: `${amount}:${n}` }); setDetailLoading(false); }
      } catch { if (id === seq.current) { setDetail(null); setDetailLoading(false); } }
    }, 350);
    return () => clearTimeout(t);
  }, [amount, n]);

  const local = localAssessment({ amount, n, limit, caps });
  const fresh = detail && detail.key === `${amount}:${n}` ? detail : null;
  const cardStatus = fresh?.cardCapacity.status ?? local.capacity.status;
  const budgetOk = fresh ? fresh.budgetCapacity.status === "SAFE" : local.budgetOk;
  const budgetCap = caps?.[n] ?? null;
  const pending = budgetOk == null;
  const v = pending
    ? { verdict: capsError ? "Não consegui calcular o orçamento agora." : "Calculando a capacidade no orçamento…", reason: capsError ? "O limite foi avaliado, mas o motor financeiro não respondeu." : "Usando o mesmo motor do simulador do Norte.", tone: "#FFFFFF", dot: OCHRE }
    : purchaseVerdict({ cardStatus, budgetOk, amount, n, capacity: local.capacity, budgetCap: budgetCap ?? 0 });
  const monthly = installmentValueOf(amount, n);
  const cells = capacityCells({ options: sim.options, caps, limit });

  const scale = Math.max(limit.high, limit.ceiling, budgetCap ?? 0, amount) * 1.08;
  const pc = (x) => `${Math.min(100, (x / scale) * 100).toFixed(2)}%`;
  const cardOk = cardStatus === "FITS_LIKELY";
  const cardNote = { FITS_LIKELY: "Dentro do limite estimado. A compra inteira ocupa o limite, mesmo parcelada.", UNCERTAIN: "Entre o limite estimado e o que ainda pode estar livre. O banco não foi reconciliado.", UNLIKELY: "Acima do provável limite livre, mas abaixo do teto. Confirme no app do banco.", EXCEEDS: "Acima do máximo que pode estar livre: o comprometido conhecido já ocupa o resto." }[cardStatus];
  const meters = [
    { label: "Cabe no limite", ok: cardOk, capTxt: limit.high > limit.low ? `estimado até ${fmtS(limit.low)} · pode chegar a ${fmtS(limit.high)}` : `estimado até ${fmtS(limit.low)}`, cap: limit.low, note: cardNote },
    { label: "Cabe no orçamento", ok: budgetOk === true, capTxt: budgetCap != null ? `até ${fmtS(budgetCap)}` : "calculando…", cap: budgetCap ?? 0, note: `Capacidade segura em ${optionLabel(n).toLowerCase()}, pelo motor financeiro do Norte (mesma conta do simulador).` },
  ];
  const detailLine = fresh
    ? `Reduz o seguro para gastar em ${fmt(fresh.budgetCapacity.safeImpact)} · pior momento do caixa: ${fmt(fresh.budgetCapacity.worstMonth.cash)}${fresh.budgetCapacity.worstMonth.label ? ` em ${fresh.budgetCapacity.worstMonth.label}` : ""}.`
    : detailLoading ? "Calculando o impacto no caixa…" : null;

  const amountSlider = (dark) => (
    <Slider value={amount} min={sim.minAmount} max={sim.maxAmount} step={sim.step} onChange={setAmount} label="Valor da compra" valueText={fmt(amount)} className="n5-slider" render={() => (
      <>
        <div className="n5-track" style={dark ? { background: "rgba(255,255,255,0.14)" } : undefined}>
          <div className="fill" style={{ width: `${ratioOf(amount, sim.minAmount, sim.maxAmount) * 100}%`, background: dark ? "#fff" : undefined }} />
          {!dark && <div className="mark" style={{ left: `${ratioOf(limit.low, sim.minAmount, sim.maxAmount) * 100}%` }} />}
          <div className="n5-thumb" style={{ left: `${ratioOf(amount, sim.minAmount, sim.maxAmount) * 100}%`, ...(dark ? { width: 26, height: 26, marginLeft: -13, marginTop: -13, background: "#C9FF29", boxShadow: "0 0 0 3px #0B0B0C" } : {}) }} />
        </div>
        {!dark && <div className="n5-scale"><span>{fmtS(sim.minAmount)}</span><span>| limite estimado</span><span>{fmtS(sim.maxAmount)}</span></div>}
      </>
    )} />
  );
  const optionsGroup = (dark) => (
    <div className="n5-opts" role="radiogroup" aria-label="Em quantas vezes" style={dark ? { gap: 5, marginTop: 8 } : undefined}>
      {sim.options.map((k) => (
        <button key={k} type="button" role="radio" aria-checked={n === k} className="n5-opt" onClick={() => setN(k)} style={dark && n !== k ? { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.8)" } : undefined}>{optionLabel(k)}</button>
      ))}
    </div>
  );

  return (
    <>
      {/* ===== desktop ===== */}
      <div className="n5-grid2 start n5-rise d4 n5-hide-compact" style={{ alignItems: "start" }}>
        <div className="n5-panel">
          <div className="n5-h">Se eu comprar algo hoje</div>
          <div className="n5-sub" style={{ marginTop: 4 }}>Duas perguntas diferentes: passa no cartão? E cabe na sua vida?</div>
          <div className="n5-mono" style={{ marginTop: 22 }}>Valor da compra</div>
          <div className="n5-amount"><span>R$</span><div aria-live="polite">{amount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div></div>
          {amountSlider(false)}
          <div className="n5-mono" style={{ marginTop: 18 }}>Em quantas vezes</div>
          {optionsGroup(false)}
          <div className="n5-sub" style={{ marginTop: 12 }}>Impacto mensal: <span className="n5-tab" style={{ color: "#0b0b0c" }}>{fmt(monthly)}</span> por {n === 1 ? "1 mês" : `${n} meses`}</div>
        </div>
        <div className={`n5-dark n5-answer ${detailLoading ? "" : ""}`} aria-live="polite">
          <div className="who"><i style={{ background: v.dot }} /><span>Resposta</span></div>
          <div className="verdict" style={{ color: v.tone }}>{v.verdict}</div>
          <div className="reason">{v.reason}</div>
          {meters.map((m) => (
            <div className="n5-meter" key={m.label}>
              <div className="row">
                <span className="lab"><span className="ic" style={{ background: m.ok ? "#C9FF29" : "rgba(255,255,255,0.14)" }}><Ico5 name={m.ok ? "check" : "x"} style={{ stroke: m.ok ? "#0B0B0C" : "#fff" }} /></span><span>{m.label}</span></span>
                <span className="cap">{m.capTxt}</span>
              </div>
              <div className="bar"><i style={{ width: pc(m.cap), background: "rgba(255,255,255,0.22)" }} /><i style={{ width: pc(amount), background: m.ok ? "#C9FF29" : OCHRE, transition: "width .3s" }} /></div>
              <div className="n">{m.note}</div>
            </div>
          ))}
          {detailLine && <div className="n5-meter"><div className="n" style={{ color: "rgba(255,255,255,0.78)" }}>{detailLine}</div></div>}
          <div className="n5-captable">
            <div className="n5-mono" style={{ color: "rgba(255,255,255,0.62)", fontSize: 10 }}>Capacidade segura por parcelamento</div>
            {capsError ? (
              <div className="n" style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", marginTop: 8 }}>Não consegui calcular. <button type="button" className="n5-link" style={{ background: "none", border: 0, cursor: "pointer", font: "inherit" }} onClick={loadCaps}>Tentar de novo</button></div>
            ) : (
              <div className="cells" role="radiogroup" aria-label="Capacidade segura por parcelamento">
                {cells.map((c) => (
                  <button key={c.n} type="button" role="radio" aria-checked={n === c.n} className="n5-cell" onClick={() => setN(c.n)}>
                    <div className="n">{c.label}</div>
                    <div className="c">{c.cap == null ? "…" : fmtS(Math.floor(c.cap))}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link href="/simulador" className="n5-link">Abrir no simulador completo</Link>
        </div>
      </div>

      {/* ===== compacto (mobile v5) ===== */}
      <div className="n5-dark n5-only-compact n5-rise d4 n5-body" aria-live="polite">
        <div className="n5-h" style={{ color: "#fff" }}>Simular compra</div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 12 }}>
          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>Valor</span>
          <span className="n5-tab" style={{ fontSize: 26, letterSpacing: "-0.03em" }}>R$ {amount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
        </div>
        {amountSlider(true)}
        {optionsGroup(true)}
        <div style={{ fontSize: 19, fontWeight: 500, letterSpacing: "-0.025em", marginTop: 16, color: v.tone, textWrap: "balance" }}>{v.verdict}</div>
        {meters.map((m) => (
          <div key={m.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: 8 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span className="n5-meter"><span className="ic" style={{ background: m.ok ? "#C9FF29" : "rgba(255,255,255,0.14)", margin: 0 }}><Ico5 name={m.ok ? "check" : "x"} style={{ stroke: m.ok ? "#0B0B0C" : "#fff" }} /></span></span>
              <span>{m.label}</span>
            </span>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.66)", textAlign: "right" }} className="n5-tab">{m.capTxt}</span>
          </div>
        ))}
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.62)", marginTop: 6 }}>{fmt(monthly)}{n > 1 ? " por mês" : ""} por {n === 1 ? "1 mês" : `${n} meses`}</div>
        {detailLine && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 6 }}>{detailLine}</div>}
        <Link href="/simulador" className="n5-link">Abrir no simulador completo</Link>
      </div>
    </>
  );
}
