// Fase 6.0 (Design Freeze) — Badge semântico. Estado nunca depende só de
// cor — quem usa este primitive passa o texto via children.
//
// A referência nunca usa vermelho: aperto/risco usa a família ocre
// (--color-warning/--color-danger, mesmo valor — ver docs/design-tokens.md).
// "risk"/CONTINGÊNCIA se distingue de "warning" normal pela borda tracejada,
// nunca só pela cor (mesmo princípio de antes).
const VARIANTS = {
  neutral: "bg-surface-3 text-text-secondary border border-border-strong",
  positive: "bg-positive/10 text-positive border border-positive/25",
  warning: "bg-warning-bg text-warning-text border border-warning/25",
  danger: "bg-danger-bg text-danger-text border border-danger/25",
  restricted: "bg-surface-3 text-restricted border border-border-strong",
  // RISCO/CONTINGÊNCIA: mesma cor de warning, borda tracejada — nunca a
  // mesma aparência de um compromisso confirmado.
  risk: "bg-warning-bg/60 text-warning-text border border-dashed border-warning/40",
  // Accent: destaque de marca (lime) — uso raro, reservado a estados
  // realmente positivos de produto (ex: "ativo"), nunca genérico.
  accent: "bg-accent/25 text-ink border border-accent",
  // HIPOTÉTICO: qualquer coisa vinda do simulador — nunca a mesma cor de um
  // fato real.
  hypothetical: "bg-surface-3 text-hypothetical border border-border-strong border-dashed",
};

export default function Badge({ variant = "neutral", className = "", children, ...props }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium ${VARIANTS[variant]} ${className}`} {...props}>
      {children}
    </span>
  );
}
