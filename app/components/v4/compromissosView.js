// ============================================================================
// Fase 9.1 — view-model PURO da página Compromissos: transforma o read-model do backend
// (lib/compromissosModel.js) nos campos que o protótipo v4 desenha. Sem DOM, sem fetch — testável.
// Nenhum valor/mês/nome é hardcoded aqui: tudo vem do modelo.
// ============================================================================
import { fmt, fmtS, joinNames, plural } from "./format.js";

const INK = "#0B0B0C";
const LIME = "#C9FF29";
const TRACK = "#E4E7EA";

export function casaIcon(name) {
  const n = String(name).toLowerCase();
  if (/alugu/.test(n)) return "house";
  if (/energia|luz|el[eé]tric/.test(n)) return "bolt";
  if (/internet|wi-?fi|net\b/.test(n)) return "net";
  if (/[áa]gua/.test(n)) return "drop";
  if (/telefone|celular|plano/.test(n)) return "phone";
  if (/faxina|limpeza/.test(n)) return "spark";
  return "house";
}

function rangeText(c) {
  if (c.referenceMin == null && c.referenceMax == null) return null;
  const lo = c.referenceMin ?? c.referenceMax;
  const hi = c.referenceMax ?? c.referenceMin;
  const f = (n) => Math.round(n).toLocaleString("pt-BR");
  return lo === hi ? `~R$ ${f(lo)}` : `~R$ ${f(lo)}–${f(hi)}`;
}

function dueDayText(c) {
  return c.dueDay == null ? null : `todo dia ${c.dueDay}`;
}

// Vencimento já passado (ex.: aluguel dia 5 e hoje é 25) => chip "Venceu dia 5" (só se o dia é conhecido).
export function overdueChip(item) {
  return item.overdue && item.casa?.dueDay != null ? `Venceu dia ${item.casa.dueDay}` : item.overdue && item.kind === "compromisso" ? "Atrasado" : null;
}

