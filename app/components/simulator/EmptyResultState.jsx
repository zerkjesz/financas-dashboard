"use client";

import { Sparkles } from "lucide-react";

// Fase 6.0 (Design Freeze) — mesmo propósito de antes (nunca um vazio antes
// de simular), só a pele: card branco padrão do freeze (rounded-card,
// shadow-card) em vez do tracejado antigo, ícone neutro, zero número
// inventado.
export default function EmptyResultState() {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-card bg-surface shadow-card p-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-chip-bg">
        <Sparkles className="h-5 w-5 text-text-muted" aria-hidden="true" />
      </div>
      <p className="text-card-title text-text-primary mb-1">E se…?</p>
      {/* Copy sem referência posicional — o form empilha ACIMA no mobile
          (flex-col antes de lg:flex-row), nunca "ao lado". */}
      <p className="text-body text-text-muted max-w-xs">Monte um cenário para comparar seu estado atual com o resultado hipotético.</p>
    </div>
  );
}
