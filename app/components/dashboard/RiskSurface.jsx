import { formatMoney, formatDate } from "@/lib/formatMoney";
import Badge from "../ui/Badge.jsx";

// Fase 5.4C, itens 17/18/46 — CONTINGÊNCIA nunca entra no breakdown do hero
// (nunca reduz freeMoney) e nunca tem a mesma aparência de um compromisso
// confirmado: warning + borda tracejada (Badge variant="risk", ver
// app/components/ui/Badge.jsx), sempre com esperado/máximo/timing juntos —
// "timing desconhecido" é informação mostrada, nunca uma data inventada.
export default function RiskSurface({ contingency }) {
  if (!contingency || !contingency.items || contingency.items.length === 0) return null;

  return (
    <div className="rounded-card border border-dashed border-warning/40 bg-warning/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-section-title text-text-primary">Riscos em aberto</h2>
        <Badge variant="risk">não reduz dinheiro livre</Badge>
      </div>
      <div className="space-y-3">
        {contingency.items.map((item) => (
          <div key={item.id} className="text-sm">
            <div className="text-text-secondary">{item.description}</div>
            <div className="text-caption text-text-muted">
              esperado {item.expectedAmount != null ? formatMoney(item.expectedAmount) : "desconhecido"} · máximo {formatMoney(item.maxAmount)} ·{" "}
              {item.expectedDate ? `previsto ${formatDate(item.expectedDate)}` : "timing desconhecido"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
