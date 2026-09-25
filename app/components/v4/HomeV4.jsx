"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "./v4.css";
import { Ico } from "./Icons.jsx";
import AddForm from "../AddForm.jsx";
import { fmt, fmtS, signed, plural } from "./format.js";

// Fase 9.1 — HOME v4. Consome /api/home (read-model real, somente leitura). Nada hardcoded: nem nome,
// nem mês, nem dias até a renda, nem valores. Hero: na conta − comprometido = livre → seguro.
const PART_TONES = ["#6A7077", "#858B92", "#9AA0A6"];
const noPrefix = (n) => fmt(n).replace("R$ ", "");

function heroSubs(h) {
  const cashSub = h.cashParts.length ? h.cashParts.map((p) => `${p.name} ${noPrefix(p.balance)}`).join(" + ") : "sem saldo em conta";
  const shown = h.committedParts.slice(0, 3).map((p) => `${p.short} ${noPrefix(p.amount)}`);
  const more = h.committedParts.length - 3;
  const commSub = h.committedParts.length ? shown.join(" + ") + (more > 0 ? ` + ${more} ${plural(more, "outro", "outros")}` : "") : "nada comprometido agora";
  return { cashSub, commSub, freeSub: h.protectedMoney > 0 ? `depois de ${fmt(h.protectedMoney)} reservados` : "sem destino marcado", safeSub: h.safetyReserve > 0 ? `guardando ${fmt(h.safetyReserve)} de folga` : "sem folga de segurança" };
}

function barSegments(h) {
  if (!(h.cash > 0)) return { segs: [], legend: [] };
  const pct = (n) => Math.max(0, (n / h.cash) * 100);
  const segs = [];
  const legend = [];
  if (h.safe > 0) { segs.push({ w: pct(h.safe), bg: "#C9FF29" }); legend.push({ label: "Seguro", bg: "#C9FF29" }); }
  if (h.safetyReserve > 0) { segs.push({ w: pct(h.safetyReserve), bg: "rgba(201,255,41,0.38)" }); legend.push({ label: "Folga", bg: "rgba(201,255,41,0.38)" }); }
  let tone = 0;
  h.committedParts.forEach((p) => {
    if (p.funded) { segs.push({ w: pct(p.amount), hatch: true }); legend.push({ label: `${p.short}, separado`, hatch: true }); }
    else { const bg = PART_TONES[tone++ % PART_TONES.length]; segs.push({ w: pct(p.amount), bg }); legend.push({ label: p.label, bg }); }
  });
  const total = segs.reduce((a, s) => a + s.w, 0);
  if (total > 100) segs.forEach((s) => (s.w = (s.w / total) * 100)); // comprometido acima do caixa: normaliza, nunca estoura
  return { segs, legend };
}

