"use client";

import { useEffect, useState } from "react";
import AnimatedGradient from "../spell/AnimatedGradient.jsx";

// Fase 5.4E.1 — assinatura visual do CENÁRIO SIMULADO (item 4/24 da fase):
// uma atmosfera extremamente sutil por trás do ResultPanel, reforçando
// FACT vs HYPOTHESIS de um jeito que a Home/detail pages nunca têm — sem
// virar decoração. Este wrapper é o único lugar do produto que sabe que o
// Spell UI existe; ResultPanel só importa <HypotheticalAmbientSurface />,
// nunca AnimatedGradient direto (item 47/48 — encapsular vendor behavior).
//
// Cores mapeadas aos tokens Norte já existentes (item 49 — nunca hex novo
// solto): color1/color2 são --color-surface-2/--color-surface-1 (o próprio
// fundo do painel — o gradiente nasce da superfície, não a substitui por
// algo estranho); color3 é --color-hypothetical, o MESMO azul do hairline
// e do label "CENÁRIO SIMULADO" já usados no ResultPanel — reforça o mesmo
// sinal em vez de introduzir uma cor nova sem significado (--color-restricted
// já significa outra coisa: capacidade de crédito, não hipótese).
const GRADIENT_CONFIG = {
  preset: "custom",
  color1: "#1e293b", // --color-surface-2
  color2: "#0f172a", // --color-surface-1
  color3: "#38bdf8", // --color-hypothetical
  rotation: 25,
  proportion: 32,
  scale: 0.85,
  speed: 6, // item 7 — "muito lento": preset custom do doc usa 15; aqui quase metade
  distortion: 4,
  swirl: 22,
  swirlIterations: 6,
  softness: 100, // máximo — sem borda de forma perceptível, só wash
  offset: 0,
  shape: "Edge",
  shapeSize: 55,
};

function supportsWebGL2() {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

// Item 11 — progressive enhancement: se WebGL indisponível ou
// prefers-reduced-motion, retorna null. O ResultPanel já tem `bg-surface-2`
// como fundo real (não decorativo) — sem este componente, o painel continua
// 100% legível e funcional; NUNCA existe um estado "faltando fundo".
export default function HypotheticalAmbientSurface() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const evaluate = () => setEnabled(!mq.matches && supportsWebGL2());
    evaluate();
    mq.addEventListener("change", evaluate);
    return () => mq.removeEventListener("change", evaluate);
  }, []);

  if (!enabled) return null;

  // opacity-30 (item 8) — o teto de intensidade final, independente do
  // softness/swirl do shader: garante que mesmo o pico mais claro do
  // gradiente nunca compete com o contraste do texto por cima (z-10
  // implícito, já que o componente se posiciona a z-index:-1 dentro deste
  // container relative).
  return <AnimatedGradient config={GRADIENT_CONFIG} className="opacity-30" />;
}
