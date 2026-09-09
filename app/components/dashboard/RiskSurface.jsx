import { CircleDashed } from "lucide-react";
import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4C.1, item 16 — risco precisa parecer "informação financeira
// incerta", nunca "alerta amarelo de sistema": sem fundo sólido de aviso,
// só a borda tracejada (o único elemento hachurado da Home — reservado
// exclusivamente pra hipótese/incerteza) + um ícone tracejado + a nota
// "não reduz dinheiro livre" como legenda discreta, nunca um Badge chamativo.
export default function RiskSurface({ contingency }) {
  if (!contingency || !contingency.items || contingency.items.length === 0) return null;

  return (
    <div className="rounded-card border border-dashed border-warning/30 bg-surface-1 p-5">
      <div className="flex items-center gap-2 mb-3">
        <CircleDashed className="h-4 w-4 text-warning" aria-hidden="true" />
        <h2 className="text-label text-text-muted">Riscos em aberto — não reduz dinheiro livre</h2>
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
