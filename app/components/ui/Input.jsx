// Fase 5.4B, item 19 — Input primitive. Unifica height/padding/border/
// surface/placeholder/focus/error/disabled num só lugar. Não força migração
// de formulário nenhum existente (Simulador continua com sua própria classe
// até 5.4E, item 19 explícito) — disponível pra uso novo a partir de agora.
export default function Input({ error = false, className = "", ...props }) {
  return (
    <input
      className={`focus-ring w-full rounded-control border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50 ${
        error ? "border-danger" : "border-border-subtle"
      } ${className}`}
      aria-invalid={error || undefined}
      {...props}
    />
  );
}
