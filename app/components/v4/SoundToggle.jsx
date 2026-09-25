"use client";
import { Ico } from "./Icons.jsx";

export default function SoundToggle({ soundOn, onToggle, compact = false }) {
  const label = soundOn ? "Som ligado" : "Som desligado";
  return (
    <button type="button" className="n4-sound" onClick={onToggle} aria-pressed={soundOn} aria-label={`${label}. Alternar som das conquistas`} title={label} style={compact ? { width: 44, justifyContent: "center", padding: 0 } : undefined}>
      <Ico name={soundOn ? "soundOn" : "soundOff"} size={16} width={1.7} />
      {!compact && <span>{label}</span>}
    </button>
  );
}
