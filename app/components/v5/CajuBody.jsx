"use client";
import { fmt, fmtS } from "../v4/format.js";
import { Ico5 } from "./Icons5.jsx";
import Slider from "./Slider.jsx";
import { weekendPlan } from "../../../lib/vaPacing.js";
import { MODES, cajuRateFor, dayBars, ratioOf, dayMonthUpper } from "./cartoesView.js";

// Fase 10 — CAJU (VA): saldo real do ledger, ritmo até a próxima recarga, planejador de fim de semana (simulação,
// zero escrita), ciclo, últimas compras. Sem fatura, dívida, parcelamento nem limite de crédito.
const money0 = (n) => `R$ ${Math.round(n).toLocaleString("pt-BR")}`;
const rate = (n) => `R$ ${Number(n).toFixed(2).replace(".", ",")}`;

function stateMessage(caju) {
  const r = caju.recharge;
  if (!r) return "Nenhuma recarga configurada para o Caju. Sem ela não dá para calcular o ritmo.";
  if (r.state === "DUE_TODAY") return "A recarga de hoje ainda não caiu. Quando cair, o ritmo é recalculado.";
  if (r.state === "LATE") return `A recarga de ${r.nextLabel} ainda não caiu. O ritmo volta quando ela for lançada.`;
  if (caju.balance <= 0) return "Sem saldo agora. O ritmo volta quando a recarga cair.";
  return null;
}

export function BalanceHero({ caju, mode, onMode, weekendReserve }) {
  const msg = stateMessage(caju);
  const r = caju.recharge;
  const cur = cajuRateFor({ caju, mode, weekendReserve });
  const desc = MODES.find((m) => m.key === mode) && cur.desc;
  const pace = caju.pace;
  return (
    <div className="n5-panel n5-rise" style={{ display: "flex", flexDirection: "column" }}>
      <div className="n5-mono">Saldo para comer</div>
      <div className="n5-big">{fmt(caju.balance)}</div>
      <div className="n5-sub" style={{ fontSize: 13.5, marginTop: 4 }}>Só vale em mercado, restaurante e padaria. Fica fora do seu dinheiro livre.</div>
      <div className="n5-pace">
        <div className="n5-mono">{r?.nextLabel ? `Ritmo para durar até ${r.nextLabel}` : "Ritmo até a próxima recarga"}</div>
        {msg ? (
          <div className="n5-empty" role="status">{msg}</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
              <div className="n5-rate" aria-live="polite">{cur.daily != null ? rate(cur.daily) : "—"}<small>/dia</small></div>
              <div className="n5-sub" style={{ fontSize: 13 }}>{cur.note}</div>
            </div>
            <div className="n5-modes" role="radiogroup" aria-label="Modo do ritmo">
              {MODES.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className="n5-mode" onClick={() => onMode(m.key)} disabled={m.key === "wk" && !caju.weekend?.available} style={m.key === "wk" && !caju.weekend?.available ? { opacity: 0.5, cursor: "not-allowed" } : undefined}>
                  <span className="n5-hide-compact">{m.label}</span><span className="n5-only-compact">{m.short}</span>
                </button>
              ))}
            </div>
            <div className="n5-sub" style={{ fontSize: 12.5, marginTop: 10 }}>{desc}</div>
          </>
        )}
      </div>
      {pace.soFar != null && pace.sustainable != null && !msg && (
        <div style={{ marginTop: "auto", paddingTop: 18 }}>
          <span className="n5-chip-ok"><Ico5 name="check" /><span>{pace.soFar <= pace.sustainable ? "Abaixo" : "Acima"} do ritmo: {money0(pace.soFar)}/dia até agora</span></span>
        </div>
      )}
    </div>
  );
}

