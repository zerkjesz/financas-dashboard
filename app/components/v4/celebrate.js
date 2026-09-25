// ============================================================================
// Fase 9.1 — GAMIFICAÇÃO (som + confete + vibração). Tudo aqui é opcional e nunca bloqueia a ação
// financeira: só roda DEPOIS do sucesso REAL do backend (quem chama garante), respeita
// prefers-reduced-motion e a preferência de som do usuário (persistida em localStorage).
// Funções puras/injetáveis (window/storage passados) — testáveis em node sem DOM.
// ============================================================================
export const SOUND_STORAGE_KEY = "norte.sound";

export function readSoundPref(storage) {
  try {
    const v = storage?.getItem(SOUND_STORAGE_KEY);
    return v !== "off"; // default: ligado
  } catch {
    return true; // storage bloqueado (modo privado etc.): mantém o default, nunca quebra
  }
}
export function writeSoundPref(storage, on) {
  try {
    storage?.setItem(SOUND_STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* storage indisponível: a preferência só vale nesta sessão */
  }
}
export function prefersReducedMotion(win) {
  try {
    return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {
    return false;
  }
}

// Dois tons curtos (C6 -> G6), envelope suave. Um AudioContext reutilizado (criado no gesto do clique,
// que é o que a política de autoplay dos navegadores exige). Falha silenciosa: som é enhancement.
export function playChime(win, state = {}) {
  try {
    const AC = win?.AudioContext || win?.webkitAudioContext;
    if (!AC) return false;
    state.ac = state.ac || new AC();
    const ac = state.ac;
    if (ac.state === "suspended") ac.resume?.();
    const t = ac.currentTime;
    for (const [fq, d] of [[1046.5, 0], [1567.98, 0.075]]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = fq;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.08, t + d + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.42);
      o.connect(g);
      g.connect(ac.destination);
      o.start(t + d);
      o.stop(t + d + 0.46);
    }
    return true;
  } catch {
    return false;
  }
}

export function vibrate(nav, ms = 12) {
  try {
    return !!nav?.vibrate?.(ms);
  } catch {
    return false;
  }
}

// Micro-confete discreto (18 peças, ~0,9s) a partir do centro do botão. Só lime/ink/cinza do Norte.
export function burstConfetti(doc, rect) {
  if (!doc || !rect) return 0;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const cols = ["#C9FF29", "#0B0B0C", "#C9FF29", "#C6CAD0"];
  let n = 0;
  for (let i = 0; i < 18; i++) {
    const d = doc.createElement("div");
    const w = 4 + Math.random() * 4;
    const h = w * (Math.random() < 0.5 ? 1 : 2.2);
    d.setAttribute("aria-hidden", "true");
    d.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:${w}px;height:${h}px;background:${cols[i % 4]};border-radius:${Math.random() < 0.4 ? "50%" : "1.5px"};pointer-events:none;z-index:200`;
    doc.body.appendChild(d);
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
    const dist = 50 + Math.random() * 80;
    const dx = Math.cos(a) * dist;
    const dy = Math.sin(a) * dist + 30;
    const anim = d.animate?.(
      [
        { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${(Math.random() - 0.5) * 540}deg)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 250, easing: "cubic-bezier(.2,.7,.3,1)" }
    );
    if (anim) anim.onfinish = () => d.remove();
    else d.remove();
    n++;
  }
  return n;
}

// Chamada SÍNCRONA dentro do handler do clique (antes de qualquer await): cria/retoma o AudioContext
// enquanto a ativação do usuário ainda vale (Safari/iOS exigem). Silencioso, não toca nada.
export function primeAudio({ win, storage, audioState }) {
  try {
    if (!readSoundPref(storage)) return false;
    const AC = win?.AudioContext || win?.webkitAudioContext;
    if (!AC) return false;
    audioState.ac = audioState.ac || new AC();
    if (audioState.ac.state === "suspended") audioState.ac.resume?.();
    return true;
  } catch {
    return false;
  }
}

// Orquestra a celebração — chamada SOMENTE após o backend confirmar. `env` = { window, document, navigator, storage }.
export function celebrate({ rect, env, audioState }) {
  const { window: win, document: doc, navigator: nav, storage } = env;
  const result = { sound: false, vibrate: false, confetti: 0 };
  if (readSoundPref(storage)) result.sound = playChime(win, audioState);
  result.vibrate = vibrate(nav);
  if (!prefersReducedMotion(win)) result.confetti = burstConfetti(doc, rect);
  return result;
}
