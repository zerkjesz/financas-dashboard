"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import PageContainer from "../components/ui/PageContainer.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import CategoryOverview from "../components/history/CategoryOverview.jsx";
import TransactionList from "../components/history/TransactionList.jsx";
import { getFinancialCycleForDate } from "@/lib/financialCycle";
import { categoryTotals, cardPaymentTransfersInCycle, mergeHistoryRows } from "@/lib/historyPresentation";
import { formatDate } from "@/lib/formatMoney";

// Fase 5.4D, item 43 — HISTÓRICO responde "onde meu dinheiro foi e quais
// lançamentos explicam isso?". A tabela que saiu da Home na 5.4C finalmente
// tem dono. Item 44 — default é o CICLO FINANCEIRO atual (nunca all-time);
// item 45 — navegação simples current/previous, sem calendário complexo.
export default function HistoricoPage() {
  const [data, setData] = useState(null); // { entries, financialCycle, accounts }
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cycleOffset, setCycleOffset] = useState(0); // 0 = atual, -1 = anterior, ...
  const [categoryFilter, setCategoryFilter] = useState(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetch("/api/dashboard").then((r) => r.json()), fetch("/api/transfers").then((r) => r.json())]).then(([dash, tr]) => {
      setData({ entries: dash.entries, financialCycle: dash.financialCycle, accounts: dash.accounts });
      setTransfers(tr);
      setLoading(false);
    });
  }, []);

  const vaAccountId = useMemo(() => data?.accounts.find((a) => a.slug === "vale-alimentacao")?.id, [data]);

  // Item 45 — ciclo alvo derivado do ciclo ATUAL (já resolvido no servidor)
  // + cycleOffset, reaproveitando a MESMA função canônica de janela de ciclo
  // (lib/financialCycle.js, pura, sem acesso a banco) — nunca uma segunda
  // conta de "24 pra 23" reimplementada aqui.
  const targetCycle = useMemo(() => {
    if (!data) return null;
    if (cycleOffset === 0) return data.financialCycle;
    const cycleStartDay = new Date(data.financialCycle.start).getUTCDate();
    let anchor = new Date(data.financialCycle.start);
    for (let i = 0; i > cycleOffset; i--) {
      anchor = new Date(anchor.getTime() - 24 * 60 * 60 * 1000); // 1 dia antes do início do ciclo corrente -> dentro do ciclo anterior
      const cycle = getFinancialCycleForDate(anchor, { cycleStartDay });
      anchor = cycle.start;
    }
    return getFinancialCycleForDate(anchor, { cycleStartDay });
  }, [data, cycleOffset]);

  if (loading || !data || !targetCycle) {
    return <DashboardSkeleton />;
  }

  const cycleEntries = data.entries.filter((e) => {
    const d = new Date(e.occurredAt);
    return d >= new Date(targetCycle.start) && d <= new Date(targetCycle.end);
  });
  const cyclePaymentTransfers = cardPaymentTransfersInCycle(transfers, targetCycle.start).filter((t) => new Date(t.occurredAt) <= new Date(targetCycle.end));
  const { list: totals, total } = categoryTotals(cycleEntries);
  const rows = mergeHistoryRows(cycleEntries, cyclePaymentTransfers, vaAccountId).filter((r) => !categoryFilter || r.category === categoryFilter);

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-page-title text-text-primary">Histórico</h1>
          <p className="text-caption text-text-muted">Onde seu dinheiro foi e quais lançamentos explicam isso</p>
        </div>
        {/* Fase 5.4E.1.1 — MEDIDO ao vivo: p-1.5 em volta de um ícone de
            16px dava 28×28px real, bem abaixo de 44px — botões icon-only
            precisam crescer nas DUAS dimensões (min-w + min-h), não só
            altura. `pointer-coarse:` só em touch. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCycleOffset((o) => o - 1)}
            className="focus-ring inline-flex items-center justify-center rounded-control p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-1 cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            aria-label="Ciclo anterior"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="text-caption text-text-muted tabular whitespace-nowrap">
            {formatDate(targetCycle.start)} – {formatDate(targetCycle.end)}
          </span>
          <button
            onClick={() => setCycleOffset((o) => Math.min(0, o + 1))}
            disabled={cycleOffset === 0}
            className="focus-ring inline-flex items-center justify-center rounded-control p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-1 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            aria-label="Próximo ciclo"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="space-y-4">
        <CategoryOverview totals={totals} total={total} selected={categoryFilter} onSelect={setCategoryFilter} />
        <TransactionList rows={rows} categoryFilter={categoryFilter} />
      </div>
    </PageContainer>
  );
}
