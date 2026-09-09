// Fase 5.4B, item 19 — Select primitive, mesma receita visual do Input
// (mesma altura/padding/borda/foco) pra nunca desalinhar num formulário que
// misture os dois.
//
// Fase 5.4E.1.1, item 5/16/19 — MEDIDO ao vivo: px-3 py-2 text-sm dava
// ~38px de altura real, abaixo de 44px. `pointer-coarse:min-h-11` só em
// touch — font-size (text-sm, 14px) INTOCADO de propósito (mexer nisso
// dispara auto-zoom estranho no iOS quando <16px, item 19 explícito).
export default function Select({ error = false, className = "", children, ...props }) {
  return (
    <select
      className={`focus-ring w-full rounded-control border bg-surface-2 px-3 py-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 ${
        error ? "border-danger" : "border-border-subtle"
      } ${className}`}
      aria-invalid={error || undefined}
      {...props}
    >
      {children}
    </select>
  );
}
