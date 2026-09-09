// Fase 5.4B, itens 15/16 — Card/Surface primitive mínimo. Hierarquia por
// LUMINOSIDADE tonal (5.4A seção 25/Rentier), nunca por sombra/borda pesada
// em cards estáticos (item 14) — shadow fica reservado pra camadas
// flutuantes de verdade (dropdown/popover/modal), não usado aqui.
//
// Variants:
//   default     — surface-1, o card "comum" (substitui bg-surface solto)
//   elevated    — surface-2, um degrau mais claro (destaque sem borda pesada)
//   interactive — como default, mas com hover/focus pra elementos clicáveis
//
// Não migra nenhum card existente nesta fase (item 33) — disponível pra uso
// em qualquer superfície nova a partir de 5.4C.
export default function Card({ variant = "default", interactive = false, className = "", children, ...props }) {
  const base = "rounded-card border border-border-subtle p-4";
  const surface = variant === "elevated" ? "bg-surface-2" : "bg-surface-1";
  const interactiveClasses = interactive
    ? "focus-ring cursor-pointer transition-colors hover:bg-surface-2"
    : "";

  return (
    <div className={`${base} ${surface} ${interactiveClasses} ${className}`} tabIndex={interactive ? 0 : undefined} {...props}>
      {children}
    </div>
  );
}
