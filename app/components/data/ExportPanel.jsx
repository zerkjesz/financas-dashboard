"use client";

import { useEffect, useState } from "react";
import { Download, Sheet, Check } from "lucide-react";
import Button from "../ui/Button.jsx";

const PERIOD_LABEL = { all: "Todo o histórico", last12months: "Últimos 12 meses", thisyear: "Este ano" };

// Fase 6.0 (Design Freeze) — "Levar uma cópia" (Exportar). O hero e o
// contador de linhas/tamanho são REAIS (rowCount/sheetCount vêm do próprio
// download; a lista de sheets e contagem por aba vêm de /api/data/sheets) —
// nunca o nome/tamanho mock do protótipo ("norte-dados-set-2026.xlsx",
// "1,9 MB" fixos).
export default function ExportPanel() {
  const [sheets, setSheets] = useState(null);
  const [selected, setSelected] = useState(null); // null = todas
  const [period, setPeriod] = useState("all");
  const [custom, setCustom] = useState(false);
  const [state, setState] = useState("idle"); // idle | exportando | pronto
  const [lastResult, setLastResult] = useState(null);

  useEffect(() => {
    fetch(`/api/data/sheets?period=${period}`)
      .then((r) => r.json())
      .then((d) => {
        setSheets(d.sheets);
        setSelected((prev) => prev ?? d.sheets.map((s) => s.key));
      });
  }, [period]);

  function toggleSheet(key) {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function runExport() {
    setState("exportando");
    const params = new URLSearchParams({ period });
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
  const selCount = selected && sheets ? `${selected.length} de ${sheets.length}` : "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
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
            <span className="rounded-pill bg-white/10 px-3 py-1.5">Período {PERIOD_LABEL[period]}</span>
            {lastResult && <span className="rounded-pill bg-white/10 px-3 py-1.5">Gerado agora</span>}
          </div>

          {state === "idle" && (
            <Button variant="accent" className="w-full" onClick={runExport} disabled={!sheets}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Baixar planilha completa
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
            <div className="text-eyebrow text-text-muted mb-2">Período</div>
            <div className="flex gap-1 rounded-control bg-surface p-1">
              {Object.entries(PERIOD_LABEL).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setPeriod(key)}
                  className={`focus-ring flex-1 rounded-control px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer ${period === key ? "bg-ink text-white" : "text-text-secondary hover:bg-chip-bg"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-caption text-text-muted mt-2">Toque nas abas abaixo pra tirar ou colocar de volta.</p>
          </div>
        )}

        <div className="max-h-[352px] overflow-y-auto -mx-2 px-2">
          {!sheets && <p className="text-body text-text-muted">Carregando…</p>}
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
                  <span className="block text-caption text-text-muted truncate">{s.description}</span>
                </span>
                <span className="tabular shrink-0 text-xs text-text-muted">{s.rowCount.toLocaleString("pt-BR")}</span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