export function CyclePanel({ caju }) {
  const c = caju.cycle;
  const r = caju.recharge;
  if (!c || !r) return null;
  const bars = dayBars(c);
  const cs = caju.cycleSummary;
  const availableInCycle = (cs.carryOver ?? 0) + cs.recharges + cs.otherCredits;
  const balancePct = availableInCycle > 0 ? Math.max(0, Math.min(100, (caju.balance / availableInCycle) * 100)) : null;
  const ahead = balancePct != null && c.timePctAhead != null && balancePct >= c.timePctAhead;
  const p = caju.pace;
  let callout = null;
  if (p.projectedLeftover != null) {
    callout = p.projectedLeftover >= 0
      ? <>{ahead ? "O saldo está um pouco à frente do tempo. " : "O saldo acompanha o tempo do ciclo. "}Nesse ritmo, sobram cerca de <strong style={{ fontWeight: 600 }}>{money0(p.projectedLeftover)}</strong> quando a recarga cair.</>
      : <>Nesse ritmo, o saldo dura cerca de <strong style={{ fontWeight: 600 }}>{p.runsOutInDays} dias</strong>, menos que o tempo até a recarga.</>;
  }
  return (
    <div className="n5-panel n5-rise d1 n5-body">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="n5-h">Até a próxima recarga</div>
        <div className="n5-sub">Dia {c.elapsed} de {c.length} · {c.daysLeft === 1 ? "falta 1 dia" : `faltam ${c.daysLeft} dias`}</div>
      </div>
      <div style={{ marginTop: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6e747b", marginBottom: 8 }}><span>Tempo do ciclo</span><span>{c.timePctAhead}% pela frente</span></div>
        <div className="n5-days" role="img" aria-label={`Ciclo de ${c.length} dias: ${c.elapsed} já passaram, hoje é o dia ${c.elapsed + 1}`}>
          {bars.map((b) => <i key={b.key} className={b.state === "past" ? "past" : b.state === "today" ? "today" : ""} />)}
        </div>
        {balancePct != null && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6e747b", margin: "18px 0 8px" }}><span>Saldo do ciclo</span><span>{Math.round(balancePct)}% ainda disponível</span></div>
            <div className="n5-bar10" role="img" aria-label={`${Math.round(balancePct)}% do saldo do ciclo ainda disponível`}><i style={{ width: `${balancePct}%` }} /></div>
          </>
        )}
        <div className="n5-tri">
          <div><div className="d">{dayMonthUpper(r.lastDate)}</div><div className="l">Última recarga</div></div>
          <div style={{ textAlign: "center" }}><div className="d" style={{ color: "#0B0B0C", fontWeight: 500 }}>{c.todayLabel} · HOJE</div><div className="l">{p.soFar != null ? `${money0(p.soFar)}/dia até agora` : "ritmo em formação"}</div></div>
          <div style={{ textAlign: "right" }}><div className="d">{dayMonthUpper(r.nextDate)}</div><div className="l">Próxima recarga</div></div>
        </div>
      </div>
      {callout && <div className="n5-callout" role="note">{callout}</div>}
    </div>
  );
}

export function WeekendPlanner({ caju, reserve, onReserve }) {
  const w = caju.weekend;
  if (!w || !w.available || !w.slider) {
    return (
      <div className="n5-dark n5-rise d2">
        <div className="n5-mono" style={{ color: "rgba(255,255,255,0.66)" }}>Próximo fim de semana</div>
        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.75)", marginTop: 12, lineHeight: 1.5 }}>O próximo fim de semana cai depois da recarga, então não entra no planejamento deste ciclo.</div>
      </div>
    );
  }
  const plan = weekendPlan({ balance: caju.balance, daysLeft: caju.pacing.daysLeft, weekendDays: w.weekendDays, reserve });
  const s = w.slider;
  const days = w.weekendDays === 2 ? `${w.satLabel.slice(0, 2)} e ${w.sunLabel.slice(0, 2)}` : w.satLabel;
  const [dd, mm] = w.satLabel.split("/");
  const MON = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const title = `${Number(dd)}${w.weekendDays === 2 ? ` e ${Number(w.sunLabel.split("/")[0])}` : ""} ${MON[Number(mm) - 1]}`;
  return (
    <div className="n5-dark n5-rise d2 n5-wk">
      <div className="n5-mono" style={{ color: "rgba(255,255,255,0.66)" }}>Próximo fim de semana · {title}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <div className="n5-rate" style={{ fontWeight: 400, color: "#fff" }} aria-live="polite">{fmt(plan.reserve)}</div>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,0.7)" }}>separados para {w.weekendDays === 2 ? "sábado e domingo" : "o fim de semana"}</div>
      </div>
      <Slider value={reserve} min={s.min} max={s.max} step={s.step} onChange={onReserve} label="Reserva do fim de semana" valueText={fmt(reserve)} render={() => (
        <>
          <div className="track"><div className="fill" style={{ width: `${ratioOf(reserve, s.min, s.max) * 100}%` }} /><div className="thumb" style={{ left: `${ratioOf(reserve, s.min, s.max) * 100}%` }} /></div>
          <div className="scale"><span>R$ 0</span><span>{fmtS(s.max)}</span></div>
        </>
      )} />
      <div className="n5-wkgrid">
        <div><div className="l">Nos outros {plan.restDays} dias</div><div className="v">{plan.restDaily != null ? `${rate(plan.restDaily)}/dia` : "—"}</div></div>
        <div><div className="l">Peso no saldo</div><div className="v">{plan.shareOfBalance}%</div></div>
      </div>
      <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.62)", marginTop: 14 }}>Um fim de semana normal custa ~{money0(s.normalWeekend)} ({w.weekendDays} {w.weekendDays === 1 ? "dia" : "dias"} no ritmo). Isto é só uma simulação: nada é gravado.</div>
    </div>
  );
}

