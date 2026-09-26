// Fase 10 — UI da área Cartões v5, sem banco e sem DOM real: carrossel (setas/dots/teclado/swipe), foco de
// teclado em sliders, reduced motion, ordem mobile, veredito limite × orçamento, geometria dos gráficos,
// AUSÊNCIA de dados mock do protótipo, botões mortos e ações sem tratamento (varredura estática do JSX).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD_KEYS, STORAGE_KEY, clampIndex, stepIndex, directionOf, keyDelta, swipeDelta, resolveInitialCard, cardAnimClass,
  valueFromRatio, ratioOf, sliderKeyValue, purchaseVerdict, localAssessment, capacityCells, optionLabel,
  billSegments, limitSegments, futureRowBars, commitmentChart, chartAlt, reliefHeadline, dayBars, cajuRateFor, MODES, cajuFacts, itauFacts, dayMonthUpper, dmLabel,
} from "../app/components/v5/cartoesView.js";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const el = (tagName, role) => ({ tagName, getAttribute: (a) => (a === "role" ? role ?? null : null), isContentEditable: false });

// ---------- carrossel ----------
check("[CARROSSEL] dois cartões, Itaú primeiro; chave de storage estável", JSON.stringify(CARD_KEYS) === '["itau","caju"]' && STORAGE_KEY === "norte.cartoes.card");
check("[CARROSSEL] Itaú → Caju → Itaú (dá a volta, sem estourar índice)", stepIndex(0, 1) === 1 && stepIndex(1, 1) === 0 && stepIndex(0, -1) === 1 && stepIndex(1, -1) === 0 && clampIndex(-3, 2) === 1);
check("[CARROSSEL] direção da animação: avançar = +1, voltar = −1, mesmo cartão = 0 (fade neutro)", directionOf(0, 1) === 1 && directionOf(1, 0) === -1 && directionOf(1, 1) === 0);
check("[SETAS] com um cartão só o índice não muda", stepIndex(0, 1, 1) === 0 && stepIndex(0, -1, 1) === 0);
check("[TECLADO] → avança e ← volta quando o foco está no corpo/botão", keyDelta("ArrowRight", el("BODY")) === 1 && keyDelta("ArrowLeft", el("BUTTON")) === -1);
check("[TECLADO] ← → NÃO trocam de cartão em input, textarea, select nem slider (as setas ajustam o valor)", ["INPUT", "TEXTAREA", "SELECT"].every((t) => keyDelta("ArrowRight", el(t)) === 0) && keyDelta("ArrowLeft", el("DIV", "slider")) === 0);
check("[TECLADO] outras teclas são ignoradas", keyDelta("ArrowUp", el("BODY")) === 0 && keyDelta("Enter", el("BODY")) === 0);
check("[SWIPE] arrastar para a esquerda (dx<0) = próximo; para a direita = anterior", swipeDelta(-80, 5) === 1 && swipeDelta(80, -5) === -1);
check("[SWIPE] gesto curto (< 40px) ou mais vertical que horizontal é ignorado (não atrapalha a rolagem)", swipeDelta(-30, 0) === 0 && swipeDelta(-60, 90) === 0 && swipeDelta(0, 0) === 0);
check("[ESTADO] seleção inicial: query vence storage; storage vence o padrão; inválido volta ao Itaú", resolveInitialCard({ query: "caju", stored: "itau" }) === 1 && resolveInitialCard({ query: null, stored: "caju" }) === 1 && resolveInitialCard({ query: "x", stored: "y" }) === 0 && resolveInitialCard({}) === 0);
check("[REDUCED MOTION] sem animação de cartão quando prefers-reduced-motion; com movimento: slide direcional", cardAnimClass(1, true) === "" && cardAnimClass(-1, true) === "" && cardAnimClass(1, false) === "n5-card-r" && cardAnimClass(-1, false) === "n5-card-l" && cardAnimClass(0, false) === "n5-card-in");

