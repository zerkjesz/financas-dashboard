"use client";

import { Sparkles } from "lucide-react";

// Fase 5.4E, item 8 — antes de simular, o lado de resultado precisa de uma
// composição intencional, nunca um vazio. Copy direta, não-marketing, sem
// ilustração genérica — só o convite claro pra ação.
export default function EmptyResultState() {
  return (
    <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-card border border-dashed border-border-subtle bg-surface-1/60 p-8 text-center">
      <Sparkles className="h-5 w-5 text-text-muted mb-3" aria-hidden="true" />
      <p className="text-card-title text-text-secondary mb-1">E se…?</p>
      {/* Fase 5.4E, matriz de viewport — "à esquerda" era impreciso no
          mobile, onde o form empilha ACIMA (grid vira 1 coluna abaixo de
          lg), não ao lado. Copy sem referência posicional funciona igual
          nas duas composições. */}
      <p className="text-body text-text-muted max-w-xs">Monte um cenário para comparar seu estado atual com o resultado hipotético.</p>
    </div>
  );
}
