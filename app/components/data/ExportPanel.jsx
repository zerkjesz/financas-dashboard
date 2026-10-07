"use client";

import { useEffect, useState } from "react";
import { Download, Sheet, Check } from "lucide-react";
import Button from "../ui/Button.jsx";

// Fase 10.3 — período explícito e SEMPRE visível. Os presets são os mesmos de lib/dataHub/range.js (a resolução das datas é
// feita no servidor, com o ciclo 24→23 da Fase 10.2); aqui só se escolhe e se mostra o range resolvido.
const PRESETS = [
  { key: "current_cycle", label: "Ciclo atual" },
  { key: "previous_cycle", label: "Ciclo anterior" },
  { key: "last_30_days", label: "Últimos 30 dias" },
  { key: "last_90_days", label: "Últimos 90 dias" },
  { key: "this_year", label: "Este ano" },
  { key: "since_norte_start", label: "Desde o início do Norte" },
  { key: "all_time", label: "Período todo" },
  { key: "custom", label: "Personalizado" },
];
const PRESET_KEYS = PRESETS.map((p) => p.key);
const DEFAULT_PRESET = "current_cycle";
const STORAGE_KEY = "norte.dataHub.exportPreset";
const BR_DATE = /^\d{2}\/\d{2}\/\d{4}$/;

function readStoredPreset() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return PRESET_KEYS.includes(v) && v !== "custom" ? v : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

// Máscara DD/MM/AAAA enquanto digita.
function maskDate(v) {
  const d = v.replace(/\D/g, "").slice(0, 8);
  if (d.length > 4) return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
  if (d.length > 2) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return d;
}

