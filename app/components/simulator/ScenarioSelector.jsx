"use client";

import { useRef } from "react";
import { SCENARIO_CONFIG } from "@/lib/simulatorPresentation";

// Fase 6.0 (Design Freeze) — restyle puro sobre a mesma interação de tabs já
// existente (nenhuma lógica de seleção/teclado mudou, só a pele visual).
//
// O mock aprovado descreve "Como pagar" como um segmented control 2-way
// (dinheiro vs cartão). O real aqui são 4 cenários (dinheiro/cartão à
// vista/cartão parcelado/risco virar realidade) — colapsar pra 2 opções
// perderia o cenário CONTINGENCY_REALIZATION, que é funcionalidade real e
// não tem equivalente na dicotomia "como pagar". Decisão: aplicar a MESMA
// linguagem visual de segmented control (track bg-chip-bg, segmento ativo
// escuro) aos 4 itens reais, em vez de inventar uma redução de escopo — ver
// relatório final.
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
    <div role="tablist" aria-label="Tipo de cenário" className="flex flex-wrap gap-1 rounded-control bg-chip-bg p-1">
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
              active ? "bg-ink text-white" : "text-text-secondary hover:bg-surface-3"
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