// ---------- slider ----------
check("[SLIDER] posição → valor respeita min/max/step e nunca sai da faixa", valueFromRatio(0, 50, 4020, 10) === 50 && valueFromRatio(1, 50, 4020, 10) === 4020 && valueFromRatio(-2, 50, 4020, 10) === 50 && valueFromRatio(9, 50, 4020, 10) === 4020 && valueFromRatio(0.5, 0, 400, 10) === 200);
check("[SLIDER] valor → posição sempre em [0,1] (faixa degenerada não gera NaN)", ratioOf(50, 50, 4020) === 0 && ratioOf(4020, 50, 4020) === 1 && ratioOf(5, 5, 5) === 0 && ratioOf(999, 0, 400) === 1);
check("[SLIDER] teclado: ← → ±step, PgUp/PgDn ±10 passos, Home/End nos extremos, limitado à faixa", sliderKeyValue("ArrowRight", 100, 0, 400, 10) === 110 && sliderKeyValue("ArrowLeft", 0, 0, 400, 10) === 0 && sliderKeyValue("PageUp", 100, 0, 400, 10) === 200 && sliderKeyValue("PageDown", 50, 0, 400, 10) === 0 && sliderKeyValue("Home", 100, 0, 400, 10) === 0 && sliderKeyValue("End", 100, 0, 400, 10) === 400 && sliderKeyValue("Enter", 100, 0, 400, 10) === 100);

// ---------- compra: limite × orçamento ----------
const limit = { low: 1580, high: 1880, ceiling: 3080 };
const caps = { 1: 292, 2: 585, 3: 877, 6: 1755, 10: 2926 };
const A = (amount, n) => localAssessment({ amount, n, limit, caps });
const V = (amount, n) => { const a = A(amount, n); return purchaseVerdict({ cardStatus: a.capacity.status, budgetOk: a.budgetOk, amount, n, capacity: a.capacity, budgetCap: a.budgetCap ?? 0 }); };
check("[VEREDITO] cabe no limite E no orçamento: 'Deve passar no cartão e cabe no orçamento.' (tom lime)", V(200, 3).verdict === "Deve passar no cartão e cabe no orçamento." && V(200, 3).tone === "#C9FF29");
check("[VEREDITO] cabe no limite mas NÃO no orçamento: as duas perguntas são respondidas separadamente", V(1500, 1).verdict === "Deve passar no cartão, mas aperta o orçamento." && /acima do que o seu orçamento aguenta/.test(V(1500, 1).reason));
check("[VEREDITO] limite incerto: nunca afirma 'passa'; diz 'limite não reconciliado'", V(1700, 10).verdict === "Pode passar no cartão — limite não reconciliado." && !/^Passa/.test(V(1700, 10).verdict));
check("[VEREDITO] limite improvável / impossível: 'Provavelmente não passa' e 'Não cabe no limite' (com o teto certo)", /Provavelmente não passa/.test(V(2500, 10).verdict) && V(3200, 10).verdict === "Não cabe no limite." && /R\$ 3\.080,00/.test(V(3200, 10).reason));
check("[VEREDITO] orçamento é decidido pelo TETO do motor por parcelamento: no limite do teto cabe, 1 real acima não", A(877, 3).budgetOk === true && A(878, 3).budgetOk === false);
check("[VEREDITO] sem tetos carregados (motor ainda calculando): orçamento 'pendente' (null), nunca um sim/não inventado", A(500, 3).budgetOk !== null && localAssessment({ amount: 500, n: 3, limit, caps: null }).budgetOk === null);
const cells = capacityCells({ options: [1, 2, 3, 6, 10], caps, limit });
check("[TABELA] capacidade por parcelamento vem dos tetos calculados; 10x limitado pelo teto do cartão (2.926 → 3.080? não: 2.926 < 3.080)", cells.map((c) => c.cap).join() === "292,585,877,1755,2926" && cells.every((c) => !c.limitedByCard));
check("[TABELA] teto de orçamento acima do teto do cartão é limitado por ele e marcado", capacityCells({ options: [10], caps: { 10: 5000 }, limit })[0].cap === 3080 && capacityCells({ options: [10], caps: { 10: 5000 }, limit })[0].limitedByCard === true);
check("[TABELA] rótulos: 'À vista', 2x, 3x, 6x, 10x", [1, 2, 3, 6, 10].map(optionLabel).join() === "À vista,2x,3x,6x,10x");

