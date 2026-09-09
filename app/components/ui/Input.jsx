// Fase 5.4B, item 19 — Input primitive. Unifica height/padding/border/
// surface/placeholder/focus/error/disabled num só lugar.
//
// Fase 5.4E.1.1, item 5/16/19 — MEDIDO ao vivo: mesma situação do Select
// (px-3 py-2 text-sm ~38px real). `pointer-coarse:min-h-11` só em touch,
// font-size intocado (evita zoom automático do iOS).
export default function Input({ error = false, className = "", ...props }) {
  return (
    <input
      className={`focus-ring w-full rounded-control border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 ${
        error ? "border-danger" : "border-border-subtle"
      } ${className}`}
      aria-invalid={error || undefined}
      {...props}
    />
  );
}
