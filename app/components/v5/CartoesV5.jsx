"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import "./v5.css";
import CardStage from "./CardStage.jsx";
import ItauBody, { CurrentBillPanel, LimitPanel } from "./ItauBody.jsx";
import CajuBody, { BalanceHero } from "./CajuBody.jsx";
import { CARD_KEYS, STORAGE_KEY, keyDelta, stepIndex, directionOf, resolveInitialCard } from "./cartoesView.js";

// Fase 10 — ÁREA CARTÕES v5 (Itaú + Caju). Dados 100% reais via GET /api/cartoes (somente leitura). A troca de
// cartão não recarrega a página: atualiza o palco (animação) e o conteúdo (transição curta), respeitando
// prefers-reduced-motion. Seleção lembrada em ?card= e localStorage.
const TITLES = { itau: "Itaú · crédito", caju: "Caju · alimentação" };

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const on = (e) => setReduced(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export default function CartoesV5() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(0);
  const [mode, setMode] = useState("eq");
  const [reserve, setReserve] = useState(null);
  const reduced = useReducedMotion();
  const ready = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cartoes", { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      const j = await res.json();
      setData(j);
      setError(null);
    } catch {
      setError("Não consegui carregar os cartões. Tente de novo.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const keys = data?.cards ?? [];

  // seleção inicial (?card= > localStorage > Itaú)
  useEffect(() => {
    if (!data || ready.current) return;
    let stored = null;
    try { stored = window.localStorage.getItem(STORAGE_KEY); } catch {}
    const query = new URLSearchParams(window.location.search).get("card");
    const wanted = resolveInitialCard({ query, stored });
    const key = CARD_KEYS[wanted];
    const i = Math.max(0, data.cards.indexOf(key));
    setIndex(i);
    setReserve(data.caju?.weekend?.slider?.default ?? 0);
    ready.current = true;
  }, [data]);

  // persistência da seleção
  useEffect(() => {
    if (!data || !ready.current || !keys[index]) return;
    try { window.localStorage.setItem(STORAGE_KEY, keys[index]); } catch {}
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("card", keys[index]);
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, [index, data, keys]);

  const go = useCallback((delta) => {
    if (keys.length < 2) return;
    setIndex((i) => {
      const next = stepIndex(i, delta, keys.length);
      setDir(delta > 0 ? 1 : -1);
      return next;
    });
  }, [keys.length]);
  const pick = useCallback((to) => {
    setIndex((i) => { if (to !== i) setDir(directionOf(i, to)); return to; });
  }, []);

  // teclado ← / → (ignora campos e sliders)
  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const d = keyDelta(e.key, e.target);
      if (d !== 0) { e.preventDefault(); go(d); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  if (error && !data) {
    return (
      <div className="n5 n5-error" role="alert">
        <div className="n5-panel" style={{ textAlign: "center" }}>
          <div className="n5-h">{error}</div>
          <button type="button" className="n5-opt" style={{ marginTop: 16, maxWidth: 220 }} onClick={load}>Tentar de novo</button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="n5" aria-busy="true">
        <div className="n5-head"><div><div className="n5-eyebrow">Cartões</div><div className="n5-title">Carregando…</div></div></div>
        <div className="n5-skel" style={{ height: 360, borderRadius: 30 }} />
        <div className="n5-skel" />
      </div>
    );
  }
  if (keys.length === 0) {
    return (
      <div className="n5">
        <div className="n5-head"><div><div className="n5-eyebrow">Cartões</div><div className="n5-title">Nenhum cartão cadastrado</div></div></div>
        <div className="n5-panel"><div className="n5-empty">Cadastre o Itaú ou o Caju para ver a área de cartões.</div></div>
      </div>
    );
  }

  const key = keys[index] ?? keys[0];
  const { itau, caju } = data;
  return (
    <div className="n5">
      <div className="n5-head">
        <div>
          <div className="n5-eyebrow">Cartões · {index + 1} de {keys.length}</div>
          <h1 className="n5-title" style={{ margin: "8px 0 0" }}>{TITLES[key]}</h1>
        </div>
        {keys.length > 1 && <div className="n5-hint">Use ← → para trocar de cartão</div>}
      </div>
      <div className="n5-vh" aria-live="polite" role="status">{TITLES[key]}, cartão {index + 1} de {keys.length}</div>

      <div className="n5-top">
        <CardStage keys={keys} index={index} dir={dir} reduced={reduced} onGo={go} onPick={pick} itau={itau} caju={caju} />
        {key === "itau" && itau && (
          <div className="n5-col" key="itau-top">
            <CurrentBillPanel bill={itau.currentBill} />
            <LimitPanel limit={itau.limit} bill={itau.currentBill} />
          </div>
        )}
        {key === "caju" && caju && (
          <div key="caju-top" className="n5-col">
            <BalanceHero caju={caju} mode={mode} onMode={setMode} weekendReserve={reserve ?? 0} />
          </div>
        )}
      </div>

      {key === "itau" && itau && <div key="itau-body"><ItauBody itau={itau} onSettingsSaved={load} /></div>}
      {key === "caju" && caju && <div key="caju-body"><CajuBody caju={caju} reserve={reserve ?? 0} onReserve={setReserve} /></div>}
    </div>
  );
}