// ---------- Itaú: barras e gráfico ----------
const bill = { total: 1616.54, installments: 119.77, purchases: 840.63, unknownDetail: 656.14 };
const seg = billSegments(bill);
check("[FATURA] segmentos parcelas + compras + sem detalhamento somam 100% e o 'sem detalhamento' aparece com o valor do gap", Math.abs(seg.reduce((a, s) => a + s.pct, 0) - 100) < 0.01 && seg.find((s) => s.key === "unknown").value === 656.14);
check("[FATURA] sem gap não desenha a barra hachurada (nada inventado)", billSegments({ total: 100, installments: 100, purchases: 0, unknownDetail: 0 }).length === 1);
const ls = limitSegments({ total: 4027, knownCommitted: 1918.11, estimate: { low: 1033.74, high: 1689.88 } });
check("[LIMITE] barra: comprometido conhecido + estimado não reconciliado + livre mínimo = 100% do limite", Math.abs(ls.reduce((a, s) => a + s.pct, 0) - 100) < 0.01 && ls.map((s) => s.key).join() === "known,uncertain,free");
const series = [{ label: "HOJE", committed: 1918.11 }, { label: "OUT", committed: 301.57 }, { label: "NOV", committed: 181.8 }, { label: "FEV", committed: 0 }];
const chart = commitmentChart(series, 4027);
check("[GRÁFICO] geometria determinística sem NaN/Infinity, degraus por ponto, viewBox 800×200", !/NaN|Infinity/.test(JSON.stringify(chart)) && chart.points.length === 4 && chart.line.startsWith("M0,") && chart.area.endsWith("Z"));
check("[GRÁFICO] série vazia ou limite 0 não quebra", !/NaN|Infinity/.test(JSON.stringify(commitmentChart([{ label: "HOJE", committed: 0 }], 0))));
check("[GRÁFICO] texto equivalente para leitor de tela (acessibilidade)", /Comprometimento conhecido do limite de R\$ 4\.027,00: HOJE R\$ 1\.918,11, OUT R\$ 301,57/.test(chartAlt(series, 4027)));
check("[FUTURO] barra por mês em escala do maior total; mês livre tem largura 0", futureRowBars({ installmentAmount: 60, purchasesAmount: 0, unknownDetailAmount: 0 }, 120).wInst === 50 && futureRowBars({ installmentAmount: 0, purchasesAmount: 0, unknownDetailAmount: 0 }, 0).wInst === 0);
check("[ALÍVIO] texto real (meses do calendário, nunca '+7 rendas'); estado vazio honesto", /^Em dezembro as parcelas caem para R\$ 60,60\/mês\.$/.test(reliefHeadline({ hasInstallments: true, monthlyNow: 119.77, next: { monthLong: "dezembro", after: 60.6 }, zero: { monthLong: "março" }, endingBeforeZero: 2 }).title) && reliefHeadline({ hasInstallments: false }).title === "O cartão está sem parcelas em andamento." && !/rendas/.test(reliefHeadline({ hasInstallments: true, monthlyNow: 100, next: { monthLong: "maio", after: 50 }, endingBeforeZero: 1 }).body));

// ---------- Caju ----------
const caju = { balance: 1261, pacing: { daysLeft: 25, modes: { eq: { daily: 50.44, note: "n" }, save: { daily: 45.4, note: "s" }, wk: { note: "w" } } }, recharge: { nextLabel: "21/10" }, weekend: { available: true, weekendDays: 2 }, facts: { rechargeDay: 21, rechargeAmount: 1300, daysLeft: 25 } };
check("[CAJU] ritmo por modo: equilibrado, guardar e fim de semana com a MESMA regra testada (slider recalcula na hora)", cajuRateFor({ caju, mode: "eq", weekendReserve: 0 }).daily === 50.44 && cajuRateFor({ caju, mode: "save", weekendReserve: 0 }).daily === 45.4 && cajuRateFor({ caju, mode: "wk", weekendReserve: 200 }).daily === 46.13 && cajuRateFor({ caju, mode: "wk", weekendReserve: 200 }).note === "nos outros 23 dias");
check("[CAJU] reserva do FDS = 0 e reserva > saldo (limitada ao saldo)", cajuRateFor({ caju, mode: "wk", weekendReserve: 0 }).daily === 54.83 && cajuRateFor({ caju, mode: "wk", weekendReserve: 99999 }).daily === 0);
check("[CAJU] três modos disponíveis e nomeados", MODES.map((m) => m.key).join() === "eq,save,wk" && MODES.every((m) => m.label && m.short));
check("[CAJU] fatos do cartão: recarga dia 21, R$ 1.300, faltam 25 dias (valores da regra)", JSON.stringify(cajuFacts(caju)) === JSON.stringify([{ k: "Recarga", v: "dia 21" }, { k: "Valor", v: "R$ 1.300" }, { k: "Faltam", v: "25 dias" }]));
check("[CAJU] barras do ciclo: dias passados, hoje e futuros somam o comprimento do ciclo", dayBars({ length: 30, elapsed: 5 }).length === 30 && dayBars({ length: 30, elapsed: 5 }).filter((d) => d.state === "past").length === 5 && dayBars({ length: 30, elapsed: 5 })[5].state === "today" && dayBars(null).length === 0);
check("[FATOS ITAÚ] fecha, vence e faltam vêm do modelo (nunca datas fixas)", JSON.stringify(itauFacts({ currentBill: { closesAt: "2026-10-04", dueAt: "2026-10-11", daysToDue: 15 } })) === JSON.stringify([{ k: "Fecha", v: "04 out" }, { k: "Vence", v: "11 out" }, { k: "Faltam", v: "15 dias" }]) && dayMonthUpper("2026-09-21") === "21 SET" && dmLabel("2026-10-04") === "04/10");

