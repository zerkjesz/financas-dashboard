"use client";
import { useState } from "react";
import { fmt, fmtS } from "../v4/format.js";
import { Ico5 } from "./Icons5.jsx";
import CardSettingsForm from "../card/CardSettingsForm.jsx";
import PurchaseSimulator from "./PurchaseSimulator.jsx";
import { billSegments, limitSegments, futureRowBars, commitmentChart, chartAlt, reliefHeadline, dmLabel } from "./cartoesView.js";

const KIND_CLASS = { ink: "n5-ink", mid: "n5-mid", hatch: "n5-hatch", track: "n5-track" };
const LEGEND_BG = { ink: "#0B0B0C", mid: "#C6CAD0", hatch: "repeating-linear-gradient(45deg,#C6CAD0 0 2px,#EEF0F2 2px 4px)", track: "#EEF0F2" };

function Legend({ segs }) {
  return (
    <div className="n5-legend">
      {segs.filter((s) => s.value > 0.004).map((s) => (
        <span key={s.key}><i style={{ background: LEGEND_BG[s.kind], boxShadow: s.kind === "track" ? "inset 0 0 0 1px #C6CAD0" : undefined }} />{s.label} {fmt(s.value)}</span>
      ))}
    </div>
  );
}

export function CurrentBillPanel({ bill }) {
  const segs = billSegments(bill);
  const monthName = bill.monthLong;
  return (
    <div className="n5-panel n5-rise" style={{ flex: 1 }}>
      <div className="n5-mono">Fatura de {monthName} · {bill.isClosed ? `fechou ${dmLabel(bill.closesAt)} · vence ${dmLabel(bill.dueAt)}` : `fecha ${dmLabel(bill.closesAt)}`}</div>
      <div className="n5-big">{fmt(bill.total)}</div>
      <div className="n5-seg" role="img" aria-label={`Composição da fatura: ${segs.map((s) => `${s.label} ${fmt(s.value)}`).join(", ")}`}>
        {segs.map((s) => <i key={s.key} className={KIND_CLASS[s.kind]} style={{ width: `${s.pct}%` }} />)}
      </div>
      <Legend segs={segs} />
      {bill.totalSource === "observed" && <div className="n5-note">Valor observado no app do banco{bill.observedAt ? ` em ${dmLabel(bill.observedAt)}` : ""}, mais o que foi lançado depois.</div>}
      {bill.unknownDetail > 0 && <div className="n5-note">{fmt(bill.unknownDetail)} ainda sem detalhamento individual no Norte.</div>}
    </div>
  );
}

export function LimitPanel({ limit, bill }) {
  const segs = limitSegments(limit);
  const futureParcels = Math.max(0, limit.knownCommitted - bill.remaining);
  const obs = limit.bankObservation;
  return (
    <div className="n5-panel tight n5-rise d1">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <div className="n5-h" style={{ fontSize: 16 }}>Limite do cartão</div>
        <div className="n5-sub n5-tab">{fmt(limit.knownCommitted)} comprometidos conhecidos de {fmt(limit.total)}</div>
      </div>
      <div className="n5-limit-bar" role="img" aria-label={`Limite de ${fmt(limit.total)}: ${segs.map((s) => `${s.label} ${fmt(s.value)}`).join(", ")}`}>
        {segs.map((s) => <i key={s.key} className={KIND_CLASS[s.kind]} style={{ width: `${s.pct}%`, background: s.kind === "ink" ? "#0B0B0C" : undefined }} />)}
      </div>
      <Legend segs={segs} />
      <div className="n5-limit-line">
        <span>Fatura atual + <b>{fmt(futureParcels)}</b> de parcelas futuras</span>
        <span>Livre estimado <b>{limit.estimate.low === limit.estimate.high ? fmt(limit.estimate.low) : `${fmt(limit.estimate.low)} a ${fmt(limit.estimate.high)}`}</b></span>
      </div>
      <div className="n5-obs">
        <strong>Disponível no banco: não reconciliado.</strong>{" "}
        {obs ? `Última observação: ${fmt(obs.availableAtObservation)} livres em ${dmLabel(obs.asOf.slice(0, 10))} (há ${obs.daysAgo} ${obs.daysAgo === 1 ? "dia" : "dias"}). ` : "Ainda não há observação do banco. "}
        O Norte só conhece os lançamentos que registrou; o teto do que pode estar livre é {fmt(limit.ceilingAvailable)}.
      </div>
      <div className="n5-note">Limite é o que o banco deixa passar. Não é dinheiro seu, nem quanto seu orçamento aguenta.</div>
    </div>
  );
}

