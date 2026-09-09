// Fase 5.4B, item 19 — Select primitive, mesma receita visual do Input
// (mesma altura/padding/borda/foco) pra nunca desalinhar num formulário que
// misture os dois.
export default function Select({ error = false, className = "", children, ...props }) {
  return (
    <select
      className={`focus-ring w-full rounded-control border bg-surface-2 px-3 py-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50 ${
        error ? "border-danger" : "border-border-subtle"
      } ${className}`}
      aria-invalid={error || undefined}
      {...props}
    >
      {children}
    </select>
  );
}
