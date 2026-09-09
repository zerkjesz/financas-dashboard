"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

// Fase 5.4C, itens 12/36 — disclosure inline mínimo (nunca drawer/modal),
// acessível via button real + aria-expanded + teclado. Usado tanto pelo
// breakdown do hero (mobile: motivo dominante + "ver mais") quanto pelo
// contexto físico compacto (Dinheiro na conta/Cartão/VA em telas estreitas).
//
// Fase 5.4E.1.1, item 5/16/20 — MEDIDO ao vivo: py-1.5 + text-sm dava
// 32px de hit target real, abaixo de 44px. `pointer-coarse:min-h-11` só
// em touch (confirmado via matchMedia) — o texto continua com o mesmo
// padding visual em desktop, só ganha espaço invisível acima/abaixo em
// touch (já é flex items-center, então centraliza sozinho).
export default function Disclosure({ summary, defaultOpen = false, children, className = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between gap-2 rounded-control py-1.5 text-left text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer pointer-coarse:min-h-11"
      >
        <span>{summary}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}
