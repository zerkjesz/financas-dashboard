// Fase 5.4B, item 18 — Badge semântico. Cada variant carrega COR + TEXTO
// sempre (5.4A seção 28/42: estado nunca depende só de cor) — quem usa este
// primitive passa o texto via children, o componente nunca inventa label.
const VARIANTS = {
  neutral: "bg-surface-2 text-text-secondary border border-border-strong",
  positive: "bg-positive/15 text-positive border border-positive/30",
  warning: "bg-warning/15 text-warning border border-warning/30",
  danger: "bg-danger/15 text-danger border border-danger/30",
  restricted: "bg-restricted/15 text-restricted border border-restricted/30",
  // Fase 5.4B, item 35 — RISCO/CONTINGÊNCIA: warning + borda tracejada (não
  // sólida) — nunca a mesma aparência de um compromisso confirmado (5.4A
  // seção 18). Distinto de `warning` "normal" pela borda, não só pela cor.
  risk: "bg-warning/10 text-warning border border-dashed border-warning/40",
  // HIPOTÉTICO: qualquer coisa vinda do simulador — cor própria
  // (--color-hypothetical), nunca a mesma cor de um fato real (item 7 do
  // pedido geral / princípio "simulation never touches truth").
  hypothetical: "bg-hypothetical/15 text-hypothetical border border-hypothetical/30",
};

export default function Badge({ variant = "neutral", className = "", children, ...props }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium ${VARIANTS[variant]} ${className}`} {...props}>
      {children}
    </span>
  );
}
