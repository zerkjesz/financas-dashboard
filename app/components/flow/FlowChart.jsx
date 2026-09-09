"use client";

import { formatMoney, formatDate } from "@/lib/formatMoney";

// Fase 5.4D, itens 37/40/41 — SVG custom (CHART_LIBRARY_DECISION do
// relatório: nenhuma lib instalada — dado é pequeno, poucos eventos num
// horizonte de até 180 dias, e o produto precisa de controle total de
// acessibilidade que uma lib genérica não dá de graça). Só GEOMETRIA de
// plotagem aqui — nenhum valor financeiro é recalculado, tudo já vem pronto
// de /api/cash-flow (lib/financialProjection.js V2, BASE). Zero-line SEMPRE
// visível (item 40); crossing (se houver) ganha marcador + explicação
// textual, nunca só a cor vermelha (item 40, "não depender de vermelho
// somente"). Cada evento é um ponto real do DOM (não só um path SVG) —
// title nativo pra hover desktop + lista textual completa abaixo do
// gráfico, sempre visível, nunca escondida atrás de tooltip só (item 9/41).
//
// Fase 5.4D, item 42 — BUG REAL corrigido (achado ao vivo em 390px): um
// viewBox de 720 de largura, renderizado num container mobile de ~340px
// (`w-full`), escala TUDO (fonte/raio dos pontos/espessura do traço) por
// ~0.47x — o rótulo "R$ 0" (fontSize 10) chegava perto de 5px na tela, bem
// abaixo do mínimo legível (item 42 explícito: "não reduzir fontes a 9px").
// Um viewBox mais próximo da largura real do container em mobile (o caso
// mais estreito) faz o gráfico só ESCALAR PRA CIMA em telas largas — texto
// crescendo é inofensivo, texto encolhendo abaixo do legível não é.
const WIDTH = 360;
const HEIGHT = 176;
const PAD_X = 8;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;

// Fase 5.4D.1, item 41 — eixo/labels: sem ticks, o usuário não conseguia
// ver ONDE no gráfico ficam os 30/60/90 dias que a seção "Como fico" já
// mostra em texto — a trajetória e o resumo numérico pareciam desconectados
// (achado do audit visual, item 34: "enxergar horizonte quase
// instantaneamente"). Ticks fixos por horizonte (mesmos dias dos
// checkpoints já exibidos abaixo — nunca um número novo).
const TICKS_BY_HORIZON = { 7: [0, 7], 30: [0, 15, 30], 60: [0, 30, 60], 90: [0, 30, 60, 90], 180: [0, 60, 120, 180] };

export default function FlowChart({ startingBalance, timeline, horizonDays, projectedBalance }) {
  const points = [
    { day: 0, value: Number(startingBalance), label: "Hoje" },
    ...timeline.map((e) => ({ day: e.daysFromNow, value: Number(e.balanceAfter), event: e })),
  ];
  // Extensão plana até o fim do horizonte — o saldo não muda sem evento novo.
  const lastValue = points[points.length - 1].value;
  if (points[points.length - 1].day < horizonDays) {
    points.push({ day: horizonDays, value: lastValue, extension: true });
  }

  const values = points.map((p) => p.value);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);
  const range = yMax - yMin || 1;
  const yPad = range * 0.12;

  const plotW = WIDTH - PAD_X * 2;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xScale = (day) => PAD_X + (horizonDays > 0 ? (day / horizonDays) * plotW : 0);
  const yScale = (value) => PAD_TOP + plotH - ((value - (yMin - yPad)) / (range + yPad * 2)) * plotH;

  const zeroY = yScale(0);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.day).toFixed(1)} ${yScale(p.value).toFixed(1)}`).join(" ");
  const ticks = TICKS_BY_HORIZON[horizonDays] || [0, horizonDays];
  const axisY = HEIGHT - PAD_BOTTOM + 14;

  // Zero crossing — primeiro segmento onde o sinal muda, interpolado
  // linearmente (geometria pura, não uma projeção nova).
  let crossing = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((a.value >= 0 && b.value < 0) || (a.value < 0 && b.value >= 0)) {
      const t = a.value === b.value ? 0 : (0 - a.value) / (b.value - a.value);
      const day = a.day + t * (b.day - a.day);
      crossing = { day: Math.round(day), x: xScale(day) };
      break;
    }
  }

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`Trajetória de caixa base ao longo de ${horizonDays} dias, começando em ${formatMoney(startingBalance)} e terminando projetada em ${formatMoney(projectedBalance)}`}>
        {/* zero-line — sempre desenhada, o range de y sempre inclui 0. */}
        <line x1={PAD_X} y1={zeroY} x2={WIDTH - PAD_X} y2={zeroY} stroke="var(--color-border-strong)" strokeWidth="1" strokeDasharray="3,3" />
        <text x={WIDTH - PAD_X} y={zeroY - 4} textAnchor="end" fontSize="10" fill="var(--color-text-muted)">
          R$ 0
        </text>

        <path d={pathD} fill="none" stroke="var(--color-restricted)" strokeWidth="2" />

        {crossing && (
          <>
            <line x1={crossing.x} y1={PAD_TOP} x2={crossing.x} y2={HEIGHT - PAD_BOTTOM} stroke="var(--color-danger)" strokeWidth="1" strokeDasharray="2,2" />
            <circle cx={crossing.x} cy={zeroY} r="4" fill="var(--color-danger)" />
          </>
        )}

        {points
          .filter((p) => p.event)
          .map((p, i) => (
            <circle key={i} cx={xScale(p.day)} cy={yScale(p.value)} r="3.5" fill="var(--color-text-primary)" stroke="var(--color-surface-1)" strokeWidth="1.5">
              <title>
                {p.event.label} · {p.event.amount >= 0 ? "+" : "-"}
                {formatMoney(Math.abs(p.event.amount))} · {formatDate(p.event.date)} · saldo após: {formatMoney(p.event.balanceAfter)}
              </title>
            </circle>
          ))}

        {/* Eixo de dias — tick + label, mesmos dias que "Como fico" mostra
            em texto abaixo, então a trajetória e o resumo numérico leem
            como uma coisa só. */}
        {ticks.map((day) => (
          <g key={day}>
            <line x1={xScale(day)} y1={HEIGHT - PAD_BOTTOM} x2={xScale(day)} y2={HEIGHT - PAD_BOTTOM + 4} stroke="var(--color-border-strong)" strokeWidth="1" />
            <text x={xScale(day)} y={axisY} textAnchor={day === 0 ? "start" : day === horizonDays ? "end" : "middle"} fontSize="10" fill="var(--color-text-muted)">
              {day === 0 ? "hoje" : `${day}d`}
            </text>
          </g>
        ))}
      </svg>

      {crossing && (
        <p className="text-caption text-danger mt-2">
          A trajetória base fica negativa por volta do dia {crossing.day} — não é garantia, é o que acontece se nada mudar.
        </p>
      )}
    </div>
  );
}
