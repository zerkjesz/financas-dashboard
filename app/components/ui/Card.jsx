// Fase 6.0 (Design Freeze) — Card/Surface primitive. O módulo branco
// arredondado (28px) é o elemento mais repetido do ZIP inteiro — este é o
// componente que qualquer superfície nova deve usar em vez de `<div>` solto.
//
// Variants:
//   default  — branco, o card "comum" (o padrão da referência)
//   dark     — hero escuro (bg ink, texto branco, sombra funda) — usado pro
//              módulo de maior destaque de cada tela (ex: "Dá para gastar
//              hoje" na Home, painel do cartão físico)
//   accent   — lime sólido (ex: "Sexta o aperto passa") — reservado pra no
//              máximo 1 card de destaque por tela; NUNCA o padrão
//   interactive — como default, com hover/focus pra elementos clicáveis
export default function Card({ variant = "default", interactive = false, className = "", children, ...props }) {
  const base = "rounded-card p-6 sm:p-7";
  const surface =
    variant === "dark"
      ? "bg-ink text-white shadow-hero"
      : variant === "accent"
        ? "bg-accent text-accent-foreground"
        : "bg-surface shadow-card";
  const interactiveClasses = interactive ? "focus-ring cursor-pointer transition-colors hover:bg-surface-2" : "";

  return (
    <div className={`${base} ${surface} ${interactiveClasses} ${className}`} tabIndex={interactive ? 0 : undefined} {...props}>
      {children}
    </div>
  );
}