// Fase 6.0 (Design Freeze) — "Levar uma cópia" (Exportar). O hero e o contador de linhas/tamanho são REAIS (rowCount/sheetCount
// vêm do próprio download; a lista de abas e a contagem por aba vêm de /api/data/export/preview, que é somente leitura).
export default function ExportPanel() {
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // null = todas
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [custom, setCustom] = useState(false);
  const [state, setState] = useState("idle"); // idle | exportando | pronto
  const [lastResult, setLastResult] = useState(null);
  const sheets = preview?.sheets ?? null;

  useEffect(() => {
    setPreset(readStoredPreset());
  }, []);

  // no celular a fileira de chips rola na horizontal: mantém o preset escolhido à vista
  useEffect(() => {
    document.querySelector(`[data-preset="${preset}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [preset]);

  function choosePreset(key) {
    setPreset(key);
    setState((st) => (st === "pronto" ? "idle" : st));
    if (key !== "custom") {
      try {
        window.localStorage.setItem(STORAGE_KEY, key);
      } catch {}
    }
  }

  const customReady = preset !== "custom" || (BR_DATE.test(customFrom) && BR_DATE.test(customTo));

  function rangeQuery() {
    const params = new URLSearchParams({ preset });
    if (preset === "custom") {
      params.set("dateFrom", customFrom);
      params.set("dateTo", customTo);
    }
    return params;
  }

  useEffect(() => {
    if (!customReady) {
      setPreview(null);
      setPreviewError(preset === "custom" && (customFrom || customTo) ? "Informe as duas datas no formato DD/MM/AAAA." : null);
      setLoading(false);
      return undefined;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setPreviewError(null);
    fetch(`/api/data/export/preview?${rangeQuery().toString()}`, { signal: ctrl.signal })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message || "Não foi possível calcular o período.");
        return d;
      })
      .then((d) => {
        setPreview(d);
        setSelected((prev) => prev ?? d.sheets.map((s) => s.key));
        setLoading(false);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setPreview(null);
        setPreviewError(e.message);
        setLoading(false);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, customReady]);

  function toggleSheet(key) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function runExport() {
    setState("exportando");
    const params = rangeQuery();
    if (selected && sheets && selected.length < sheets.length) params.set("sheets", selected.join(","));
    try {
      const res = await fetch(`/api/data/export?${params.toString()}`);
      if (!res.ok) throw new Error("export_failed");
      const blob = await res.blob();
      const sheetCount = res.headers.get("X-Sheet-Count");
      const rowCount = res.headers.get("X-Row-Count");
      const disposition = res.headers.get("Content-Disposition") || "";
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] || "norte-dados.xlsx";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setLastResult({ fileName, sheetCount, rowCount, sizeMB: (blob.size / 1024 / 1024).toFixed(1) });
      setState("pronto");
    } catch {
      setState("idle");
    }
  }

  const totalRows = sheets && selected ? sheets.filter((s) => selected.includes(s.key)).reduce((a, s) => a + s.rowCount, 0) : 0;
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? "";
  const rangeText = preview?.rangeText ?? null;
  const selCount = selected && sheets ? `${selected.length} de ${sheets.length}` : "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Período — sempre visível; o range resolvido (datas reais) nunca fica escondido */}
      <div className="lg:col-span-2 rounded-card bg-surface shadow-card p-5 sm:p-6" data-testid="export-period">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between mb-3">
          <h3 className="text-card-title text-text-primary">Período da planilha</h3>
          <p className="text-sm text-text-secondary [font-variant-numeric:tabular-nums]" data-testid="export-range-text" aria-live="polite">
            {loading ? "Calculando período…" : previewError ? "" : rangeText ? <><span className="font-medium text-text-primary">{presetLabel}</span> · {rangeText}</> : ""}
          </p>
        </div>
        <div role="radiogroup" aria-label="Período da planilha" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              role="radio"
              aria-checked={preset === p.key}
              data-preset={p.key}
              onClick={() => choosePreset(p.key)}
              className={`focus-ring shrink-0 whitespace-nowrap rounded-pill px-3.5 py-2 text-sm font-medium transition-colors cursor-pointer ${preset === p.key ? "bg-ink text-white" : "bg-chip-bg text-text-secondary hover:text-text-primary"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="mt-3 grid grid-cols-2 gap-3 max-w-md">
            <label className="block">
              <span className="text-eyebrow text-text-muted">De</span>
              <input value={customFrom} onChange={(e) => setCustomFrom(maskDate(e.target.value))} inputMode="numeric" placeholder="DD/MM/AAAA" maxLength={10} aria-label="Data inicial" className="focus-ring mt-1 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm tabular" />
            </label>
            <label className="block">
              <span className="text-eyebrow text-text-muted">Até</span>
              <input value={customTo} onChange={(e) => setCustomTo(maskDate(e.target.value))} inputMode="numeric" placeholder="DD/MM/AAAA" maxLength={10} aria-label="Data final" className="focus-ring mt-1 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm tabular" />
            </label>
          </div>
        )}
        {previewError && <p role="alert" className="mt-3 text-sm text-red-700">{previewError}</p>}
        {preset === "all_time" && <p className="mt-3 text-caption text-text-muted">Sem filtro de datas: leva tudo que o Norte guarda, de qualquer época.</p>}
      </div>

      {/* Hero escuro — "Levar uma cópia" */}
      <div className="relative overflow-hidden rounded-card bg-ink p-8 text-white">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />
        <div className="relative">
          <div className="text-eyebrow text-white/60 mb-3">Levar uma cópia</div>
          <h2 className="text-[1.75rem] font-semibold leading-tight mb-6 max-w-sm">Tudo que o Norte sabe sobre o seu dinheiro, em uma planilha.</h2>

          <div className="rounded-2xl bg-white/[0.06] p-4 flex items-center gap-3 mb-4">
            <div className="relative flex h-14 w-11 shrink-0 flex-col items-center justify-center rounded-lg bg-accent text-ink">
              <Sheet className="h-4 w-4" aria-hidden="true" strokeWidth={2} />
              <span className="mt-0.5 text-[8px] font-mono font-semibold">XLSX</span>
              {state === "pronto" && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-ink">
                  <Check className="h-3 w-3" aria-hidden="true" strokeWidth={3} />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{lastResult?.fileName ?? "norte-dados.xlsx"}</div>
              <div className="text-caption text-white/60">
                {selCount} abas · {totalRows.toLocaleString("pt-BR")} linhas{lastResult ? ` · ${lastResult.sizeMB} MB` : ""}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-6 text-xs">
            <span className="rounded-pill bg-white/10 px-3 py-1.5">Formato XLSX</span>
            <span className="rounded-pill bg-white/10 px-3 py-1.5">{rangeText ? `${presetLabel} · ${rangeText}` : presetLabel}</span>
            {lastResult && <span className="rounded-pill bg-white/10 px-3 py-1.5">Gerado agora</span>}
          </div>

          {state === "idle" && (
            <Button variant="accent" className="w-full" onClick={runExport} disabled={!sheets || loading || !!previewError}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Baixar planilha
            </Button>
          )}
          {state === "exportando" && (
            <div className="rounded-control bg-white/[0.08] p-4">
              <div className="flex items-center gap-2 text-sm mb-2">
                <span className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" aria-hidden="true" />
                Montando sua planilha…
              </div>
              <div className="h-1 overflow-hidden rounded-pill bg-white/15">
                <div className="h-full w-2/3 rounded-pill bg-accent animate-pulse-soft" />
              </div>
            </div>
          )}
          {state === "pronto" && (
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent/25 px-3 py-1.5 text-sm text-accent">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Pronto, o download começou
              </span>
              <Button variant="secondary" onClick={() => setState("idle")}>
                Baixar de novo
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* "O que vem dentro" */}
      <div className="rounded-card bg-surface shadow-card p-7">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-card-title text-text-primary">O que vem dentro</h3>
          <button onClick={() => setCustom((v) => !v)} className="focus-ring text-sm font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
            {custom ? "Ocultar opções" : "Escolher o que levar"}
          </button>
        </div>

        {custom && (
          <div className="rounded-control bg-chip-bg p-4 mb-4">
            <p className="text-caption text-text-muted">Toque nas abas abaixo pra tirar ou colocar de volta.</p>
          </div>
        )}

        <div className="max-h-[352px] overflow-y-auto -mx-2 px-2">
          {!sheets && <p className="text-body text-text-muted">{loading ? "Carregando…" : "Escolha um período válido para ver o que vem dentro."}</p>}
          {sheets?.map((s) => {
            const checked = selected?.includes(s.key);
            return (
              <label key={s.key} className="flex items-center gap-3 rounded-control px-2 py-2.5 hover:bg-chip-bg cursor-pointer transition-colors">
                <span
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors ${checked ? "border-accent bg-accent" : "border-border-strong"}`}
                >
                  {checked && <Check className="h-3 w-3 text-ink" aria-hidden="true" strokeWidth={3} />}
                </span>
                <input type="checkbox" className="sr-only" checked={!!checked} onChange={() => toggleSheet(s.key)} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm ${checked ? "text-text-primary" : "text-text-muted"}`}>{s.sheetName}</span>
                  <span className="block text-caption text-text-muted truncate">{s.description}{s.globalStateCount > 0 ? ` · ${s.globalStateCount} de estado atual` : ""}{s.noEventDateCount > 0 ? ` · ${s.noEventDateCount} sem data` : ""}</span>
                </span>
                <span className="tabular shrink-0 text-xs text-text-muted" data-sheet-count={s.key}>{s.rowCount.toLocaleString("pt-BR")}</span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
