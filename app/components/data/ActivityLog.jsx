"use client";

import { useEffect, useState } from "react";
import { Download, Upload, Check, AlertTriangle, Undo2 } from "lucide-react";
import { formatDate } from "@/lib/formatMoney";

const TYPE_META = {
  EXPORT: { icon: Download, label: "Exportação concluída" },
  IMPORT_PREVIEW: { icon: Check, label: "Importação validada" },
  IMPORT_APPLY: { icon: Upload, label: "Importação concluída" },
  IMPORT_FAILED: { icon: AlertTriangle, label: "Arquivo recusado" },
  IMPORT_UNDO: { icon: Undo2, label: "Importação desfeita" },
};

function subLabel(op) {
  if (op.type === "EXPORT") return `${op.createdCount} linha(s)`;
  if (op.type === "IMPORT_PREVIEW") return `${op.datasets?.length ?? 0} aba(s) conferida(s), nada aplicado`;
  if (op.type === "IMPORT_APPLY") return `${op.createdCount} novos · ${op.updatedCount} atualizados · ${op.deletedCount} removidos`;
  if (op.type === "IMPORT_FAILED") return op.errorMessage || "falha ao processar";
  if (op.type === "IMPORT_UNDO") return `${op.createdCount} restaurado(s), ${op.deletedCount} removido(s)`;
  return "";
}

// Fase 6.0 (Design Freeze) — "Atividade de dados". Real, lida de
// /api/data/activity (lib/dataHub/*.js grava cada operação). "Desfazer" só
// aparece pros imports dentro da janela de 24h — nunca uma promessa vazia
// (o design original não tinha esse botão; a cópia da fase promete undo,
// então o botão precisa existir de verdade aqui).
export default function ActivityLog({ refreshKey }) {
  const [data, setData] = useState(null);
  const [undoing, setUndoing] = useState(null);

  function load() {
    fetch("/api/data/activity")
      .then((r) => r.json())
      .then(setData);
  }

  useEffect(load, [refreshKey]);

  async function handleUndo(batchId) {
    setUndoing(batchId);
    await fetch("/api/data/import/undo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchId }) });
    setUndoing(null);
    load();
  }

  if (!data) return null;

  return (
    <div className="rounded-card bg-surface shadow-card p-6">
      <h3 className="text-card-title text-text-primary mb-4">Atividade de dados</h3>
      {data.operations.length === 0 ? (
        <p className="text-body text-text-muted">Nenhuma operação ainda.</p>
      ) : (
        <div className="divide-y divide-border-subtle">
          {data.operations.map((op) => {
            const meta = TYPE_META[op.type] ?? TYPE_META.EXPORT;
            const Icon = meta.icon;
            const tone = op.status === "FAILED" ? "bg-warning-bg text-warning-text" : "bg-chip-bg text-text-secondary";
            const undoable = data.undoable.find((u) => u.id === op.importBatchId);
            return (
              <div key={op.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile ${tone}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-primary">{meta.label}</div>
                  <div className="text-caption text-text-muted truncate">{subLabel(op)}</div>
                </div>
                {undoable && (
                  <button
                    onClick={() => handleUndo(undoable.id)}
                    disabled={undoing === undoable.id}
                    className="focus-ring shrink-0 rounded-control px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-chip-bg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {undoing === undoable.id ? "Desfazendo…" : "Desfazer"}
                  </button>
                )}
                <span className="shrink-0 text-eyebrow text-text-muted">{formatDate(op.createdAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
