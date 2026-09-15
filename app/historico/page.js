"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import PageContainer from "../components/ui/PageContainer.jsx";
import Input from "../components/ui/Input.jsx";
import { DashboardSkeleton } from "../components/Skeleton.jsx";
import TransactionList from "../components/history/TransactionList.jsx";
import { getFinancialCycleForDate } from "@/lib/financialCycle";
import { cardPaymentTransfersInCycle, mergeHistoryRows } from "@/lib/historyPresentation";
import { formatDate } from "@/lib/formatMoney";

// Fase 5.4D, item 43 — HISTÓRICO responde "onde meu dinheiro foi e quais
// lançamentos explicam isso?". Item 44 — default é o CICLO FINANCEIRO atual
// (nunca all-time); item 45 — navegação simples current/previous, sem
// calendário complexo.
//
// Fase 6.0 (restyle) — CategoryOverview (bars por categoria) deixou de ser
// renderizado nesta página: o design aprovado ("Norte design system launch")
// não tem nenhum gráfico no Histórico, só busca + filtros + lista agrupada
// por dia. O componente (app/components/history/CategoryOverview.jsx) foi
// deixado intacto/sem uso — não apagado — caso volte a ser útil em outro
// lugar. O filtro por categoria clicável que ele oferecia foi substituído
// pelos chips Tudo/Cartão/Débito/Entradas abaixo.
const FILTERS = [
  { key: "all", label: "Tudo" },
  { key: "card", label: "Cartão" },
  { key: "debit", label: "Débito" },
  { key: "income", label: "Entradas" },
];

export default function HistoricoPage() {
  const [data, setData] = useState(null); // { entries, financialCycle, accounts }
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cycleOffset, setCycleOffset] = useState(0); // 0 = atual, -1 = anterior, ...
  const [activeFilter, setActiveFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

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

  // Chips filtram sobre campos REAIS já presentes em `entries` (ver
  // app/api/dashboard/route.js): cardId/accountId só existem em expenses.
  // Judgment call de UI (não é regra financeira nova):
  //   - "Cartão"   = despesa com cardId setado, + a transferência de
  //                  pagamento de fatura (ela É o cartão sendo pago).
  //   - "Débito"   = despesa sem cardId (saiu direto de conta/pix/dinheiro).
  //   - "Entradas" = type === "income".
  // Filtra ANTES de mergeHistoryRows (em vez de tentar filtrar a lista já
  // mesclada) porque cardId/accountId só existem nas entries cruas — a
  // linha mesclada não carrega esses campos.
  const filteredEntries = cycleEntries.filter((e) => {
    if (activeFilter === "income") return e.type === "income";
    if (activeFilter === "card") return e.type === "expense" && e.cardId != null;
    if (activeFilter === "debit") return e.type === "expense" && e.cardId == null;
    return true;
  });
  const filteredTransfers = activeFilter === "all" || activeFilter === "card" ? cyclePaymentTransfers : [];

  const rows = mergeHistoryRows(filteredEntries, filteredTransfers, vaAccountId);

  // Busca: filtro de UI simples sobre a lista já mesclada (dado real já
  // buscado) — não é uma regra financeira nova, só substring case-insensitive
  // sobre descrição/categoria/origem/valor.
  const searchNormalized = searchTerm.trim().toLowerCase();
  const visibleRows = searchNormalized
    ? rows.filter((r) => `${r.description} ${r.category || ""} ${r.origin || ""} ${r.amount}`.toLowerCase().includes(searchNormalized))
    : rows;

  return (
    <PageContainer>
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <p className="text-eyebrow text-text-muted mb-1.5">Histórico</p>
          <h1 className="text-page-title text-text-primary">Tudo que passou</h1>
        </div>
        {/* Navegação de ciclo (real, preservada) — restilizada nos novos tokens. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCycleOffset((o) => o - 1)}
            className="focus-ring inline-flex items-center justify-center rounded-control p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-3 cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            aria-label="Ciclo anterior"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="text-eyebrow text-text-muted tabular whitespace-nowrap">
            {formatDate(targetCycle.start)} – {formatDate(targetCycle.end)}
          </span>
          <button
            onClick={() => setCycleOffset((o) => Math.min(0, o + 1))}
            disabled={cycleOffset === 0}
            className="focus-ring inline-flex items-center justify-center rounded-control p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            aria-label="Próximo ciclo"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <Input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar lugar, categoria ou valor"
            aria-label="Buscar transações"
            className="pl-9"
          />
        </div>
        {/* Chips: em telas estreitas quebram pra segunda linha (flex-wrap) em
            vez de sumir — mantém a capacidade real de filtrar no mobile. */}
        <div className="flex flex-wrap gap-1 rounded-control bg-chip-bg p-1">
          {FILTERS.map((f) => {
            const isActive = activeFilter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                aria-pressed={isActive}
                className={`focus-ring rounded-control px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer pointer-coarse:min-h-11 ${
                  isActive ? "bg-ink text-white" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <TransactionList rows={visibleRows} />
    </PageContainer>
  );
}
