"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { celebrate, primeAudio, readSoundPref, writeSoundPref } from "./celebrate.js";

// Fase 9.1 — preferência de som (persistida) + celebração/priming. `celebrateAt` só deve ser chamado
// DEPOIS do sucesso real do backend; `prime` no próprio clique (gesto do usuário).
export function useNorteAudio() {
  const [soundOn, setSoundOn] = useState(true);
  const audioRef = useRef({});
  useEffect(() => {
    try {
      setSoundOn(readSoundPref(window.localStorage));
    } catch {
      setSoundOn(true);
    }
  }, []);
  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      try {
        writeSoundPref(window.localStorage, next);
      } catch {}
      return next;
    });
  }, []);
  const env = () => {
    let storage = null;
    try {
      storage = window.localStorage;
    } catch {}
    return { window, document, navigator, storage };
  };
  const prime = useCallback(() => primeAudio({ win: window, storage: env().storage, audioState: audioRef.current }), []);
  const celebrateAt = useCallback((rect) => celebrate({ rect, env: env(), audioState: audioRef.current }), []);
  return { soundOn, toggleSound, prime, celebrateAt };
}
