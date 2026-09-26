"use client";
import { useRef } from "react";
import { valueFromRatio, ratioOf, sliderKeyValue } from "./cartoesView.js";

// Fase 10 — slider acessível (mouse, toque e TECLADO). role="slider" + aria-*; ← → ↑ ↓ PgUp PgDn Home End ajustam o
// valor e NÃO propagam (as setas do carrossel Itaú ↔ Caju ignoram sliders — ver keyDelta em cartoesView.js).
const HANDLED = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
export default function Slider({ value, min, max, step, onChange, label, valueText, className = "n5-slider", render }) {
  const ref = useRef(null);
  const setFromX = (clientX) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    onChange(valueFromRatio((clientX - r.left) / r.width, min, max, step));
  };
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={className}
      onPointerDown={(e) => {
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
        setFromX(e.clientX);
      }}
      onPointerMove={(e) => { if (e.buttons) setFromX(e.clientX); }}
      onKeyDown={(e) => {
        if (!HANDLED.has(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const next = sliderKeyValue(e.key, value, min, max, step);
        if (next !== value) onChange(next);
      }}
    >
      {render(ratioOf(value, min, max))}
    </div>
  );
}
