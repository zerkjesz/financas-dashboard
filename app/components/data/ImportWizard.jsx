"use client";

import { useRef, useState } from "react";
import { Upload, Loader2, AlertTriangle, Plus, Repeat, Trash2, Check } from "lucide-react";
import Button from "../ui/Button.jsx";
import Input from "../ui/Input.jsx";
import { formatMoney } from "@/lib/formatMoney";

const MODES = [
  { key: "add", label: "Adicionar", description: "Só entra o que é novo. Nada do que já existe muda.", icon: Plus },
  { key: "update", label: "Atualizar", description: "Cruza pelos registros existentes e corrige o que mudou.", icon: Repeat },
  { key: "replace", label: "Substituir", description: "Remove o conjunto atual do período e coloca o do arquivo no lugar.", icon: Trash2, danger: true },
];

const TAG_STYLE = {
  Novo: "bg-accent/20 text-ink",
  Atualiza: "bg-chip-bg text-text-secondary",
  Ignora: "bg-chip-bg text-text-muted",
  Conflito: "bg-warning-bg text-warning-text",
};

function fmtCell(v) {
  if (v == null) return "—";
  if (typeof v === "number") return formatMoney(v);
  return String(v);
}

export default function ImportWizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState("add");
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // { batchId, summary, sampleDiffRows, ... }
  const [resolutions, setResolutions] = useState({});
  const [confirmText, setConfirmText] = useState("");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  function reset() {
    setStep(0);
    setFile(null);
    setError(null);
    setPreview(null);
    setResolutions({});
    setConfirmText("");
    setResult(null);
  }

  async function handleFile(f) {
    if (!f) return;
    setFile(f);
    setStep(1);
    setError(null);
    const form = new FormData();
    form.append("file", f);
    form.append("mode", mode);
    form.append("period", "all");
    try {
      const res = await fetch("/api/data/import/preview", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Não foi possível validar o arquivo.");
        setStep(0);
        return;
      }
      setPreview(data);
      setStep(2);
    } catch {
      setError("Falha de rede ao validar o arquivo.");
      setStep(0);
    }
  }

  const conflicts = (preview?.sampleDiffRows || []).filter((r) => r.tag === "Conflito" && r.conflictKey);
  const unresolvedCount = conflicts.filter((c) => !resolutions[c.conflictKey] || resolutions[c.conflictKey] === "rever").length;

  async function applyNow() {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/api/data/import/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: preview.batchId, resolutions, confirmText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "A importação falhou.");
        setApplying(false);
        return;
      }
      setResult(data);
      setStep(5);
      onDone?.();
    } catch {
      setError("Falha de rede ao aplicar a importação.");
    }
    setApplying(false);
  }

  const isSub = mode === "replace";
  const confirmOk = !isSub || confirmText.trim().toUpperCase() === "SUBSTITUIR";

  return (
    <div className="space-y-4">
      {/* Seletor de modo — sempre visível no topo, exceto na tela final. */}
      {step < 5 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = mode === m.key;
            const dangerActive = active && m.danger;
            return (
              <button
                key={m.key}
                onClick={() => step === 0 && setMode(m.key)}
                disabled={step !== 0}
                className={`focus-ring text-left rounded-card p-4 transition-colors cursor-pointer disabled:cursor-not-allowed ${
                  dangerActive ? "bg-warning-bg text-warning-text shadow-[0_0_0_1.5px_var(--color-warning)]" : active ? "bg-ink text-white" : "bg-surface shadow-card text-text-primary hover:bg-chip-bg"
                }`}
              >
                <Icon className="h-4 w-4 mb-2" aria-hidden="true" strokeWidth={1.8} />
                <div className="text-sm font-semibold mb-1">{m.label}</div>
                <div className={`text-xs leading-snug ${dangerActive ? "text-warning-text/80" : active ? "text-white/70" : "text-text-muted"}`}>{m.description}</div>
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-control bg-danger-bg text-danger-text px-4 py-3 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {/* Step 0 — upload */}
      {step === 0 && (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFile(e.dataTransfer.files?.[0]);
          }}
          className="focus-ring rounded-card bg-surface shadow-card p-16 text-center cursor-pointer ring-1 ring-inset ring-border-subtle hover:ring-border-strong transition-colors"
        >
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-tile bg-ink text-white">
            <Upload className="h-6 w-6" aria-hidden="true" strokeWidth={1.8} />
          </div>
          <h3 className="text-card-title text-text-primary mb-1">Arraste sua planilha aqui</h3>
          <p className="text-caption text-text-muted mb-5">XLSX — a gente confere tudo antes de mexer em qualquer coisa.</p>
          <Button variant="primary" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
            Escolher arquivo
          </Button>
          <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
        </div>
      )}

      {/* Step 1 — processando */}
      {step === 1 && (
        <div className="rounded-card bg-surface shadow-card p-14 text-center">
          <Loader2 className="mx-auto mb-4 h-9 w-9 animate-spin text-text-secondary" aria-hidden="true" />
          <h3 className="text-card-title text-text-primary mb-1">Lendo {file?.name}</h3>
          <p className="text-caption text-text-muted">Nada foi alterado ainda.</p>
        </div>
      )}

      {/* Step 2 — prévia / diff */}
      {step === 2 && preview && (
        <div className="space-y-4">
          <div className="rounded-card bg-surface shadow-card p-6">
            <div className="flex items-center gap-3 mb-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-tile bg-chip-bg text-text-secondary">
                <Upload className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary truncate">{file?.name}</div>
                <div className="text-caption text-text-muted">modo {MODES.find((m) => m.key === mode)?.label.toLowerCase()}</div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent/20 px-3 py-1 text-xs text-ink shrink-0">
                <Check className="h-3 w-3" aria-hidden="true" />
                Validado, nada aplicado
              </span>
            </div>

            {!preview.schemaVersionKnown && (
              <div className="rounded-control bg-warning-bg text-warning-text px-3 py-2 text-sm mb-3">
                Este arquivo veio de uma versão diferente do Norte — os campos foram validados individualmente mesmo assim.
              </div>
            )}

            {mode === "replace" ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat value={preview.summary.toCreate} label="Vêm do arquivo" />
                <Stat value={preview.summary.toDelete} label="Saem (no escopo)" />
                <Stat value={preview.summary.protectedCount} label="Protegidos (ficam)" />
                <Stat value={preview.summary.invalid} label="Inválidos" />
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat value={preview.summary.creates} label="Registros novos" />
                <Stat value={preview.summary.updates} label="Para atualizar" />
                <Stat value={preview.summary.conflicts} label="Conflitos" />
                <Stat value={preview.summary.invalid} label="Inválidos" />
              </div>
            )}
          </div>

          {preview.sampleDiffRows?.length > 0 && (
            <div className="rounded-card bg-surface shadow-card p-6">
              <h3 className="text-card-title text-text-primary mb-1">O que vai acontecer</h3>
              <p className="text-caption text-text-muted mb-4">Uma amostra do que muda. Nada é aplicado enquanto você não confirmar.</p>
              <div className="overflow-x-auto -mx-2">
                <div className="min-w-[560px] px-2">
                  <div className="grid grid-cols-[80px_minmax(0,1fr)_100px_20px_100px] gap-2 text-eyebrow text-text-muted pb-2 border-b border-border-subtle">
                    <span>Ação</span>
                    <span>Registro</span>
                    <span>Hoje</span>
                    <span />
                    <span>Depois</span>
                  </div>
                  {preview.sampleDiffRows.slice(0, 30).map((r, i) => (
                    <div key={i} className="grid grid-cols-[80px_minmax(0,1fr)_100px_20px_100px] gap-2 items-center py-2.5 border-b border-border-subtle text-sm">
                      <span className={`inline-flex w-fit items-center rounded-pill px-2 py-0.5 text-xs font-medium ${TAG_STYLE[r.tag]}`}>{r.tag}</span>
                      <span className="min-w-0 truncate">
                        {r.label}
                        <span className="block text-caption text-text-muted truncate">{r.sub}</span>
                      </span>
                      <span className="tabular text-text-muted truncate">{r.before ? fmtCell(Object.values(r.before)[0]) : "—"}</span>
                      <span className="text-text-muted text-center">→</span>
                      <span className="tabular text-text-primary font-medium truncate">{r.after ? fmtCell(Object.values(r.after)[0]) : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            {conflicts.length > 0 ? (
              <Button variant="primary" onClick={() => setStep(3)}>
                Revisar {conflicts.length} conflito{conflicts.length > 1 ? "s" : ""}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setStep(4)}>
                Continuar
              </Button>
            )}
            <Button variant="ghost" onClick={reset}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — conflitos */}
      {step === 3 && (
        <div className="rounded-card bg-surface shadow-card p-6">
          <div className="flex items-center gap-2 mb-1">
            <span className="flex h-9 w-9 items-center justify-center rounded-tile bg-warning-bg text-warning-text">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            </span>
            <h3 className="text-card-title text-text-primary">
              {conflicts.length} registro{conflicts.length > 1 ? "s" : ""} já existe{conflicts.length > 1 ? "m" : ""} com valor diferente
            </h3>
          </div>
          <p className="text-caption text-text-muted mb-1">{Object.values(resolutions).filter((r) => r && r !== "rever").length} de {conflicts.length} resolvidos</p>
          <p className="text-caption text-text-muted mb-5">Escolha com qual versão ficar. O resto da importação não muda.</p>

          <div className="space-y-4">
            {conflicts.map((c) => (
              <div key={c.conflictKey} className="rounded-control bg-chip-bg p-4">
                <div className="flex items-center justify-between gap-3 mb-3 text-sm">
                  <span className="font-medium text-text-primary truncate">{c.label}</span>
                  <span className="flex items-center gap-2 tabular text-xs text-text-muted shrink-0">
                    <span>No Norte: {fmtCell(Object.values(c.before || {})[0])}</span>
                    <span>→</span>
                    <span className="text-text-primary font-medium">No arquivo: {fmtCell(Object.values(c.after || {})[0])}</span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    ["manter", "Manter o atual"],
                    ["usar", "Usar o do arquivo"],
                    ["rever", "Ver depois"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setResolutions((prev) => ({ ...prev, [c.conflictKey]: key }))}
                      className={`focus-ring rounded-control px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                        resolutions[c.conflictKey] === key ? "bg-ink text-white" : "bg-surface text-text-secondary hover:bg-surface-2"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mt-6">
            <Button variant="primary" onClick={() => setStep(4)}>
              Continuar
            </Button>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Voltar para a prévia
            </Button>
          </div>
        </div>
      )}

      {/* Step 4 — confirmação */}
      {step === 4 && preview && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-card bg-surface shadow-card p-6">
            <p className="text-caption text-text-muted mb-4">Depois de confirmar, o Norte aplica exatamente isto:</p>
            <div className="space-y-3 text-sm">
              {isSub ? (
                <>
                  <Row label="Vão entrar" value={`${preview.summary.toCreate} registros`} />
                  <Row label="Vão sair" value={`${preview.summary.toDelete} registros`} />
                  <Row label="Ficam protegidos" value={`${preview.summary.protectedCount} registros vinculados a compromissos`} />
                  <Row label="Não são tocados" value="Metas, cartões e limites" />
                </>
              ) : (
                <>
                  <Row label="Vão entrar" value={`${preview.summary.creates} registros`} />
                  <Row label="Vão ser corrigidos" value={`${preview.summary.updates + Object.values(resolutions).filter((r) => r === "usar").length} registros`} />
                  <Row label="Ficam como estão" value={`${preview.summary.skips} registros`} />
                  <Row label="Não são tocados" value="Metas, cartões e limites fora do que foi listado acima" />
                </>
              )}
            </div>
          </div>

          {isSub ? (
            <div className="rounded-card bg-warning-bg text-warning-text p-6" style={{ boxShadow: "0 0 0 1.5px var(--color-warning)" }}>
              <div className="flex items-center gap-2 mb-2">
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <h3 className="text-card-title">Isso apaga dados</h3>
              </div>
              <p className="text-sm leading-relaxed mb-4">
                {preview.summary.toDelete} registro(s) saem do Norte e entram os do arquivo. Metas, cartões e limites continuam iguais.
              </p>
              <label className="text-eyebrow block mb-1.5">Escreva SUBSTITUIR para liberar</label>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="SUBSTITUIR" className="mb-4 bg-surface" />
              <div className="flex items-center gap-3">
                <Button variant={confirmOk ? "danger" : "secondary"} disabled={!confirmOk || applying} loading={applying} onClick={applyNow}>
                  Substituir {preview.summary.toDelete} registros
                </Button>
                <Button variant="ghost" onClick={() => setStep(2)}>
                  Voltar
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-card bg-ink text-white p-6">
              <h3 className="text-card-title mb-2">Modo {MODES.find((m) => m.key === mode)?.label.toLowerCase()}</h3>
              <p className="text-sm leading-relaxed text-white/70 mb-5">Dá para desfazer nas próximas 24 horas pela Atividade de dados.</p>
              <div className="flex items-center gap-3">
                <Button variant="accent" disabled={unresolvedCount > 0 || applying} loading={applying} onClick={applyNow}>
                  Aplicar importação
                </Button>
                <button onClick={() => setStep(conflicts.length > 0 ? 3 : 2)} className="focus-ring text-sm text-white/70 hover:text-white transition-colors cursor-pointer">
                  Voltar
                </button>
              </div>
              {unresolvedCount > 0 && <p className="text-caption text-white/50 mt-3">Resolva os {unresolvedCount} conflito(s) pendente(s) antes de aplicar.</p>}
            </div>
          )}
        </div>
      )}

      {/* Step 5 — concluído */}
      {step === 5 && result && (
        <div className="relative overflow-hidden rounded-card bg-ink p-10 text-white text-center">
          <div className="pointer-events-none absolute inset-0 bg-accent/10 blur-3xl" aria-hidden="true" />
          <div className="relative">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-ink">
              <Check className="h-7 w-7" aria-hidden="true" strokeWidth={2.5} />
            </div>
            <h3 className="text-xl font-semibold mb-2">Importação concluída</h3>
            <p className="text-sm text-white/70 mb-6">
              {result.counts.created ?? 0} novos · {result.counts.updated ?? 0} corrigidos · {result.counts.skipped ?? 0} ignorados
              {!isSub && ". Dá para desfazer por 24 horas."}
            </p>
            <Button variant="accent" onClick={reset}>
              Importar outro arquivo
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }) {
  return (
    <div>
      <div className="tabular text-xl font-semibold text-text-primary">{value}</div>
      <div className="text-caption text-text-muted">{label}</div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3 first:border-0 first:pt-0">
      <span className="text-text-secondary">{label}</span>
      <span className="font-medium text-text-primary text-right">{value}</span>
    </div>
  );
}
