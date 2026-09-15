import { formatMoney } from "@/lib/formatMoney";

// Fase 6.0 (Design Freeze) — "Onde o dinheiro já está", o gráfico de ponte/
// waterfall da referência aprovada. É um tipo de gráfico proprietário (sem
// biblioteca) — barras posicionadas por `top`/`height` em % de uma escala
// compartilhada, nunca um chart-lib genérico.
//
// TRUTH > PROTOTYPE (item 12 da fase): a última barra ("Sobra livre") é
// SEMPRE `liquidity.freeMoney` — o valor canônico real, nunca recomputado
// aqui. Os passos intermediários (contas do mês / fatura do cartão) são
// derivados dos mesmos campos que o resto do produto já usa
// (`currentObligations`). Se sobrar um resíduo entre "tem na conta − contas
// − fatura" e o freeMoney real (ex.: dinheiro protegido em Reserve, que este
// gráfico simplificado não decompõe), ele aparece como uma barra extra
// "Outros ajustes" — nunca escondido, nunca forçado a fechar em zero.
export default function MoneyBridgeCard({ financial }) {
  const { liquidity, currentObligations } = financial;
  const unrestrictedCash = liquidity.unrestrictedCash;
  const faturaCartao = currentObligations.incurredLiabilities;
  const contasDoMes = Math.max(0, currentObligations.dueBeforeNextIncome - faturaCartao);
  const freeMoney = liquidity.freeMoney;

  const level0 = unrestrictedCash;
  const level1 = level0 - contasDoMes;
  const level2 = level1 - faturaCartao;
  const residual = level2 - freeMoney; // dinheiro protegido/outros ajustes não decompostos aqui

  const steps = [
    { label: "Tem na conta", from: 0, to: level0, tone: "ink" },
    { label: "Contas do mês", from: level0, to: level1, tone: "gray" },
    { label: "Fatura do cartão", from: level1, to: level2, tone: "accent" },
  ];
  if (Math.abs(residual) > 0.005) {
    steps.push({ label: "Outros ajustes", from: level2, to: freeMoney, tone: "gray" });
  }

  const levels = [0, ...steps.map((s) => s.to)];
  const scaleMax = Math.max(0, ...levels);
  const scaleMin = Math.min(0, ...levels);
  const range = scaleMax - scaleMin || 1;
  const pct = (v) => ((scaleMax - v) / range) * 100;

  const TONE_CLASS = { ink: "bg-ink", gray: "bg-gray-1", accent: "bg-accent" };

  return (
    <div className="rounded-card bg-surface shadow-card p-7 flex flex-col">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h2 className="text-card-title text-text-primary">Onde o dinheiro já está</h2>
      </div>
      <p className="text-caption text-text-muted mb-6">até a próxima renda</p>

      <div className="relative flex-1 min-h-[180px]" style={{ marginBottom: "1.5rem" }}>
        {/* linha zero */}
        <div className="absolute left-0 right-0 border-t border-dashed border-border-strong" style={{ top: `${pct(0)}%` }} aria-hidden="true" />

        <div className="absolute inset-0 flex items-stretch gap-3 sm:gap-4">
          {steps.map((step) => {
            const top = Math.min(pct(step.from), pct(step.to));
            const height = Math.abs(pct(step.to) - pct(step.from));
            const value = step.to - step.from;
            return (
              <div key={step.label} className="relative flex-1 min-w-0">
                <div
                  className={`transition-bar absolute left-0 right-0 rounded-lg ${TONE_CLASS[step.tone]}`}
                  style={{ top: `${top}%`, height: `${Math.max(height, 1.5)}%` }}
                  title={`${step.label}: ${formatMoney(value)}`}
                />
                <div className="absolute left-0 right-0 text-center text-[11px] tabular font-medium text-text-secondary whitespace-nowrap" style={{ top: `${Math.max(top - 7, 0)}%` }}>
                  {formatMoney(value)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2 text-[11px] leading-tight text-text-muted" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))` }}>
        {steps.map((step) => (
          <div key={step.label} className="text-center break-words">
            {step.label}
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-baseline justify-between border-t border-border-subtle pt-4">
        <span className="text-caption text-text-secondary max-w-[60%]">Falta isso para o mês fechar no zero</span>
        <span className={`text-metric-md ${freeMoney < 0 ? "text-danger" : "text-text-primary"}`}>{formatMoney(freeMoney)}</span>
      </div>
    </div>
  );
}