// ---------- estático: ordem mobile, reduced motion, mock, botões mortos ----------
const css = read("app/components/v5/v5.css");
const itauBody = read("app/components/v5/ItauBody.jsx");
check("[MOBILE] ordem do v5: faturas futuras → PARCELAMENTOS → SIMULAR COMPRA (order no container compacto); desktop: simulação → parcelamentos", /@container n5 \(max-width: 640px\)[\s\S]*\.n5-flow > \.n5-o-inst \{ order: 1; \}[\s\S]*\.n5-flow > \.n5-o-sim \{ order: 2; \}/.test(css) && itauBody.indexOf("n5-o-sim") < itauBody.indexOf("n5-o-inst"));
check("[MOBILE] gráfico de desktop escondido no compacto (sem gráfico espremido) e simulador dark próprio", /n5-hide-compact/.test(itauBody) && /\.n5-hide-compact \{ display: none !important; \}/.test(css) && /n5-only-compact/.test(read("app/components/v5/PurchaseSimulator.jsx")));
check("[REDUCED MOTION] CSS zera animações e transições sob prefers-reduced-motion", /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.001ms !important[\s\S]*transition-duration: 0\.001ms !important/.test(css) && /prefers-reduced-motion: reduce/.test(read("app/components/v5/CartoesV5.jsx")));
check("[ACESSIBILIDADE] foco visível, alvos ≥ 44px nos controles (setas, pills, opções, modos), sliders com role/aria e teclado", /focus-visible/.test(css) && /\.n5-arrow \{ width: 44px; height: 44px;/.test(css) && /\.n5-opt \{[^}]*min-height: 44px/.test(css) && /\.n5-mode \{[^}]*min-height: 44px/.test(css) && /\.n5-pill \{[^}]*min-height: 44px/.test(css) && /role="slider"/.test(read("app/components/v5/Slider.jsx")) && /aria-valuenow/.test(read("app/components/v5/Slider.jsx")) && /onKeyDown/.test(read("app/components/v5/Slider.jsx")));
check("[ACESSIBILIDADE] setas com rótulo, abas com aria-selected, opções com radiogroup", /aria-label="Cartão anterior"/.test(read("app/components/v5/CardStage.jsx")) && /aria-label="Próximo cartão"/.test(read("app/components/v5/CardStage.jsx")) && /aria-selected/.test(read("app/components/v5/CardStage.jsx")) && /role="radiogroup"/.test(read("app/components/v5/PurchaseSimulator.jsx")));

const V5_FILES = fs.readdirSync(path.join(ROOT, "app/components/v5")).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => `app/components/v5/${f}`);
const SOURCES = [...V5_FILES, "app/cartoes/page.js", "lib/cardsItau.js", "lib/cardsItauPure.js", "lib/cardsCaju.js", "lib/vaPacing.js", "lib/cardPurchaseCapacity.js", "lib/cardsArea.js", "app/api/cartoes/route.js", "app/api/cartoes/capacidade/route.js"];
const MOCK = ["Tênis de corrida", "Passagem aérea", "Fone de ouvido", "RICARDO CARDOSO", "5412", "4821", "08/29", "318,40", "1.402,21", "1.294,69", "1.115,77", "2.732,31", "Padaria Estrela", "Mercado Dia", "Restaurante Sabor", "Hortifruti", "EXEMPLO", "budgetCap = {", "Fora do escopo desta rodada", "(mock)", "Rick"];
const withoutComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const hits = [];
for (const f of SOURCES) { const t = withoutComments(read(f)); for (const s of MOCK) if (t.includes(s)) hits.push(`${f}: ${s}`); }
check("[SEM MOCK] nenhuma string/valor do protótipo (compras, parcelas, nomes, saldos, capacidades fixas, EXEMPLO) no código de produção", hits.length === 0, hits.join(" | "));
check("[SEM MOCK] o veredito de orçamento não usa tabela fixa (1x=700…): vem de caps do motor", !/700|900|1350/.test(withoutComments(read("app/components/v5/PurchaseSimulator.jsx")).replace(/rgba\([^)]*\)/g, "")) && /computeBudgetCaps/.test(read("app/api/cartoes/capacidade/route.js")));

