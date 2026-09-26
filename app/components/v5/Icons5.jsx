// Fase 10 — ícones (paths do protótipo v5).
export const PATHS = {
  left: "M14.5 6 8.5 12l6 6",
  right: "M9.5 6l6 6-6 6",
  check: "M5 12.5 9.5 17 19 7.5",
  x: "M7 7l10 10M17 7 7 17",
  down: "M12 5v14M6.5 13.5 12 19l5.5-5.5",
  wifi: "M8.5 8.5a5 5 0 0 1 0 7M12 6a8.5 8.5 0 0 1 0 12M5 11a2 2 0 0 1 0 2",
};
export function Ico5({ name, className, style }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
