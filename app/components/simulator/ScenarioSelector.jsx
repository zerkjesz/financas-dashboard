"use client";

import { useRef } from "react";
import { SCENARIO_CONFIG } from "@/lib/simulatorPresentation";

// Fase 5.4E, item 9 — tabs continuam a melhor interação (poucos itens,
// mudança de contexto clara). Accent SÓ no estado selecionado (item 26 do
// pedido geral de accent discipline) — nunca para representar dado
// financeiro.
//
// Fase 5.4E.1.1 — MEDIDO ao vivo: py-2.5 dava 42px real, abaixo dos 44px
// (a estimativa "~40px+" do comentário anterior não tinha medição real por
// trás). `pointer-coarse:min-h-11` só em touch; seleção/estado visual
// (accent, border) e a semântica de teclado por seta ficam intocados.
//
// BUG REAL corrigido (achado em teste de teclado real, não só dispatchEvent):
// `role="tablist"`/`role="tab"` promete o padrão ARIA Tabs pra tecnologia
// assistiva, mas a versão anterior não implementava navegação por seta —
// cada <button> era um Tab-stop individual (Tab passava pelos 4, um a um) e
// ArrowLeft/ArrowRight não faziam nada. Um usuário de leitor de tela que
// conhece o padrão tenta seta e nada acontece — role prometendo
// comportamento que o código não entrega. Corrigido pro padrão real (APG
// Tabs, "automatic activation"): só o tab ativo fica no fluxo de Tab
// (tabIndex 0/-1), Left/Right movem e ativam com wrap-around, Home/End vão
// pro primeiro/último.
export default function ScenarioSelector({ value, onChange }) {
  const refs = useRef([]);

  function focusAndActivate(index) {
    const wrapped = (index + SCENARIO_CONFIG.length) % SCENARIO_CONFIG.length;
    onChange(SCENARIO_CONFIG[wrapped].type);
    refs.current[wrapped]?.focus();
  }

  function handleKeyDown(e, index) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusAndActivate(index + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusAndActivate(index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAndActivate(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAndActivate(SCENARIO_CONFIG.length - 1);
    }
  }

  return (
    <div role="tablist" aria-label="Tipo de cenário" className="flex flex-wrap gap-1.5">
      {SCENARIO_CONFIG.map((s, i) => {
        const Icon = s.icon;
        const active = value === s.type;
        return (
          <button
            key={s.type}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(s.type)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={`focus-ring inline-flex items-center gap-2 rounded-control px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer pointer-coarse:min-h-11 ${
              active ? "bg-surface-2 text-text-primary border border-accent/40" : "text-text-muted border border-transparent hover:bg-surface-1 hover:text-text-primary"
            }`}
          >
            <Icon className={`h-4 w-4 shrink-0 ${active ? "text-accent" : "text-text-muted"}`} aria-hidden="true" />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
