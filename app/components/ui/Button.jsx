// Fase 6.0 (Design Freeze) — Button primitive reconstruído sobre a
// identidade final do ZIP: pill escura como ação primária (o "botão preto"
// onipresente na referência), pill lime como CTA de destaque (usada com
// moderação — é o único accent de marca, não o botão padrão de toda tela),
// ghost/secondary neutros, danger usa o mesmo ocre do resto do sistema
// (a referência nunca usa vermelho, nem no fluxo destrutivo do Data Hub).
//
// Toque/hover: a referência levanta o botão (`translateY(-1px)`) e troca a
// sombra no hover, em vez de só escurecer a cor — reproduzido via
// `.transition-press` + `hover:-translate-y-px`.
const VARIANTS = {
  primary: "bg-ink text-white shadow-button hover:shadow-button-hover hover:-translate-y-px active:translate-y-0",
  accent: "bg-accent text-accent-foreground hover:bg-accent-hover hover:-translate-y-px active:translate-y-0",
  secondary: "bg-surface text-text-primary border border-border-strong shadow-card hover:bg-surface-2",
  ghost: "bg-transparent text-text-secondary hover:bg-surface-3 hover:text-text-primary",
  danger: "bg-danger-bg text-danger-text border border-danger/30 hover:bg-danger-bg",
};

export default function Button({ variant = "primary", loading = false, disabled = false, className = "", children, ...props }) {
  const isDisabled = disabled || loading;
  return (
    <button
      className={`focus-ring transition-press inline-flex items-center justify-center gap-2 rounded-control px-4 py-2.5 text-sm font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:translate-y-0 disabled:shadow-none pointer-coarse:min-h-11 ${VARIANTS[variant]} ${className}`}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
