"use client";

import { useState } from "react";
import PageContainer from "../ui/PageContainer.jsx";
import ExportPanel from "./ExportPanel.jsx";
import ImportWizard from "./ImportWizard.jsx";
import ActivityLog from "./ActivityLog.jsx";

const TABS = [
  ["exportar", "Exportar"],
  ["importar", "Importar"],
];

// Fase 6.0 (Design Freeze) — página "Dados". Tabs Exportar/Importar + log
// de atividade sempre visível embaixo (igual à referência aprovada).
export default function DataHubClient() {
  const [tab, setTab] = useState("exportar");
  const [activityKey, setActivityKey] = useState(0);

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center justify-between gap-4 mb-7">
        <div>
          <div className="text-eyebrow text-text-muted mb-1">Dados</div>
          <h1 className="text-page-title text-text-primary mb-1">Seus dados são seus</h1>
          <p className="text-caption text-text-muted max-w-lg">Leve uma cópia completa quando quiser, ou traga dados de fora — sempre conferindo antes de aplicar.</p>
        </div>
        <div className="flex gap-1 rounded-control bg-chip-bg p-1">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`focus-ring rounded-control px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${tab === key ? "bg-ink text-white" : "text-text-secondary hover:bg-surface"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="mb-6">
        {tab === "exportar" ? <ExportPanel /> : <ImportWizard onDone={() => setActivityKey((k) => k + 1)} />}
      </div>

      <ActivityLog refreshKey={activityKey} />
    </PageContainer>
  );
}