export function CycleSummary({ caju }) {
  const cs = caju.cycleSummary;
  const lines = [];
  if (cs.carryOver != null) lines.push({ op: "", label: "Sobrou do ciclo anterior", value: fmt(cs.carryOver) });
  lines.push({ op: "+", label: "Recargas do ciclo", value: fmt(cs.recharges) });
  if (cs.otherCredits > 0.004) lines.push({ op: "+", label: "Outros créditos", value: fmt(cs.otherCredits) });
  lines.push({ op: "−", label: "Gasto até agora", value: fmt(cs.spent) });
  return (
    <div className="n5-panel tight n5-rise d3">
      <div className="n5-h">Este ciclo</div>
      <div style={{ marginTop: 10 }}>
        {lines.map((l) => <div key={l.label} className="n5-line"><div className="l"><span className="op">{l.op}</span><span>{l.label}</span></div><span className="v">{l.value}</span></div>)}
        <div className="n5-line total"><div className="l"><span className="op">=</span><span>Saldo agora</span></div><span className="v">{fmt(cs.balanceNow)}</span></div>
      </div>
      {cs.nextRechargeAmount != null && (
        <div className="n5-nextrec">
          <div><div style={{ fontSize: 13.5 }}>Próxima recarga</div><div style={{ fontSize: 12, color: "#6e747b" }}>{caju.recharge?.nextDate ? `${Number(caju.recharge.nextDate.slice(8, 10))} de ${["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][Number(caju.recharge.nextDate.slice(5, 7)) - 1]}` : ""} · ainda não é saldo</div></div>
          <div className="n5-tab n5-nowrap" style={{ fontSize: 16, color: "#565c63" }}>+{fmt(cs.nextRechargeAmount)}</div>
        </div>
      )}
    </div>
  );
}

export function RecentMoves({ moves }) {
  return (
    <div className="n5-panel tight n5-rise d4">
      <div className="n5-h" style={{ marginBottom: 6 }}>Últimas compras no Caju</div>
      {moves.length === 0 ? <div className="n5-empty">Nenhuma movimentação no Caju ainda.</div> : moves.map((m, i) => (
        <div className="n5-move" key={i}>
          <div className="d">{m.date}</div>
          <div style={{ minWidth: 0 }}><div className="n">{m.name}</div><div className="s">{m.sub}</div></div>
          <div className={`a ${m.amount > 0 ? "in" : ""}`}>{m.amount > 0 ? "+" : "−"}{fmt(m.amount)}</div>
        </div>
      ))}
    </div>
  );
}

export function Insights({ items }) {
  return (
    <div className="n5-panel tight n5-rise d5 n5-hide-compact">
      <div className="n5-h" style={{ marginBottom: 6 }}>Em números</div>
      {items.length === 0 ? <div className="n5-empty">Ainda não há movimentos suficientes neste ciclo.</div> : items.map((it, i) => (
        <div className="n5-insight" key={i}><div className="b">{it.big}</div><div className="t">{it.txt}</div></div>
      ))}
    </div>
  );
}

export default function CajuBody({ caju, reserve, onReserve }) {
  return (
    <div>
      <CyclePanel caju={caju} />
      <div className="n5-grid2" style={{ alignItems: "stretch" }}>
        <WeekendPlanner caju={caju} reserve={reserve} onReserve={onReserve} />
        <CycleSummary caju={caju} />
      </div>
      <div className="n5-grid2 start">
        <RecentMoves moves={caju.recentMoves} />
        <Insights items={caju.insights} />
      </div>
    </div>
  );
}