export function ReliefPanel({ relief }) {
  const head = reliefHeadline(relief);
  return (
    <div className="n5-lime n5-rise d2">
      <div className="k">Quando o cartão volta a respirar</div>
      <h2>{head.title}</h2>
      <p>{head.body}</p>
      {relief.hasInstallments && (
        <div className="n5-lime-facts">
          <div><div className="l">Próximo alívio</div><div className="v">{relief.next ? `${relief.next.label.slice(0, 3).toLowerCase()} · +${fmtS(relief.next.released)}` : "—"}</div></div>
          <div><div className="l">Maior alívio</div><div className="v">{relief.biggest ? `${relief.biggest.label.slice(0, 3).toLowerCase()} · +${fmtS(relief.biggest.released)}` : "—"}</div></div>
          <div><div className="l">Zera</div><div className="v">{relief.zero ? relief.zero.label.toLowerCase() : "—"}</div></div>
        </div>
      )}
    </div>
  );
}

export function CommitmentChart({ series, total }) {
  const g = commitmentChart(series, total);
  return (
    <div className="n5-panel n5-rise d2 n5-hide-compact" style={{ padding: "26px 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div className="n5-h">Comprometimento futuro conhecido</div>
        <div className="n5-sub" style={{ fontSize: 12.5, color: "#6e747b" }}>sem compras novas</div>
      </div>
      <div className="n5-chart" role="img" aria-label={chartAlt(series, total)}>
        <svg viewBox="0 0 800 200" preserveAspectRatio="none" aria-hidden="true">
          <path d={g.area} fill="#EEF0F2" />
          <path d={g.line} fill="none" stroke="#0B0B0C" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="top" />
        <div className="toplabel">{fmtS(total)} · limite total</div>
        {g.points.map((p) => (
          <div key={p.label} className="n5-dot" style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.isNow ? 12 : 8, height: p.isNow ? 12 : 8, background: p.isNow ? "#C9FF29" : "#6A7077" }} />
        ))}
      </div>
      <div className="n5-axis" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(0, 1fr))` }}>
        {series.map((p, i) => (
          <div key={p.label}><div className="m" style={{ color: i === 0 ? "#0B0B0C" : undefined }}>{p.label}</div><div className="v">{fmtS(p.committed)}</div></div>
        ))}
      </div>
      <div className="n5-note" style={{ fontSize: 12 }}>Cada ponto é quanto do limite o Norte sabe estar comprometido depois de pagar a fatura daquele mês. O limite livre real depende do banco.</div>
    </div>
  );
}

export function FutureBills({ rows }) {
  const scale = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="n5-panel n5-rise d3 n5-body">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="n5-h">{rows.length > 0 ? "Futuro das faturas" : "Faturas"}</div>
        <div className="n5-sub n5-hide-compact">O que já está carimbado em cada fatura pelas parcelas em andamento.</div>
      </div>
      <div style={{ marginTop: 14 }}>
        {rows.map((r) => {
          const b = futureRowBars(r, scale);
          return (
            <div key={r.cycleMonth} className={`n5-frow ${r.isCurrent ? "cur" : ""}`}>
              <div className="mm"><div className="m">{r.label}</div><div className="t">{r.tag}</div></div>
              <div className="bar" role="img" aria-label={`${r.label}: parcelas ${fmt(r.installmentAmount)}, compras ${fmt(r.purchasesAmount)}, sem detalhamento ${fmt(r.unknownDetailAmount)}`}>
                <i className="n5-ink" style={{ width: `${b.wInst}%` }} />
                <i className="n5-mid" style={{ width: `${b.wPur}%` }} />
                <i className="n5-hatch" style={{ width: `${b.wUnk}%` }} />
              </div>
              <div className={`val ${r.total > 0 ? "" : "zero"}`}>{r.total > 0 ? fmt(r.total) : "R$ 0"}</div>
              <div className="tags">
                {r.releasedVsPrevious > 0.01 && <span className="n5-badge"><Ico5 name="down" />libera {fmtS(r.releasedVsPrevious)}/mês</span>}
                {r.installmentsEnding.length > 0 && <span className="n5-tagtext">Última de {r.installmentsEnding.join(", ")}</span>}
                {r.note && <span className="n5-tagtext">{r.note}</span>}
                {r.total <= 0 && !r.isCurrent && <span className="n5-tagtext">Nenhuma parcela</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="n5-note">Mostra só o que o Norte conhece: parcelas cadastradas e compras já lançadas. Compras futuras e parcelas não cadastradas não aparecem aqui.</div>
    </div>
  );
}

export function ActiveInstallments({ installments, summary }) {
  return (
    <div className="n5-panel tight n5-rise d5 n5-body">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="n5-h">Parcelamentos no Itaú</div>
        <div className="n5-sub" style={{ fontSize: 12.5, color: "#6e747b" }}>{summary.activeCount > 0 ? `${fmt(summary.remainingTotal)} ainda por vir` : "nenhum em andamento"}</div>
      </div>
      {installments.length === 0 ? (
        <div className="n5-empty">Nenhuma compra parcelada em andamento no Itaú.</div>
      ) : (
        <div className="n5-plist">
          {installments.map((p) => (
            <div key={p.id} className="n5-pcard" title={p.rawDescription}>
              <div className="name">{p.name}</div>
              <div className="plan">{p.installmentCount}x de {fmt(p.installmentValue)}</div>
              <div className="segs" role="img" aria-label={`Parcela ${p.currentNumber} de ${p.installmentCount}`}>
                {Array.from({ length: Math.min(p.installmentCount, 36) }, (_, k) => (
                  <i key={k} style={{ background: k + 1 < p.currentNumber ? "#0B0B0C" : k + 1 === p.currentNumber ? "#C9FF29" : "#E4E7EA" }} />
                ))}
              </div>
              <div className="meta"><span style={{ color: "#565c63" }}>Parcela {p.currentNumber}/{p.installmentCount}</span><span className="n5-nowrap">Termina em {p.endLabel}</span></div>
              <div className="rest">{p.remainingAmount > 0 ? `Faltam ${fmt(p.remainingAmount)}` : "Última parcela"}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ItauBody({ itau, onSettingsSaved }) {
  const [saving, setSaving] = useState(null);
  async function save(form) {
    setSaving("saving");
    try {
      const res = await fetch(`/api/cards/${itau.card.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ totalLimit: parseFloat(form.totalLimit), closingDay: form.closingDay ? parseInt(form.closingDay, 10) : null, dueDay: parseInt(form.dueDay, 10) }) });
      if (!res.ok) throw new Error("http " + res.status);
      setSaving(null);
      onSettingsSaved?.();
    } catch {
      setSaving("error");
    }
  }
  return (
    <>
      <div className="n5-grid2" style={{ marginTop: 16 }}>
        <ReliefPanel relief={itau.relief} />
        <CommitmentChart series={itau.commitmentSeries} total={itau.limit.total} />
      </div>
      <div className="n5-flow">
        <FutureBills rows={itau.futureBills} />
        <div className="n5-o-sim"><PurchaseSimulator itau={itau} /></div>
        <div className="n5-o-inst"><ActiveInstallments installments={itau.installments} summary={itau.installmentsSummary} /></div>
      </div>
      <div className="n5-adjust">
        <CardSettingsForm card={itau.card} onSave={save} />
        {saving === "error" && <div className="n5-note" role="alert">Não consegui salvar os ajustes do cartão. Tente de novo.</div>}
      </div>
    </>
  );
}