export default function HomeV4() {
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addData, setAddData] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/home", { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      setM(await res.json());
      setError(null);
    } catch {
      setError("Não consegui carregar a Home. Tente de novo.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openAdd() {
    setShowAdd(true);
    if (!addData) {
      try {
        const [a, c] = await Promise.all([fetch("/api/accounts").then((r) => r.json()), fetch("/api/cards").then((r) => r.json())]);
        setAddData({ accounts: a, cards: c });
      } catch {
        setShowAdd(false);
      }
    }
  }

  if (error && !m) return <div className="n4" role="alert" style={{ padding: "60px 4px" }}><div className="n4-card" style={{ textAlign: "center" }}><div className="n4-card-title">{error}</div><button type="button" className="n4-ink-btn" style={{ marginTop: 16 }} onClick={load}>Tentar de novo</button></div></div>;
  if (!m) return <div className="n4" aria-busy="true" style={{ minHeight: 500 }}><div className="n4-head"><div><div className="n4-eyebrow">&nbsp;</div><div className="n4-title">&nbsp;</div></div></div></div>;

  const h = m.hero;
  const subs = heroSubs(h);
  const bar = barSegments(h);
  const quick = [
    { label: "Lançar", short: "Lançar", icon: "plus", onClick: openAdd },
    { label: "Pagar compromisso", short: "Pagar", icon: "check", href: "/compromissos?tab=mes", primary: true },
    { label: "Simular compra", short: "Simular", icon: "sim", href: "/simulador" },
    { label: "Ver contas", short: "Contas", icon: "house", href: "/compromissos?tab=casa" },
  ];
  const QBtn = ({ q, compact }) => {
    const inner = (<><Ico name={q.icon} size={compact ? 18 : 15} stroke={q.primary ? "#C9FF29" : "#0B0B0C"} width={compact ? 1.7 : 1.8} /><span>{compact ? q.short : q.label}</span></>);
    const cls = `n4-qbtn ${q.primary ? "is-primary" : ""}`;
    return q.href ? <Link href={q.href} className={cls}>{inner}</Link> : <button type="button" onClick={q.onClick} className={cls}>{inner}</button>;
  };

  return (
    <div className="n4">
      <div className="n4-rise">
        <header className="n4-head">
          <div>
            <div className="n4-eyebrow"><span className="n4-hide-compact">{m.dateLabel}</span><span className="n4-only-compact">{m.dateLabelShort}</span></div>
            <h1 className="n4-title" style={{ margin: 0, marginTop: 8 }}>{m.greeting}.</h1>
          </div>
          <div className="n4-quick">{quick.map((q) => <QBtn key={q.label} q={q} />)}</div>
        </header>

        {showAdd && (
          <div style={{ marginBottom: 16 }}>
            {addData ? <AddForm accounts={addData.accounts} cards={addData.cards} onSubmitted={() => { setShowAdd(false); load(); }} onCancel={() => setShowAdd(false)} /> : <div className="n4-card"><div className="n4-empty">Carregando…</div></div>}
          </div>
        )}

        {/* ============ HERO ============ */}
        <section className="n4-hero" aria-label="Situação financeira">
          <div className="n4-hero-top">
            <div>
              <div className="n4-status"><i aria-hidden="true" /><span>{h.statusLabel}</span></div>
              <div className="n4-headline">{h.headline}</div>
            </div>
            <div>
              <div className="n4-mono n4-hero-label" style={{ fontSize: 10.5, letterSpacing: "0.15em" }}>{h.nextIncomeLabel ? `Seguro para gastar até ${h.nextIncomeLabel}` : "Seguro para gastar"}</div>
              <div className="n4-bignum">{fmt(h.safe)}</div>
              {h.perDay != null && h.daysLeft != null && (
                <div className="n4-perday">
                  <b>≈ {fmtS(h.perDay)} por dia</b>
                  <span>por {h.daysLeft} {plural(h.daysLeft, "dia", "dias")}. É o total do período, não de hoje.</span>
                </div>
              )}
            </div>
          </div>

          {/* desktop: na conta − comprometido = livre → seguro */}
          <div className="n4-eq">
            <div className="n4-eq-grid" role="group" aria-label="Como chegamos no seguro para gastar">
              <div><div className="n4-mono n4-hero-label">Na conta</div><div className="n4-eq-val">{fmt(h.cash)}</div><div className="n4-eq-sub">{subs.cashSub}</div></div>
              <div className="n4-eq-op" aria-hidden="true">−</div>
              <div><div className="n4-mono n4-hero-label">Comprometido</div><div className="n4-eq-val">{fmt(h.committed)}</div><div className="n4-eq-sub">{subs.commSub}</div></div>
              <div className="n4-eq-op" aria-hidden="true">=</div>
              <div><div className="n4-mono n4-hero-label">Livre</div><div className="n4-eq-val">{fmt(h.free)}</div><div className="n4-eq-sub">{subs.freeSub}</div></div>
              <div className="n4-eq-op" aria-hidden="true">→</div>
              <div><div className="n4-mono" style={{ color: "#C9FF29" }}>Seguro</div><div className="n4-eq-val" style={{ color: "#C9FF29" }}>{fmt(h.safe)}</div><div className="n4-eq-sub">{subs.safeSub}</div></div>
            </div>
            {bar.segs.length > 0 && (
              <>
                <div className="n4-bar" role="img" aria-label="Divisão do dinheiro em conta entre seguro, folga e comprometido">
                  {bar.segs.map((s, i) => <div key={i} className={s.hatch ? "n4-hatch" : ""} style={{ width: `${s.w}%`, background: s.hatch ? undefined : s.bg, borderRadius: i === 0 ? "7px 2px 2px 7px" : i === bar.segs.length - 1 ? "2px 7px 7px 2px" : 2 }} />)}
                </div>
                <div className="n4-legend">
                  {bar.legend.map((l) => <span className="k" key={l.label}><i className={l.hatch ? "n4-hatch" : ""} style={{ background: l.hatch ? undefined : l.bg }} />{l.label}</span>)}
                  {h.vaBalance != null && <span className="va">VA {fmt(h.vaBalance)} fica de fora: é só para comida.</span>}
                </div>
              </>
            )}
            {h.unpricedBills?.count > 0 && <div className="n4-hero-note" role="note">{h.unpricedBills.text}</div>}
          </div>

          {/* compacto: recibo */}
          <div className="n4-receipt" role="group" aria-label="Como chegamos no seguro para gastar">
            <Receipt op="" label="Na conta" value={fmt(h.cash)} />
            {h.committedParts.map((p, i) => <Receipt key={p.label + i} op="−" label={p.funded ? `${p.short}, separado` : p.label} value={fmt(p.amount)} dim rule={i === h.committedParts.length - 1} />)}
            <Receipt op="=" label="Livre" value={fmt(h.free)} />
            {h.safetyReserve > 0 && <Receipt op="−" label="Folga de segurança" value={fmt(h.safetyReserve)} dim rule />}
            <Receipt op="=" label="Seguro para gastar" value={fmt(h.safe)} lime />
            {h.vaBalance != null && <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginTop: 6 }}>VA {fmt(h.vaBalance)} fica de fora: é só para comida.</div>}
            {h.unpricedBills?.count > 0 && <div className="n4-hero-note" role="note">{h.unpricedBills.text}</div>}
          </div>
        </section>

        <div className="n4-qgrid">{quick.map((q) => <QBtn key={q.label} q={q} compact />)}</div>

        {/* ============ ROW 2 ============ */}
        <div className="n4-grid2 a">
          <section className="n4-card" aria-labelledby="n4-att">
            <div className="n4-row-head"><div className="n4-card-title" id="n4-att">Atenção agora</div><div className="n4-card-sub n4-hide-compact">só o que pede ação</div></div>
            <div style={{ marginTop: 8 }}>
              {m.attention.length === 0 && <div className="n4-empty">Nada pede ação agora.</div>}
              {m.attention.map((a) => <AttentionRow key={a.id} a={a} />)}
            </div>
          </section>

          <div className="n4-col">
            <section className="n4-card roomy" aria-labelledby="n4-comp">
              <div className="n4-mono n4-hide-compact" style={{ color: "#6e747b", letterSpacing: "0.13em" }} id="n4-comp">Compromissos de {m.compromissos.monthLong.toLowerCase()}</div>
              <div className="n4-row-head n4-only-compact"><div className="n4-card-title">Compromissos</div><div style={{ fontSize: 13, color: "#565c63" }}>{m.compromissos.resolved} de {m.compromissos.total}</div></div>
              <div className="n4-hide-compact" style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 8 }}>
                <div className="n4-bigfig">{m.compromissos.resolved}</div>
                <div style={{ fontSize: 15, color: "#565c63" }}>de {m.compromissos.total} resolvidos</div>
              </div>
              <div className="n4-segs" style={{ marginTop: 14 }} role="img" aria-label={`${m.compromissos.resolved} de ${m.compromissos.total} resolvidos`}>
                {Array.from({ length: m.compromissos.total }, (_, i) => <div key={i} style={{ background: i < m.compromissos.resolved ? "#0B0B0C" : "#E4E7EA" }} />)}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 16, gap: 12, flexWrap: "wrap" }}>
                <div className="n4-kv"><div><small>Pago</small><span>{fmt(m.compromissos.paidAmount)}</span></div><div><small>Falta</small><span>{fmt(m.compromissos.pendingAmount)}</span></div></div>
                <Link href="/compromissos?tab=mes" className="n4-ink-btn"><span>Ver compromissos</span><Ico name="arrow" size={14} stroke="#C9FF29" /></Link>
              </div>
            </section>

            {m.casa.total > 0 && (
              <section className="n4-card" aria-labelledby="n4-casa">
                <div className="n4-row-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Ico name="house" size={16} stroke="#0b0b0c" width={1.7} /><span id="n4-casa" style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.02em" }}>Casa</span></div>
                  <span style={{ fontSize: 13, color: "#565c63" }}>{m.casa.resolved} de {m.casa.total} resolvidas</span>
                </div>
                <div style={{ marginTop: 10 }}>
                  {m.casa.rows.map((c) => (
                    <div className="n4-casa-row" key={c.name}>
                      <span style={{ fontSize: 14 }}>{c.name}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: c.tone === "ink" ? "#0b0b0c" : c.tone === "warning" ? "#8a5a12" : "#565c63" }}>
                        {c.done && <Ico name="check" size={13} stroke="#0b0b0c" width={2.2} />}<span>{c.status}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <Link href="/compromissos?tab=casa" className="n4-link"><span>Ver todas as contas</span><Ico name="arrow" size={13} /></Link>
              </section>
            )}
          </div>
        </div>

        {/* ============ ROW 3 ============ */}
        <div className="n4-grid2 b">
          {m.relief ? (
            <Link href="/compromissos?tab=parc" className="n4-lime" style={{ textDecoration: "none", color: "#0b0b0c" }} aria-label={`Próximo alívio em ${m.relief.monthLong}: mais ${fmtS(m.relief.released)} por mês`}>
              <div>
                <div className="n4-mono" style={{ color: "rgba(11,11,12,0.72)", letterSpacing: "0.14em", fontSize: 10.5 }}>Próximo alívio · {m.relief.monthLong}</div>
                <div className="n4-lime-num">+{fmtS(m.relief.released)}<span style={{ fontSize: 18, letterSpacing: "-0.02em" }}>/mês</span></div>
                <div style={{ fontSize: 14, color: "rgba(11,11,12,0.78)", marginTop: 4 }}>{m.relief.names.join(", ")} {m.relief.names.length > 1 ? "terminam" : "termina"}</div>
              </div>
              <div style={{ marginTop: "auto", paddingTop: 24 }}>
                <div className="hide-c" style={{ fontSize: 13, color: "rgba(11,11,12,0.78)", lineHeight: 1.5, textWrap: "pretty" }}>
                  {m.nextIncomeCommitment.percent != null && m.hero.nextIncomeLabel ? `Da renda de ${m.hero.nextIncomeLabel}, ${fmt(m.nextIncomeCommitment.committedAmount)} (${m.nextIncomeCommitment.percent.toFixed(1).replace(".", ",")}%) já tem destino. ` : ""}
                  {m.relief.untilReleased > 0 && m.relief.untilLabel ? `Até ${m.relief.untilLabel}, mais ${fmtS(m.relief.untilReleased)}/mês ficam livres.` : ""}
                </div>
                <div className="n4-ink-btn hide-c" style={{ marginTop: 14 }}><span>Ver próximos alívios</span><Ico name="arrow" size={14} stroke="#C9FF29" /></div>
                {m.nextIncomeCommitment.percent != null && <div className="n4-only-compact" style={{ fontSize: 12.5, color: "rgba(11,11,12,0.78)", marginTop: 10 }}>{m.hero.nextIncomeLabel ? `Da renda de ${m.hero.nextIncomeLabel}, ` : ""}{m.nextIncomeCommitment.percent.toFixed(1).replace(".", ",")}% já tem destino.</div>}
              </div>
            </Link>
          ) : <div className="n4-hide-compact" />}

          <section className="n4-card" aria-labelledby="n4-moves" style={m.relief ? undefined : { gridColumn: "1 / -1" }}>
            <div className="n4-card-title" id="n4-moves" style={{ marginBottom: 6 }}>Últimas movimentações</div>
            {m.moves.length === 0 && <div className="n4-empty">Nenhum lançamento ainda.</div>}
            {m.moves.map((mv, i) => (
              <div className="n4-move" key={i}>
                <div className="n4-mono d" style={{ color: "#6e747b", letterSpacing: "0.06em", fontSize: 11 }}>{mv.date}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mv.name}</div>
                  <div style={{ fontSize: 12, color: "#6e747b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mv.sub}</div>
                </div>
                <div className="n4-tab n4-nowrap" style={{ fontSize: 14.5, color: mv.type === "income" ? "#2E6F4E" : "#0B0B0C" }}>{mv.type === "transfer" ? fmt(mv.amount) : signed(mv.amount)}</div>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

function Receipt({ op, label, value, dim, rule, lime }) {
  return (
    <div className={`n4-receipt-row ${rule ? "rule" : ""}`}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span style={{ width: 12, fontSize: 13, color: "rgba(255,255,255,0.5)" }} aria-hidden="true">{op}</span>
        <span style={{ fontSize: 13, color: lime ? "#C9FF29" : dim ? "rgba(255,255,255,0.7)" : "#fff" }}>{label}</span>
      </div>
      <span className="n4-tab n4-nowrap" style={{ fontSize: dim ? 14 : 15, color: lime ? "#C9FF29" : dim ? "rgba(255,255,255,0.8)" : "#fff" }}>{value}</span>
    </div>
  );
}

const ATT_ICON = { fatura: "card", parcelas: "repeat", casa: "house", compromisso: "lock", funded: "lock" };
function AttentionRow({ a }) {
  const primary = a.tone === "primary";
  const body = (
    <>
      <div className="n4-att-ico" style={{ background: primary ? "#0B0B0C" : "#F2F3F5" }}><Ico name={ATT_ICON[a.kind] ?? "bill"} size={16} stroke={primary ? "#C9FF29" : "#565C63"} width={1.7} /></div>
      <div className="n4-att-main" style={{ minWidth: 0 }}>
        <div className="n4-att-name">{a.name}</div>
        <div className="n4-att-sub">{a.sub}</div>
      </div>
      <div className="n4-att-val">{a.value != null ? fmt(a.value) : a.valueLabel}</div>
    </>
  );
  return (
    <div className="n4-att" style={{ position: "relative" }}>
      {body}
      <Link href={a.href} className={`n4-cta ${primary ? "is-ink" : "is-soft"}`} aria-label={`${a.cta}: ${a.name}`}>{a.cta}</Link>
      <Link href={a.href} className="n4-only-compact" aria-label={`${a.cta}: ${a.name}`} style={{ position: "absolute", inset: 0 }} tabIndex={-1} />
    </div>
  );
}
