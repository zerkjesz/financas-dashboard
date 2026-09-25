"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./v4.css";
import { Ico } from "./Icons.jsx";
import PaySheet from "./PaySheet.jsx";
import Toast from "./Toast.jsx";
import SoundToggle from "./SoundToggle.jsx";
import { useNorteAudio } from "./useNorteAudio.js";
import { fmt, fmtS, plural } from "./format.js";
import { sectionsFor, tabsFor, sheetItemFor, fundedSheetItem, reliefGeometry, milestoneText, casaIcon } from "./compromissosView.js";

// Fase 9.1 — COMPROMISSOS v4. Consome /api/compromissos (read-model real, somente leitura) e ações
// POST /api/compromissos/pay|undo. A animação/som/confete só disparam DEPOIS do sucesso do backend.
const TAB_KEYS = ["mes", "parc", "casa", "todos"];
const PAID_MSG = { installment: "Parcela paga ✓", house: "Conta paga ✓", commitment: "Compromisso pago ✓" };

export default function CompromissosV4() {
  const [model, setModel] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("mes");
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(null);
  const [flash, setFlash] = useState(null);
  const audio = useNorteAudio();
  const timers = useRef({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/compromissos", { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      setModel(await res.json());
      setError(null);
    } catch {
      setError("Não consegui carregar os compromissos. Tente de novo.");
    }
  }, []);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (TAB_KEYS.includes(t)) setTab(t);
    load();
    const timersRef = timers.current;
    return () => Object.values(timersRef).forEach(clearTimeout);
  }, [load]);

  function goTab(k) {
    setTab(k);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("tab", k);
      window.history.replaceState(null, "", u);
    } catch {}
  }

  function showToast(t, ms) {
    setToast(t);
    clearTimeout(timers.current.toast);
    timers.current.toast = setTimeout(() => setToast(null), ms);
  }

  async function pay(payBase, payload) {
    let json;
    try {
      const res = await fetch("/api/compromissos/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payBase, ...payload }) });
      json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return { ok: false, error: json.error || "Não consegui registrar o pagamento. Nada foi gravado." };
    } catch {
      return { ok: false, error: "Sem conexão com o servidor. Nada foi gravado." };
    }
    await load(); // a UI mostra o estado REAL vindo do backend
    setFlash(json.kind + ":" + (json.installmentId || json.billId || json.commitmentId));
    clearTimeout(timers.current.flash);
    timers.current.flash = setTimeout(() => setFlash(null), 1800);
    showToast({ msg: PAID_MSG[json.kind] || "Pago ✓", undo: json.undo }, 5000);
    return { ok: true };
  }

  async function undo() {
    const u = toast?.undo;
    if (!u) return;
    setToast(null);
    try {
      const res = await fetch("/api/compromissos/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return showToast({ msg: json.error || "Não consegui desfazer.", undo: null }, 4200);
      await load();
      setFlash(null);
      showToast({ msg: "Pagamento desfeito", undo: null }, 2600);
    } catch {
      showToast({ msg: "Sem conexão. Nada foi alterado.", undo: null }, 3200);
    }
  }
  async function undoRow(u) {
    setToast({ msg: "Desfazendo…", undo: null });
    try {
      const res = await fetch("/api/compromissos/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(u) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return showToast({ msg: json.error || "Não consegui desfazer.", undo: null }, 4200);
      await load();
      showToast({ msg: "Pagamento desfeito", undo: null }, 2600);
    } catch {
      showToast({ msg: "Sem conexão. Nada foi alterado.", undo: null }, 3200);
    }
  }

  if (error && !model) {
    return (
      <div className="n4" role="alert" style={{ padding: "60px 4px" }}>
        <div className="n4-card" style={{ textAlign: "center" }}>
          <div className="n4-card-title">{error}</div>
          <button type="button" className="n4-ink-btn" style={{ marginTop: 16 }} onClick={load}>Tentar de novo</button>
        </div>
      </div>
    );
  }
  if (!model) return <div className="n4" aria-busy="true" style={{ minHeight: 400 }}><div className="n4-head"><div><div className="n4-eyebrow">Compromissos</div><div className="n4-title">&nbsp;</div></div></div></div>;

  const s = model.summary;
  const sections = sectionsFor(tab, model);
  const tabs = tabsFor(model);
  const fundedTotal = model.funded.reduce((a, f) => a + f.amount, 0);
  const fundedLabel = model.funded.length === 1 && model.funded[0].shortLabel ? `Separado para o ${model.funded[0].shortLabel}` : "Separado para um destino";
  const segs = Array.from({ length: Math.max(s.total, 0) }, (_, i) => i < s.resolved);
  const paying = (item) => setSheet(item);

  return (
    <div className="n4">
      <div className="n4-rise">
        <div className="n4-head">
          <div>
            <div className="n4-eyebrow">Compromissos</div>
            <h1 className="n4-title" style={{ margin: 0, marginTop: 8 }}>{model.monthLong}</h1>
          </div>
          <SoundToggle soundOn={audio.soundOn} onToggle={audio.toggleSound} />
        </div>

        {/* resumo do mês (escuro) */}
        <section className="n4-hero is-left" aria-label="Resumo do mês" style={{ padding: "32px 36px" }}>
          <div className="n4-hero-top" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: "28px 40px" }}>
            <div>
              <div className="n4-mono n4-hero-label" style={{ letterSpacing: "0.15em", fontSize: 10.5 }}>Resolvidos este mês</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 10 }}>
                <div className="n4-tab" style={{ fontSize: "clamp(52px,6vw,72px)", fontWeight: 300, letterSpacing: "-0.05em", lineHeight: 1 }}>{s.resolved}</div>
                <div style={{ fontSize: 22, color: "rgba(255,255,255,0.66)" }}>de {s.total}</div>
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 22 }} role="img" aria-label={`${s.resolved} de ${s.total} compromissos resolvidos`}>
                {segs.map((on, i) => (
                  <div key={i} style={{ flex: 1, height: 10, borderRadius: 3, background: on ? "#C9FF29" : "rgba(255,255,255,0.14)", boxShadow: on && i === s.resolved - 1 && flash ? "0 0 14px rgba(201,255,41,0.7)" : "none", transition: "background .45s, box-shadow .45s", minWidth: 2 }} />
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, paddingBottom: 14, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                <span style={{ fontSize: 13.5, color: "rgba(255,255,255,0.7)" }}>Já pago</span>
                <span className="n4-tab n4-nowrap" style={{ fontSize: 22, color: "#C9FF29" }}>{fmt(s.paidAmount)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, paddingBottom: model.funded.length ? 14 : 0, borderBottom: model.funded.length ? "1px solid rgba(255,255,255,0.1)" : 0 }}>
                <div>
                  <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.7)" }}>Ainda falta</div>
                  <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginTop: 2 }}>{s.awaitingValueCount > 0 ? `+ ${s.awaitingValueCount} ${plural(s.awaitingValueCount, "conta aguardando valor", "contas aguardando valor")}` : "valores já conhecidos"}</div>
                </div>
                <span className="n4-tab n4-nowrap" style={{ fontSize: 22 }}>{fmt(s.pendingAmount)}</span>
              </div>
              {model.funded.length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <span style={{ fontSize: 13.5, color: "rgba(255,255,255,0.7)" }}>{fundedLabel}</span>
                  <span className="n4-tab n4-nowrap" style={{ fontSize: 16, color: "rgba(255,255,255,0.8)" }}>{fmt(fundedTotal)}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="n4-tabs" role="tablist" aria-label="Compromissos">
          {tabs.map((t) => (
            <button type="button" key={t.key} role="tab" aria-selected={tab === t.key} id={`n4-tab-${t.key}`} onClick={() => tab !== t.key && goTab(t.key)} className="n4-tab-btn">
              <span className="l">{t.label}</span>
              <span className="s">{t.short}</span>
              <span className="c">{t.count}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" aria-labelledby={`n4-tab-${tab}`}>
          {sections.map((sec) => (
            <div className="n4-section" key={`${tab}-${sec.id}`}>
              {sec.title && (
                <div className="n4-section-head">
                  <h2>{sec.title}</h2>
                  {sec.sub && <span>{sec.sub}</span>}
                </div>
              )}
              {sec.type === "cards" && (sec.items.length === 0 ? <div className="n4-card"><div className="n4-empty">Nada por aqui.</div></div> : <div className="n4-cards">{sec.items.map((c) => <PlanCard key={c.id} c={c} flash={flash} onPay={() => paying(sheetItemFor(c.item))} onUndo={undoRow} />)}</div>)}
              {sec.type === "funded" && sec.items.map((f) => <FundedBox key={f.id} f={f} onPay={() => paying(fundedSheetItem(f))} />)}
              {sec.type === "done" && (sec.items.length === 0 ? <div className="n4-card"><div className="n4-empty">Nada foi concluído ainda este mês.</div></div> : (
                <div className="n4-donelist">
                  {sec.items.map((d) => (
                    <div key={d.id} className="n4-done-row">
                      <div className="n4-check"><Ico name="check" size={12} stroke="#0b0b0c" width={2.8} /></div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, color: "#2c3138", overflowWrap: "anywhere" }}>{d.name}</div>
                        <div style={{ fontSize: 12, color: "#6e747b" }}>{d.line}<span className="n4-only-compact"> · {d.when}</span></div>
                      </div>
                      <div className="when-col" style={{ fontSize: 12.5, color: "#6e747b", whiteSpace: "nowrap" }}>{d.when}</div>
                      <div className="n4-tab n4-nowrap" style={{ fontSize: 14, color: "#565c63", minWidth: 90, textAlign: "right" }}>{d.value}</div>
                      {d.undo && <button type="button" className="n4-undo-link" onClick={() => undoRow(d.undo)} aria-label={`Desfazer pagamento de ${d.name}`}>Desfazer</button>}
                    </div>
                  ))}
                </div>
              ))}
              {sec.type === "relief" && <Relief relief={sec.relief} nextIncome={null} />}
              {sec.type === "list" && sec.groups.map((g) => (
                <div className="n4-list-group" key={g.title}>
                  <div className="n4-row-head"><div className="n4-mono" style={{ color: "#6e747b", fontSize: 10.5 }}>{g.title}</div><div style={{ fontSize: 12.5, color: "#6e747b" }}>{g.sub}</div></div>
                  {g.rows.map((r) => (
                    <button type="button" className="n4-list-row" key={r.key} onClick={() => r.openable && paying(r.funded ? fundedSheetItem(r.funded) : sheetItemFor(r.item))} disabled={!r.openable} aria-label={`${r.name}, ${r.status}`}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 14, overflowWrap: "anywhere" }}>{r.name}</span>
                        <span style={{ display: "block", fontSize: 12, color: "#6e747b" }}>{r.sub}</span>
                      </span>
                      <span className={`n4-chip ${r.tone === "lime" ? "is-lime" : r.tone === "warn" ? "is-warn" : r.tone === "ink" ? "is-ink" : ""}`}>{r.status}</span>
                      <span className="n4-tab n4-nowrap" style={{ textAlign: "right", fontSize: 14 }}>{r.value}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {sheet && <PaySheet item={sheet} accounts={model.accounts} onPrime={audio.prime} onCelebrate={audio.celebrateAt} onConfirm={(p) => pay(sheet.pay, p)} onClose={() => setSheet(null)} />}
      <Toast toast={toast} onUndo={undo} />
    </div>
  );
}

function PlanCard({ c, flash, onPay, onUndo }) {
  const isFlash = flash && c.done;
  return (
    <div className={`n4-pcard ${isFlash ? "is-flash" : ""}`}>
      <div className="n4-pcard-top">
        <div className="n4-pcard-kind">
          <div className="n4-pcard-ico"><Ico name={c.icon} size={15} stroke="#565c63" width={1.7} /></div>
          <span className="n4-mono" style={{ color: "#6e747b" }}>{c.kindLabel}</span>
        </div>
        {c.chip && <span className={`n4-chip ${c.chipTone === "warn" ? "is-warn" : ""}`}>{c.chip}</span>}
      </div>
      <div>
        <div className="n4-pcard-name">{c.name}</div>
        {c.to && <div className="n4-pcard-to"><Ico name="person" size={13} /><span>{c.to}</span></div>}
        {c.note && <div className="n4-pcard-note">{c.note}</div>}
      </div>
      <div className="n4-pcard-val">
        <strong className={c.valueFaint ? "is-faint" : ""}>{c.valueTxt}</strong>
        <span>{c.detail}</span>
      </div>
      {c.segs && (
        <div>
          <div className="n4-pcard-segs" role="img" aria-label={c.progressTxt}>
            {c.segs.map((sg, i) => <div key={i} style={{ background: sg.bg, boxShadow: sg.line }} />)}
          </div>
          <div className="n4-pcard-prog"><span style={{ color: "#565c63" }}>{c.progressTxt}</span><span className="n4-tab n4-nowrap">{c.restTxt}</span></div>
        </div>
      )}
      {c.sub && <div className="n4-pcard-hint">{c.sub}</div>}
      <div style={{ marginTop: "auto" }}>
        {c.notDone ? (
          <button type="button" className="n4-pay" onClick={onPay}>
            <Ico name={c.ctaIcon} size={15} stroke="#c9ff29" width={2} />
            <span>{c.cta}</span>
          </button>
        ) : (
          <div className="n4-done-box">
            <div className="n4-check n4-pop"><Ico name="check" size={12} stroke="#0b0b0c" width={2.8} /></div>
            <span className="t">{c.doneTxt}</span>
            {c.item.undo && <button type="button" className="n4-undo-link" onClick={() => onUndo(c.item.undo)} aria-label={`Desfazer pagamento de ${c.name}`}>Desfazer</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function FundedBox({ f, onPay }) {
  return (
    <div className="n4-funded">
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="n4-chip is-ink" style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 12px", fontSize: 12 }}>
            <Ico name="lock" size={12} stroke="#c9ff29" width={2} />
            <span>Dinheiro separado</span>
          </span>
          <span style={{ fontSize: 12.5, color: "#565c63" }}>{f.dueDate ? `Prazo: ${new Date(f.dueDate).toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : "Sem prazo definido"}</span>
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 14, overflowWrap: "anywhere" }}>{f.description}</div>
        <div style={{ fontSize: 13, color: "#565c63", marginTop: 4 }}>Já está fora do seu dinheiro livre. Não conta como atrasado.</div>
      </div>
      <div className="n4-funded-right">
        <div className="n4-tab n4-nowrap" style={{ fontSize: 26, letterSpacing: "-0.03em" }}>{fmt(f.amount)}</div>
        <button type="button" className="n4-cta is-white" style={{ marginTop: 10 }} onClick={onPay}>{f.ctaLabel}</button>
      </div>
    </div>
  );
}

function Relief({ relief }) {
  const g = reliefGeometry(relief);
  return (
    <div className="n4-relief">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 20, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.025em" }}>Quando sua renda fica mais leve</div>
          <div style={{ fontSize: 13.5, color: "#565c63", marginTop: 4 }}>Quanto das parcelas sai da renda a cada mês, até zerar.</div>
        </div>
        <div style={{ display: "flex", gap: 26 }}>
          <div><div style={{ fontSize: 12, color: "#6e747b" }}>Hoje, por mês</div><div className="n4-tab n4-nowrap" style={{ fontSize: 19 }}>{fmt(relief.todayMonthly)}</div></div>
          {relief.zeroMonth && <div><div style={{ fontSize: 12, color: "#6e747b" }}>Zera em</div><div style={{ fontSize: 19 }}>{relief.zeroMonth.longLabel}</div></div>}
        </div>
      </div>

      <div className="n4-relief-chart" role="img" aria-label={`Parcelas por mês: hoje ${fmt(relief.todayMonthly)}${relief.zeroMonth ? `, zera em ${relief.zeroMonth.longLabel}` : ""}`}>
        <svg viewBox="0 0 1100 200" preserveAspectRatio="none"><path d={g.area} fill="#0b0b0c" /></svg>
        <div className="n4-relief-now" style={{ width: `${g.nowWidthPct}%` }} />
        {g.marks.map((m, i) => (
          <span key={i}>
            <div className="n4-relief-mark" style={{ left: m.x, top: m.y }}>+{m.amount}</div>
            <div className="n4-relief-dot" style={{ left: m.x, top: m.y }} />
          </span>
        ))}
      </div>
      <div className="n4-relief-axis" style={{ gridTemplateColumns: `repeat(${g.n}, minmax(0, 1fr))` }}>
        {g.axis.map((a, i) => (
          <div key={i}>
            <div className="m" style={{ color: a.strong ? "#0b0b0c" : "#6e747b", visibility: a.show ? "visible" : "hidden" }}>{a.label}</div>
            <div className="v" style={{ visibility: a.show ? "visible" : "hidden" }}>{a.value}</div>
          </div>
        ))}
      </div>
      <div className="n4-milestones">
        {relief.milestones.map((ms) => (
          <div className="n4-milestone" key={ms.monthKey}>
            <div className="n4-mono" style={{ color: "#565c63", letterSpacing: "0.12em" }}>{ms.label}</div>
            <div className="n4-tab n4-nowrap" style={{ fontSize: 15, fontWeight: 600, marginTop: 6 }}>+{fmtS(ms.released)}/mês</div>
            <div style={{ fontSize: 12, color: "#565c63", marginTop: 4, lineHeight: 1.35 }}>{milestoneText(ms)}</div>
          </div>
        ))}
      </div>

      {/* compacto: lista de marcos em vez do gráfico comprimido */}
      <div className="n4-relief-list">
        <div style={{ position: "relative", marginTop: 18, paddingLeft: 22 }}>
          <div style={{ position: "absolute", left: 6, top: 6, bottom: 6, width: 2, background: "#e7e9ec", borderRadius: 1 }} />
          {relief.milestones.map((ms) => (
            <div key={ms.monthKey} style={{ position: "relative", padding: "0 0 18px" }}>
              <div style={{ position: "absolute", left: -21, top: 4, width: 12, height: 12, borderRadius: "50%", background: "#c9ff29", boxShadow: "0 0 0 2.5px #fff, 0 0 0 3.5px rgba(11,11,12,0.12)" }} />
              <div className="n4-mono" style={{ color: "#565c63", letterSpacing: "0.12em" }}>{ms.label}</div>
              <div className="n4-tab" style={{ fontSize: 15, fontWeight: 600, marginTop: 3 }}>+{fmtS(ms.released)}/mês ficam livres</div>
              <div style={{ fontSize: 12.5, color: "#565c63", marginTop: 2 }}>{milestoneText(ms)}</div>
              <div className="n4-tab" style={{ fontSize: 11.5, color: "#6e747b", marginTop: 2 }}>Parcelas passam a {fmt(ms.after)}/mês</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