// botões mortos: todo <button> precisa de onClick (ou ser de formulário)
const dead = [];
let buttons = 0;
for (const f of V5_FILES.filter((x) => x.endsWith(".jsx"))) {
  const t = read(f);
  for (const m of t.matchAll(/<button\b([\s\S]*?)(?<!=)>/g)) { buttons++; if (!/onClick=/.test(m[1])) dead.push(`${f}: ${m[1].slice(0, 60).replace(/\s+/g, " ")}`); }
}
check("[BOTÕES] nenhum botão morto: todo <button> tem onClick", dead.length === 0 && buttons >= 10, `${buttons} botões; mortos: ${dead.join(" | ")}`);
const linksBad = [];
for (const f of V5_FILES.filter((x) => x.endsWith(".jsx"))) for (const m of read(f).matchAll(/<Link\b([\s\S]*?)(?<!=)>/g)) if (!/href=/.test(m[1])) linksBad.push(f);
check("[LINKS] todo <Link> tem href real; o de simulação aponta para /simulador (rota existente)", linksBad.length === 0 && /href="\/simulador"/.test(read("app/components/v5/PurchaseSimulator.jsx")) && fs.existsSync(path.join(ROOT, "app/simulador/page.js")));
check("[AÇÕES] as ações do usuário têm tratamento: setas/dots/teclado/swipe → onGo/onPick; sliders → onChange; opções → setN; modos → onMode; tentar de novo → loadCaps/load", /onGo/.test(read("app/components/v5/CardStage.jsx")) && /onPick/.test(read("app/components/v5/CardStage.jsx")) && /setN\(/.test(read("app/components/v5/PurchaseSimulator.jsx")) && /onMode/.test(read("app/components/v5/CajuBody.jsx")) && /loadCaps/.test(read("app/components/v5/PurchaseSimulator.jsx")) && /keyDelta/.test(read("app/components/v5/CartoesV5.jsx")));
check("[GET] rotas de leitura da área não exportam POST/PUT/PATCH/DELETE (POST só da simulação, sem escrita)", !/export async function (PUT|PATCH|DELETE)/.test(read("app/api/cartoes/route.js")) && !/export async function POST/.test(read("app/api/cartoes/route.js")) && !/prisma\.\w+\.(create|update|delete|upsert)/.test(read("app/api/cartoes/capacidade/route.js")));
check("[LEITURA] módulos de read-model não contêm escrita (create/update/delete/upsert/$transaction)", SOURCES.filter((f) => f.startsWith("lib/")).every((f) => !/\.(create|update|updateMany|delete|deleteMany|upsert)\(|\$transaction/.test(withoutComments(read(f)))));
check("[VISUAL v5] paleta #EFF0F2/#0B0B0C/#C9FF29 e fontes Geist preservadas; container queries (sem overflow)", /#c9ff29/i.test(css) && /#0b0b0c/i.test(css) && /Geist/.test(css) && /@container n5/.test(css) && /container-type: inline-size/.test(css));

console.log(`\n${pass}/${pass + fail} teste(s) passaram.`);
process.exit(fail ? 1 : 0);
