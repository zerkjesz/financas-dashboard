"use client";

import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — RESTYLE + composição nova: "Quando o cartão
// alivia" — barras horizontais (fatura atual + próximas conhecidas), em vez
// do rail + Disclosure "ver todas" antigo. cycleMonth/totalAmount/dueAt/
// status continuam vindo 100% do mesmo array de /api/cards/[id]/bills (via
// groupBillsByCycle em page.js) — nenhum valor novo é calculado, só
// reapresentado como barra.
//
// Judgment call: `later` (de groupBillsByCycle) mistura ciclos futuros que
// sobraram do "next" com ciclos PASSADOS (faturas já fechadas/pagas,
// mostradas antes atrás do "ver todas as faturas"). Um runoff "quando
// alivia" é necessariamente prospectivo — faturas passadas não aliviam
// nada — então só as futuras (cycleMonth > current.cycleMonth) entram
// aqui. Efeito colateral real: esta página deixa de expor o histórico de
// faturas passadas que o "ver todas" antigo mostrava (ver relatório final).
function formatCycleLabel(cycleMonth) {
  const [year, month] = cycleMonth.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1))
    .toLocaleDateString("pt-BR", { month: "short", year: "2-digit", timeZone: "UTC" })
    .replace(".", "");
}

function formatDeltaPct(amount, previousAmount) {
  if (!previousAmount) return null;
  const pct = ((amount - previousAmount) / previousAmount) * 100;
  if (Math.abs(pct) < 1) return null;
  const rounded = Math.round(pct);
  const sign = rounded < 0 ? "−" : "+";
  return `${sign}${Math.abs(rounded)}%`;
}

const TONE_BY_INDEX = ["bg-ink", "bg-gray-1", "bg-gray-2", "bg-gray-3"];

export default function CardBillTimeline({ current, next, later }) {
  const futureLater = (later || []).filter((b) => !current || b.cycleMonth > current.cycleMonth);
  const all = [current, ...(next || []), ...futureLater].filter(Boolean);
  if (all.length === 0) return null;

  const max = Math.max(...all.map((b) => Number(b.totalAmount)), 1);

  return (
    <div className="rounded-card bg-surface shadow-card p-5 sm:p-7">
      <h2 className="text-card-title text-text-primary mb-1">Quando o cartão alivia</h2>
      <p className="text-caption text-text-muted mb-5">Uma barra por fatura conhecida, da atual em diante.</p>

      <div className="flex items-end gap-3 overflow-x-auto pb-1">
        {all.map((bill, i) => {
          const amount = Number(bill.totalAmount);
          const heightPct = Math.max((amount / max) * 100, 10);
          const tone = TONE_BY_INDEX[Math.min(i, TONE_BY_INDEX.length - 1)];
          const isDark = tone === "bg-ink";
          const delta = i > 0 ? formatDeltaPct(amount, Number(all[i - 1].totalAmount)) : null;

          return (
            <div key={bill.cycleMonth} className="flex w-24 shrink-0 flex-col items-center gap-1.5">
              <span className="tabular h-4 text-xs font-medium text-text-muted">{delta || ""}</span>
              <div className="flex h-40 w-full items-end">
                <div
                  className={`transition-bar flex w-full flex-col items-center justify-start gap-1 rounded-t-control px-1.5 pt-2 ${tone}`}
                  style={{ height: `${heightPct}%`, minHeight: "64px" }}
                  role="img"
                  aria-label={`${formatCycleLabel(bill.cycleMonth)}: ${formatMoney(amount)}`}
                >
                  <span className={`text-caption font-medium ${isDark ? "text-white/70" : "text-text-secondary"}`}>{formatCycleLabel(bill.cycleMonth)}</span>
                  <span className={`tabular text-center text-xs font-semibold leading-tight ${isDark ? "text-white" : "text-text-primary"}`}>{formatMoney(amount)}</span>
                </div>
              </div>
              <span className="text-caption text-text-muted text-center leading-tight">vence {formatDate(bill.dueAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
