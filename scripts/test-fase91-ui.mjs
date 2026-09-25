// Fase 9.1 — UI PURA (sem banco, sem DOM real): view-models de Compromissos, celebração (som, confete,
// vibração, prefers-reduced-motion, preferência persistida), formatação e mapeamento de erros de domínio → HTTP.
import { readSoundPref, writeSoundPref, prefersReducedMotion, playChime, celebrate, primeAudio, burstConfetti, SOUND_STORAGE_KEY } from "../app/components/v4/celebrate.js";
import { cardView, sheetItemFor, fundedSheetItem, tabsFor, sectionsFor, milestoneText, reliefGeometry } from "../app/components/v4/compromissosView.js";
import { fmt, parseBR } from "../app/components/v4/format.js";
import { DomainError, domainErrorStatus, DOMAIN_ERROR_STATUS } from "../lib/domainErrors.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---------- ambiente falso
const memStorage = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; };
const throwingStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
function fakeWin({ reduced = false, audio = true } = {}) {
  const log = { osc: 0, ctx: 0, resumed: 0 };
  class AC {
    constructor() { log.ctx++; this.state = "suspended"; this.currentTime = 0; this.destination = {}; }
    resume() { log.resumed++; this.state = "running"; }
    createOscillator() { log.osc++; return { type: "", frequency: {}, connect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const win = { matchMedia: (q) => ({ matches: reduced && /reduce/.test(q) }) };
  if (audio) win.AudioContext = AC;
  return { win, log };
}
function fakeDoc() {
  const nodes = [];
  return { nodes, createElement: () => { const el = { style: {}, setAttribute() {}, remove() { el.removed = true; }, animate: () => ({}) }; return el; }, body: { appendChild: (e) => nodes.push(e) } };
}
const rect = { left: 100, top: 100, width: 80, height: 40 };

// ---------- [SOM] preferência persistida
check("[SOM] padrão: ligado (sem valor guardado)", readSoundPref(memStorage()) === true);
{
  const st = memStorage();
  writeSoundPref(st, false);
  check("[SOM] desligar persiste 'off' na chave norte.sound", st._m[SOUND_STORAGE_KEY] === "off" && readSoundPref(st) === false);
  writeSoundPref(st, true);
  check("[SOM] religar persiste 'on'", readSoundPref(st) === true);
}
check("[SOM] storage bloqueado nunca quebra (lê ligado, escreve sem exceção)", readSoundPref(throwingStorage) === true && (writeSoundPref(throwingStorage, false), true));
check("[SOM] storage ausente nunca quebra", readSoundPref(null) === true);

// ---------- [CELEBRAÇÃO]
{
  const { win, log } = fakeWin();
  const doc = fakeDoc();
  const nav = { vibrate: () => true };
  const r = celebrate({ rect, env: { window: win, document: doc, navigator: nav, storage: memStorage() }, audioState: {} });
  check("[CELEBRAÇÃO] com som ligado: toca 2 tons, vibra e solta 18 peças de confete", r.sound === true && log.osc === 2 && r.vibrate === true && r.confetti === 18 && doc.nodes.length === 18, JSON.stringify(r));
}
{
  const { win, log } = fakeWin();
  const r = celebrate({ rect, env: { window: win, document: fakeDoc(), navigator: {}, storage: memStorage({ [SOUND_STORAGE_KEY]: "off" }) }, audioState: {} });
  check("[CELEBRAÇÃO] som desligado: NENHUM oscilador criado (mas confete segue)", r.sound === false && log.osc === 0 && log.ctx === 0 && r.confetti === 18);
}
{
  const { win } = fakeWin({ reduced: true });
  const doc = fakeDoc();
  const r = celebrate({ rect, env: { window: win, document: doc, navigator: {}, storage: memStorage() }, audioState: {} });
  check("[REDUCED-MOTION] prefers-reduced-motion: ZERO confete/animação (som segue a preferência própria)", r.confetti === 0 && doc.nodes.length === 0 && prefersReducedMotion(win) === true);
}
check("[REDUCED-MOTION] sem matchMedia: assume movimento normal, não quebra", prefersReducedMotion({}) === false && prefersReducedMotion(undefined) === false);
{
  const r = celebrate({ rect, env: { window: {}, document: fakeDoc(), navigator: undefined, storage: memStorage() }, audioState: {} });
  check("[CELEBRAÇÃO] sem AudioContext/vibrate: degrada em silêncio, sem exceção", r.sound === false && r.vibrate === false);
}
check("[CELEBRAÇÃO] confete sem retângulo/documento é no-op", burstConfetti(null, rect) === 0 && burstConfetti(fakeDoc(), null) === 0);
{
  const { win, log } = fakeWin();
  const st = {};
  const ok1 = primeAudio({ win, storage: memStorage(), audioState: st });
  const ok2 = primeAudio({ win, storage: memStorage(), audioState: st });
  check("[CELEBRAÇÃO] primeAudio cria UM AudioContext (reutilizado) e o retoma no gesto do clique", ok1 && ok2 && log.ctx === 1 && st.ac.state === "running" && log.osc === 0);
  const off = primeAudio({ win: fakeWin().win, storage: memStorage({ [SOUND_STORAGE_KEY]: "off" }), audioState: {} });
  check("[SOM] primeAudio respeita 'som desligado' (não cria contexto)", off === false);
  playChime(win, st);
  check("[CELEBRAÇÃO] chime reutiliza o contexto já criado", log.ctx === 1 && log.osc === 2);
}

// ---------- [VIEW] cartões
const parcela = { id: "parc:1", kind: "parcela", kindLabel: "Parcelamento", name: "Impressora 3D", to: "Mãe", note: null, state: "pending", awaitingValue: false, overdue: false, value: 297.9, parcela: { planId: "p", installmentId: "i", current: 7, total: 10, paidCount: 6, remainingCount: 4, remainingAmount: 1191.6, isLast: false }, pay: { kind: "installment", installmentId: "i" }, undo: null, done: null };
{
  const v = cardView(parcela);
  const filled = v.segs.filter((s) => s.bg === "#0B0B0C").length;
  check("[VIEW] impressora 3D: 'Parcela 7 de 10', '6 de 10 pagas', 10 segmentos (6 preenchidos, 1 atual)", v.detail === "Parcela 7 de 10" && v.progressTxt === "6 de 10 pagas" && v.segs.length === 10 && filled === 6 && v.segs[6].bg === "transparent", JSON.stringify([v.detail, v.progressTxt, v.segs.length, filled]));
  check("[VIEW] restante e CTA reais", v.restTxt === "R$ 1.191,60 restantes" && v.cta === "Marcar como paga" && v.to === "Pagamento para Mãe");
}
{
  const last = cardView({ ...parcela, name: "Psiquiatra", parcela: { ...parcela.parcela, current: 2, total: 2, paidCount: 1, remainingAmount: 200, isLast: true } });
  check("[VIEW] última parcela recebe o chip 'Última parcela'", last.chip === "Última parcela");
  const done = cardView({ ...parcela, state: "done", done: { when: "Hoje", sourceName: "Itaú", value: 297.9 }, parcela: { ...parcela.parcela, paidCount: 7 } });
  check("[VIEW] parcela paga: 7 preenchidos, próximo segmento fica lime só na parcela recém-paga", done.done && done.segs.filter((s) => s.bg === "#0B0B0C").length === 6 && done.segs[6].bg === "#C9FF29" && /Paga · Hoje · Itaú/.test(done.doneTxt), JSON.stringify(done.doneTxt));
}
const energia = { id: "casa:e", kind: "casa", kindLabel: "Conta da casa", name: "Energia", to: null, note: null, state: "pending", awaitingValue: true, overdue: false, value: null, casa: { ruleId: "r", cycleMonth: "2026-09", part: 1, partsTotal: 1, partsPaid: 0, amountKind: "VARIABLE", cadence: "MONTHLY", defaultAccountId: "a", dueDay: null, dueDate: null, referenceMin: 400, referenceMax: 450, monthlyTotal: 0, remainingAmount: 0, lastPaid: null }, pay: { kind: "house", ruleId: "r", cycleMonth: "2026-09", part: 1 }, undo: null, done: null };
{
  const v = cardView(energia);
  check("[VIEW] energia: 'Aguardando valor' (sem valor inventado), chip de atenção, CTA 'Informar valor e pagar'", v.valueTxt === "Aguardando valor" && v.chip === "Aguardando valor" && v.cta === "Informar valor e pagar" && v.valueFaint === true && /normal ~?R\$ 400/.test(v.sub) && !/482/.test(JSON.stringify(v)), JSON.stringify(v.sub));
  const s = sheetItemFor(energia);
  check("[VIEW] folha da energia exige valor e não pré-preenche", s.needsValue === true && s.title === "Informar e pagar" && s.value === 0);
}
const faxina = { ...energia, id: "casa:f", name: "Faxina", awaitingValue: false, value: 130, casa: { ...energia.casa, part: 2, partsTotal: 2, partsPaid: 1, amountKind: "FIXED", cadence: "BIWEEKLY", referenceMin: null, referenceMax: null, monthlyTotal: 260, remainingAmount: 130 }, pay: { kind: "house", ruleId: "r", cycleMonth: "2026-09", part: 2 } };
{
  const v = cardView(faxina);
  check("[VIEW] faxina 1 de 2: 'por mês · quinzenal', '1 de 2 visitas pagas', falta R$ 130,00, CTA da 2ª visita", /quinzenal/.test(v.detail) && v.progressTxt === "1 de 2 visitas pagas" && v.restTxt === "Falta R$ 130,00" && /^Pagar 2ª visita/.test(v.cta) && v.valueTxt === "R$ 260,00", JSON.stringify([v.detail, v.progressTxt, v.restTxt, v.cta]));
  const closed = cardView({ ...faxina, state: "done", done: { when: "Hoje", sourceName: "Dinheiro", value: 130 }, casa: { ...faxina.casa, partsPaid: 2 } });
  check("[VIEW] faxina 2 de 2: '2 de 2', mês fechado", closed.progressTxt === "2 de 2 visitas pagas" && closed.restTxt === "Mês fechado");
}
{
  const aluguel = { ...energia, id: "casa:a", name: "Aluguel", awaitingValue: false, overdue: true, value: 1000, casa: { ...energia.casa, amountKind: "FIXED", dueDay: 5, referenceMin: null, referenceMax: null } };
  check("[VIEW] aluguel vencido dia 5 mostra 'Venceu dia 5' (só quando o dia é conhecido)", cardView(aluguel).chip === "Venceu dia 5" && cardView({ ...aluguel, casa: { ...aluguel.casa, dueDay: null } }).chip !== "Venceu dia null");
  const net = cardView({ ...aluguel, overdue: true, casa: { ...aluguel.casa, dueDay: null } });
  check("[VIEW] vencimento desconhecido nunca vira 'Venceu…'", !/Venceu/.test(net.chip ?? ""));
}
{
  const f = fundedSheetItem({ id: "c", description: "Devolver valor restante ao CNPJ", amount: 1335, settlementMode: "EXTERNAL_TRANSFER", pay: { kind: "commitment", commitmentId: "c" } });
  check("[VIEW] CNPJ: 'Marcar como devolvido', devolução de capital (não é despesa), confirmar devolução", f.title === "Marcar como devolvido" && /não é despesa/.test(f.detail) && f.confirmLabel === "Confirmar devolução" && f.value === 1335);
}

// ---------- [VIEW] abas e seções
const model = { summary: { total: 3, resolved: 0, pending: 3, paidAmount: 0, pendingAmount: 428, parcelCount: 1, parcelRemainingTotal: 1191.6, casaCount: 2, casaResolved: 0, casaMonthly: 390 }, items: [parcela, energia, faxina], funded: [{ id: "f", description: "CNPJ", amount: 1335, settlementMode: "EXTERNAL_TRANSFER", dueDate: null, pay: {} }], accounts: [], relief: null };
{
  const tabs = tabsFor(model);
  check("[VIEW] 4 abas: Este mês, Parcelamentos, Contas da casa, Todos, com contagens reais", tabs.map((t) => t.key).join() === "mes,parc,casa,todos" && tabs[1].count === 1 && tabs[2].count === 2 && tabs[3].count === 4, JSON.stringify(tabs.map((t) => [t.key, t.count])));
  const mes = sectionsFor("mes", model);
  check("[VIEW] 'Este mês': pendentes + guardado (CNPJ separado) + concluídos", mes[0].id === "pending" && mes[0].items.length === 3 && mes.some((s) => s.id === "funded") && mes.some((s) => s.id === "done"));
  check("[VIEW] CNPJ FUNDED não entra nos pendentes do mês", !mes[0].items.some((c) => /CNPJ/.test(c.name)));
}

// ---------- [ALÍVIO] linha do tempo
check("[ALÍVIO] milestoneText usa nomes reais e valor liberado", /Tênis da mãe/.test(milestoneText({ label: "OUT/26", released: 256, plans: [{ id: "1", name: "Tênis da mãe" }], after: 1216.09 })), milestoneText({ label: "OUT/26", released: 256, plans: [{ id: "1", name: "Tênis da mãe" }], after: 1216.09 }));
{
  const geo = reliefGeometry({ months: [{ monthKey: "2026-09", labelShort: "SET/26", committed: 1472.09 }, { monthKey: "2026-10", labelShort: "OUT/26", committed: 1216.09 }, { monthKey: "2026-11", labelShort: "NOV/26", committed: 0 }], milestones: [], todayMonthly: 1472.09, zeroMonth: null });
  check("[ALÍVIO] geometria não produz NaN/Infinity (inclusive mês zerado)", !/NaN|Infinity/.test(JSON.stringify(geo)));
}

// ---------- [FORMAT]
check("[FORMAT] fmt pt-BR", fmt(1191.6) === "R$ 1.191,60" && fmt(0) === "R$ 0,00");
check("[FORMAT] parseBR aceita '431,20', '1.234,56', '1234.56'; lixo/zero/negativo → 0 (mantém o botão bloqueado)", parseBR("431,20") === 431.2 && parseBR("1.234,56") === 1234.56 && parseBR("1234.56") === 1234.56 && parseBR("abc") === 0 && parseBR("") === 0 && parseBR("-5") === 0 && parseBR("0") === 0);

// ---------- [ERROS] mapeamento domínio → HTTP (rotas de pagar/desfazer)
check("[ERROS] códigos de domínio mapeiam para HTTP correto", domainErrorStatus(new DomainError("INVALID", "x")) === 400 && domainErrorStatus(new DomainError("NOT_FOUND", "x")) === 404 && domainErrorStatus(new DomainError("ALREADY_PAID", "x")) === 409 && domainErrorStatus(new DomainError("STALE", "x")) === 409 && domainErrorStatus(new DomainError("INSUFFICIENT_FUNDS", "x")) === 422 && domainErrorStatus(new DomainError("OUT_OF_ORDER", "x")) === 422 && domainErrorStatus(new DomainError("NOT_PAID", "x")) === 409);
check("[ERROS] erro desconhecido NÃO vira 4xx de domínio (fica 500)", (domainErrorStatus(new Error("boom")) ?? 500) === 500 && Object.keys(DOMAIN_ERROR_STATUS).length >= 7);

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail ? 1 : 0);
