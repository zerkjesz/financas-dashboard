"use client";
import { useRef } from "react";
import { Ico5 } from "./Icons5.jsx";
import { PhysicalItauCard, PhysicalCajuCard } from "./PhysicalCards.jsx";
import { swipeDelta, cardAnimClass, itauFacts, cajuFacts } from "./cartoesView.js";

// Fase 10 — palco escuro com o cartão físico protagonista, setas, indicador e fatos (protótipo v5). Troca por
// setas, pontos/abas, teclado (← →, tratado em CartoesV5) e SWIPE (pointer events; helper puro swipeDelta).
const LABELS = { itau: "Itaú", caju: "Caju" };
const GLOW = { itau: "rgba(242,104,26,0.28)", caju: "rgba(158,43,81,0.3)" };

export default function CardStage({ keys, index, dir, reduced, onGo, onPick, itau, caju }) {
  const start = useRef(null);
  const key = keys[index];
  const anim = cardAnimClass(dir, reduced);
  const facts = key === "itau" ? itauFacts(itau) : cajuFacts(caju);
  const down = (e) => { start.current = { x: e.clientX, y: e.clientY }; };
  const up = (e) => {
    if (!start.current) return;
    const d = swipeDelta(e.clientX - start.current.x, e.clientY - start.current.y);
    start.current = null;
    if (d !== 0) onGo(d);
  };
  const many = keys.length > 1;
  return (
    <section className="n5-stage" aria-label="Seus cartões">
      <div className="n5-glow" style={{ background: `radial-gradient(closest-side, ${GLOW[key]}, rgba(0,0,0,0))` }} />
      <div className="n5-stage-row">
        {many && <button type="button" className="n5-arrow desk" onClick={() => onGo(-1)} aria-label="Cartão anterior"><Ico5 name="left" /></button>}
        <div className="n5-card-wrap" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { start.current = null; }}>
          {key === "itau" ? <PhysicalItauCard key="itau" className={anim} closingDay={itau?.card.closingDay} dueDay={itau?.card.dueDay} /> : <PhysicalCajuCard key="caju" className={anim} />}
        </div>
        {many && <button type="button" className="n5-arrow desk" onClick={() => onGo(1)} aria-label="Próximo cartão"><Ico5 name="right" /></button>}
      </div>

      {many && (
        <div className="n5-pills" role="tablist" aria-label="Cartões">
          {keys.map((k, i) => (
            <button key={k} type="button" role="tab" className="n5-pill" aria-selected={i === index} onClick={() => onPick(i)}>
              <i />
              <span>{LABELS[k]}</span>
            </button>
          ))}
        </div>
      )}

      {many && (
        <div className="n5-compact-controls">
          <button type="button" className="n5-arrow" onClick={() => onGo(-1)} aria-label="Cartão anterior"><Ico5 name="left" /></button>
          <div className="n5-dots" role="tablist" aria-label="Cartões">
            {keys.map((k, i) => (
              <button key={k} type="button" role="tab" aria-selected={i === index} aria-label={LABELS[k]} onClick={() => onPick(i)}><i /></button>
            ))}
            <span className="cardname">{LABELS[key]}</span>
          </div>
          <button type="button" className="n5-arrow" onClick={() => onGo(1)} aria-label="Próximo cartão"><Ico5 name="right" /></button>
        </div>
      )}

      <div className="n5-facts">
        {facts.map((f) => (
          <div className="n5-fact" key={f.k}><div className="k">{f.k}</div><div className="v n5-tab">{f.v}</div></div>
        ))}
      </div>
    </section>
  );
}
