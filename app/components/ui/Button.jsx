// Fase 5.4B, item 17 — Button primitive. Accent é usado SÓ no variant
// primary (invariante da seção 8/27: accent nunca representa estado
// financeiro positivo, só ação). Todos os variants levam foco visível
// (.focus-ring) e um estado disabled real (nunca só opacidade sem
// pointer-events).
const VARIANTS = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover",
  secondary: "bg-surface-2 text-text-primary border border-border-strong hover:bg-surface-3",
  ghost: "bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

export default function Button({ variant = "primary", loading = false, disabled = false, className = "", children, ...props }) {
  const isDisabled = disabled || loading;
  return (
    <button
      className={`focus-ring inline-flex items-center justify-center gap-2 rounded-control px-4 py-2 text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
