// Fase 9.1 — ícones do protótipo v4 (paths idênticos). Decorativos: aria-hidden.
export const ICON = {
  home: "M4 10.6 12 4l8 6.6V19a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z",
  card: "M3 8.5h18M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM6.5 15.5h4",
  bill: "M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8zM9.5 8.5h5M9.5 12.5h5",
  sim: "M4 8h8M16 8h4M4 16h4M12 16h8M14 5.5v5M8 13.5v5",
  check: "M5 12.5 9.5 17 19 7.5",
  plus: "M12 5.5v13M5.5 12h13",
  arrow: "M4.5 12h14M13 6.5l5.5 5.5L13 17.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  lock: "M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M5.5 10.5h13v9.5h-13z",
  house: "M4 10.6 12 4l8 6.6V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z",
  repeat: "M4.5 9.5A6.5 6.5 0 0 1 16 6.2l3 2.8M19.5 14.5A6.5 6.5 0 0 1 8 17.8l-3-2.8M19 4.5v4.5h-4.5M5 19.5V15h4.5",
  person: "M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20a7 7 0 0 1 14 0",
  bolt: "M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6z",
  net: "M4 9.5a12 12 0 0 1 16 0M7 12.8a7.5 7.5 0 0 1 10 0M10 16a3 3 0 0 1 4 0M12 19h.01",
  drop: "M12 3.8c3 3.6 5.5 6.6 5.5 9.7a5.5 5.5 0 0 1-11 0c0-3.1 2.5-6.1 5.5-9.7z",
  phone: "M8.5 3.5h7a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 19V5a1.5 1.5 0 0 1 1.5-1.5zM11 17.5h2",
  spark: "M12 3.5l1.6 4.9 4.9 1.6-4.9 1.6L12 16.5l-1.6-4.9L5.5 10l4.9-1.6zM18 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  soundOn: "M4.5 9.5h3l4.5-4v13l-4.5-4h-3zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
  soundOff: "M4.5 9.5h3l4.5-4v13l-4.5-4h-3zM16 9.5l5 5M21 9.5l-5 5",
  pencil: "M4.5 19.5l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L8.5 18.5zM13.5 7.5l3 3",
  tv: "M4 6.5h16v10H4zM9 20h6M12 16.5V20",
};

export function Ico({ name, size = 15, stroke = "currentColor", width = 1.8, className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={`n4-ico ${className}`} style={{ width: size, height: size, stroke, strokeWidth: width, ...style }}>
      <path d={ICON[name] ?? name} />
    </svg>
  );
}