export function cardView(item) {
  const done = item.state === "done";
  const base = { id: item.id, item, kindLabel: item.kindLabel, name: item.name, done, notDone: !done, to: item.to ? `Pagamento para ${item.to}` : null, note: item.note, chip: null, chipTone: "", sub: null, segs: null, progressTxt: null, restTxt: null, valueFaint: false };

  if (item.kind === "parcela") {
    const p = item.parcela;
    const paidBefore = p.paidCount - (done ? 1 : 0);
    const segs = Array.from({ length: p.total }, (_, i) => ({ bg: i < paidBefore ? INK : i === paidBefore ? (done ? LIME : "transparent") : TRACK, line: i === paidBefore && !done ? "inset 0 0 0 1.5px #0B0B0C" : "none" }));
    const rest = p.remainingAmount;
    return {
      ...base,
      icon: "repeat",
      valueTxt: fmt(item.value),
      detail: done ? `Parcela ${p.current} de ${p.total} paga` : `Parcela ${p.current} de ${p.total}`,
      chip: p.isLast && !done ? "Última parcela" : null,
      segs,
      progressTxt: `${p.paidCount} de ${p.total} pagas`,
      restTxt: rest > 0.001 ? `${fmt(rest)} restantes` : "Quitado",
      cta: "Marcar como paga",
      ctaIcon: "check",
      doneTxt: done ? (rest > 0.001 ? `Paga · ${doneWhen(item)}` : "Quitado! Última parcela paga") : null,
      rowSub: `${item.to ? `Para ${item.to} · ` : ""}parcela ${p.current} de ${p.total}`,
    };
  }

  if (item.kind === "casa") {
    const c = item.casa;
    const multi = c.partsTotal > 1;
    const variable = c.amountKind === "VARIABLE";
    const approx = c.amountKind === "APPROXIMATE";
    const awaiting = item.awaitingValue;
    const over = overdueChip(item);
    let valueTxt = fmt(multi ? c.monthlyTotal : item.value);
    if (awaiting) valueTxt = "Aguardando valor";
    else if (approx && !done) valueTxt = `~${fmt(item.value)}`;
    else if (variable && done) valueTxt = fmt(item.done.value);
    let detail = c.dueDay != null ? `Vence ${dueDayText(c)}` : "Mensal";
    if (variable) detail = done ? "Valor deste mês" : "Valor variável";
    if (multi) detail = `por mês · ${c.cadence === "BIWEEKLY" ? "quinzenal" : "em partes"}`;
    let sub = null;
    if (variable) {
      const range = rangeText(c);
      sub = done ? `Valor variável${range ? ` · normal ${range}` : ""}` : `${c.lastPaid ? `Última conta: ${fmt(c.lastPaid.amount)} · ` : ""}${range ? `normal ${range}. ` : ""}${c.dueDay == null ? "Vencimento ainda não informado." : ""}`.trim();
    } else if (!multi) {
      sub = c.dueDay == null ? "Vencimento ainda não informado" : "Valor fixo";
    }
    let segs = null;
    if (multi) {
      segs = Array.from({ length: c.partsTotal }, (_, i) => ({ bg: i < c.partsPaid ? (done && i === c.partsTotal - 1 ? LIME : INK) : TRACK, line: !done && i === c.partsPaid ? "inset 0 0 0 1.5px #0B0B0C" : "none" }));
      if (!done) segs = segs.map((s, i) => (i === c.partsPaid ? { bg: "transparent", line: s.line } : s));
    }
    const nth = c.part;
    if (item.beforeNextIncome) {
      // Fase 9.1.2 — conta de OUTRA competência que vence antes da próxima renda: já está no comprometido.
      const dd = new Date(c.dueDate);
      detail = `Vence ${String(dd.getUTCDate()).padStart(2, "0")}/${String(dd.getUTCMonth() + 1).padStart(2, "0")}`;
      sub = `Vence antes da sua próxima renda${c.beforeIncomeLabel ? ` de ${c.beforeIncomeLabel}` : ""}.${awaiting ? " Valor ainda não informado." : ""}`;
    }
    return {
      ...base,
      icon: casaIcon(item.name),
      valueTxt,
      valueFaint: awaiting,
      detail,
      chip: awaiting ? "Aguardando valor" : item.beforeNextIncome ? "Antes da renda" : over ?? (approx && !done ? "Valor aproximado" : null),
      chipTone: awaiting || over ? "warn" : "",
      sub,
      segs,
      progressTxt: multi ? `${c.partsPaid} de ${c.partsTotal} visitas pagas` : null,
      restTxt: multi ? (done ? "Mês fechado" : `Falta ${fmt(c.remainingAmount)}`) : null,
      cta: awaiting ? "Informar valor e pagar" : multi ? `Pagar ${nth}ª visita · ${fmtS(item.value)}` : "Marcar como paga",
      ctaIcon: awaiting ? "pencil" : "check",
      doneTxt: done ? `Paga · ${doneWhen(item)}` : null,
      rowSub: multi ? `Quinzenal · ${c.partsTotal}x de ${fmtS(item.value)}` : variable ? "Valor variável" : c.dueDay != null ? `Todo dia ${c.dueDay}` : "Mensal",
    };
  }

  // compromisso comum
  return {
    ...base,
    icon: "lock",
    valueTxt: fmt(item.value),
    detail: item.compromisso.dueDate ? `Vence em ${new Date(item.compromisso.dueDate).toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : "Sem prazo definido",
    chip: overdueChip(item),
    chipTone: "warn",
    cta: "Marcar como paga",
    ctaIcon: "check",
    doneTxt: done ? `Paga · ${doneWhen(item)}` : null,
    rowSub: item.compromisso.dueDate ? "Compromisso confirmado" : "Sem prazo definido",
  };
}

export function doneWhen(item) {
  const d = item.done;
  if (!d) return "";
  return `${d.when}${d.withoutExpense ? " · fora do Norte" : d.sourceName ? ` · ${d.sourceName}` : ""}`;
}

// ---- item pro PaySheet
export function sheetItemFor(item) {
  const v = cardView(item);
  const c = item.casa;
  const variable = c?.amountKind === "VARIABLE";
  const range = c ? rangeText(c) : null;
  let detail = v.detail;
  if (item.kind === "parcela") detail = `Parcela ${item.parcela.current} de ${item.parcela.total}`;
  if (c) detail = c.partsTotal > 1 ? `${c.part}ª visita de ${c.partsTotal} neste mês` : `Conta da casa · ${variable ? "valor variável" : c.amountKind === "APPROXIMATE" ? "valor aproximado" : c.dueDay != null ? `todo dia ${c.dueDay}` : "mensal"}`;
  if (item.kind === "compromisso") detail = "Compromisso confirmado";
  return {
    title: variable ? "Informar e pagar" : "Marcar como paga",
    name: item.name,
    detail,
    to: item.to,
    value: item.value ?? 0,
    needsValue: !!variable || item.awaitingValue,
    approx: c?.amountKind === "APPROXIMATE",
    hint: variable ? `${range ? `Normal: ${range}` : ""}${c.lastPaid ? ` · última conta: ${fmt(c.lastPaid.amount)}` : ""}`.replace(/^ · /, "") : c?.amountKind === "APPROXIMATE" ? "Valor aproximado — confirme o que você pagou de verdade." : null,
    defaultAccountId: c?.defaultAccountId ?? null,
    pay: item.pay,
    confirmLabel: "Confirmar pagamento",
  };
}
export function fundedSheetItem(f) {
  const ret = f.settlementMode === "EXTERNAL_TRANSFER";
  return { title: ret ? "Marcar como devolvido" : "Marcar como paga", name: f.description, detail: ret ? "Devolução de capital — não é despesa" : "Compromisso", to: null, value: f.amount, needsValue: false, approx: false, hint: null, defaultAccountId: null, pay: f.pay, confirmLabel: ret ? "Confirmar devolução" : "Confirmar pagamento" };
}

// ---- seções por aba
export function tabsFor(model) {
  const pend = model.items.filter((i) => i.state === "pending").length;
  return [
    { key: "mes", label: "Este mês", short: "Este mês", count: pend },
    { key: "parc", label: "Parcelamentos", short: "Parcelas", count: model.summary.parcelCount },
    { key: "casa", label: "Contas da casa", short: "Casa", count: model.summary.casaCount },
    { key: "todos", label: "Todos", short: "Todos", count: model.items.length + model.funded.length },
  ];
}

export function casaMonthlyEstimate(model) {
  const items = model.items.filter((i) => i.kind === "casa");
  const known = items.reduce((a, i) => a + (i.casa.monthlyTotal ?? 0), 0);
  const refs = items.filter((i) => i.awaitingValue || i.casa.amountKind === "VARIABLE").reduce((a, i) => a + (i.casa.referenceMin ?? 0), 0);
  return { value: Math.round((known + refs) * 100) / 100, approximate: refs > 0 || items.some((i) => i.casa.amountKind !== "FIXED") };
}

export function pendingSubtitle(model) {
  const s = model.summary;
  if (s.pending === 0) return "Tudo pago este mês";
  const extra = s.awaitingValueCount > 0 ? ` + ${s.awaitingValueCount} ${plural(s.awaitingValueCount, "aguardando valor", "aguardando valor")}` : "";
  return `${s.pending} ${plural(s.pending, "item", "itens")} · ${fmt(s.pendingAmount)}${extra}`;
}

export function doneList(model) {
  return model.items
    .filter((i) => i.state === "done")
    .sort((a, b) => new Date(b.done.paidAt ?? 0) - new Date(a.done.paidAt ?? 0))
    .map((i) => ({ id: i.id, name: i.name, line: i.done.line, value: fmt(i.done.value), when: doneWhen(i), undo: i.undo }));
}

// Fase 9.1.2 — seção "Antes da próxima renda": obrigações de outra competência que vencem até a próxima renda.
export function beforeIncomeSection(model) {
  const b = model.beforeNextIncome;
  if (!b || !b.items.length) return null;
  const bits = [b.nextIncomeLabel ? `Vencem até ${b.nextIncomeLabel}` : "Vencem antes da próxima renda", b.knownTotal > 0 ? fmt(b.knownTotal) : null, b.unpricedCount ? `${b.unpricedCount} aguardando valor` : null].filter(Boolean);
  return { id: "before", type: "cards", title: "Antes da próxima renda", sub: bits.join(" · "), items: b.items.map(cardView) };
}

export function sectionsFor(tab, model) {
  const cards = model.items.map(cardView);
  const before = beforeIncomeSection(model);
  const s = model.summary;
  const est = casaMonthlyEstimate(model);
  if (tab === "mes") {
    const out = [{ id: "pending", type: "cards", title: "Precisa da sua atenção", sub: pendingSubtitle(model), items: cards.filter((c) => c.notDone) }];
    if (before) out.push(before);
    if (model.funded.length) out.push({ id: "funded", type: "funded", title: "Guardado para um destino", sub: "Não entra na contagem do mês", items: model.funded });
    const done = doneList(model);
    out.push({ id: "done", type: "done", title: "Concluídos", sub: `${s.resolved} de ${s.total} · ${fmt(s.paidAmount)}`, items: done });
    return out;
  }
  if (tab === "parc") {
    const out = [];
    if (model.relief && model.relief.milestones.length) out.push({ id: "relief", type: "relief", title: "Próximos alívios", sub: null, relief: model.relief });
    const pc = cards.filter((c) => c.item.kind === "parcela");
    out.push({ id: "parcelas", type: "cards", title: `${pc.length} ${plural(pc.length, "parcelamento ativo", "parcelamentos ativos")}`, sub: `${fmt(s.parcelRemainingTotal)} restantes no total`, items: pc });
    return out;
  }
  if (tab === "casa") {
    const cc = cards.filter((c) => c.item.kind === "casa");
    const out = [{ id: "casa", type: "cards", title: "Contas da casa", sub: `${s.casaResolved} de ${s.casaCount} resolvidas${s.casaCount ? ` · ${est.approximate ? "~" : ""}${fmt(est.value)} por mês` : ""}`, items: cc }];
    if (before) out.push(before);
    return out;
  }
  const rowOf = (c) => ({ key: c.id, name: c.name, sub: c.rowSub, value: c.item.kind === "casa" && c.item.awaitingValue ? "Aguardando valor" : c.valueTxt, status: c.done ? "Pago" : c.item.awaitingValue ? "Aguardando valor" : c.chipTone === "warn" && c.chip ? c.chip : "Pendente", tone: c.done ? "lime" : c.item.awaitingValue || (c.chipTone === "warn" && c.chip) ? "warn" : "soft", openable: !c.done, item: c.item });
  const groups = [];
  const p = cards.filter((c) => c.item.kind === "parcela");
  const h = cards.filter((c) => c.item.kind === "casa");
  const o = cards.filter((c) => c.item.kind === "compromisso");
  if (p.length) groups.push({ title: "Parcelamentos", sub: String(p.length), rows: p.map(rowOf) });
  if (h.length) groups.push({ title: "Contas da casa", sub: String(h.length), rows: h.map(rowOf) });
  if (before) groups.push({ title: "Antes da próxima renda", sub: String(before.items.length), rows: before.items.map(rowOf) });
  if (o.length) groups.push({ title: "Compromissos", sub: String(o.length), rows: o.map(rowOf) });
  if (model.funded.length) groups.push({ title: "Guardado", sub: String(model.funded.length), rows: model.funded.map((f) => ({ key: f.id, name: f.description, sub: f.dueDate ? "Dinheiro separado" : "Sem prazo definido", value: fmt(f.amount), status: "Dinheiro separado", tone: "ink", openable: true, funded: f })) });
  return [{ id: "todos", type: "list", groups }];
}

// ---- alívio: geometria do gráfico (SVG 1100x200) — sem números fixos de meses
export function reliefGeometry(relief) {
  const loads = relief.months.map((m) => m.committed);
  const n = loads.length;
  const maxL = Math.max(loads[0], 1);
  const yOf = (v) => 20 + (1 - v / maxL) * 180;
  const W = 1100 / n;
  let area = `M0,200 V${yOf(loads[0]).toFixed(1)}`;
  loads.forEach((v, i) => {
    if (i > 0) area += ` V${yOf(v).toFixed(1)}`;
    area += ` H${((i + 1) * W).toFixed(1)}`;
  });
  area += " V200 Z";
  const idx = new Map(relief.months.map((m, i) => [m.monthKey, i]));
  const marks = relief.milestones.map((ms) => {
    const k = idx.get(ms.monthKey);
    return { x: `${((k / n) * 100).toFixed(2)}%`, y: `${((yOf(loads[k - 1]) / 200) * 100).toFixed(2)}%`, amount: fmtS(ms.released) };
  });
  const every = Math.max(1, Math.ceil(n / 12));
  const axis = relief.months.map((m, i) => ({ label: i === 0 ? "AGORA" : m.labelShort, value: m.committed > 0 ? `R$ ${Math.round(m.committed).toLocaleString("pt-BR")}` : "zerado", strong: i === 0, show: i % every === 0 || i === n - 1 }));
  return { area, marks, axis, n, nowWidthPct: (100 / n).toFixed(3) };
}

export function milestoneText(ms) {
  const names = joinNames(ms.plans.map((p) => p.name));
  return `${names} ${ms.plans.length > 1 ? "terminam" : "termina"}`;
}
