// Fase 5.4B, item 52 — testes da FUNDAÇÃO VISUAL. Comportamento, não
// snapshot de markup (instrução explícita do pedido): nav config, contraste
// de cor medido de verdade, presença dos tokens semânticos, e o invariante
// NO_NEW_V1_CONSUMERS (item 4) — nenhum arquivo novo desta fase importa
// lib/indicators.js / lib/cashFlowProjection.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV_ITEMS, MOBILE_PRIMARY_ITEMS, MOBILE_MORE_ITEMS, isNavItemActive } from "../lib/navConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
function check(condition, label, extra = "") {
  if (condition) {
    passed++;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    failed++;
    console.error(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

console.log("--- Fase 5.4B: Design Foundation ---\n");

// ==========================================================================
// 1) Nav config — comportamento, não snapshot.
// ==========================================================================
// Fase 6.0 (Design Freeze) — NAV_ITEMS ganhou "Dados" (8ª rota) e "Fluxo"
// virou "Projeção" (nome final do design aprovado, mesma posição/papel) —
// mudança intencional desta fase, não um achado stale. "Mais" passa de 3
// pra 4 itens (Projeção/Histórico/Metas/Dados).
check(NAV_ITEMS.length === 8, "NAV_ITEMS tem as 8 rotas reais de hoje (Fase 6.0 — + Dados)", `${NAV_ITEMS.length}`);
check(NAV_ITEMS.every((i) => i.href && i.label && i.mobileLabel && i.icon), "todo NAV_ITEM tem href/label/mobileLabel/icon");
check(MOBILE_PRIMARY_ITEMS.length === 4, "item 24: exatamente 4 itens primários na bottom nav (Hoje/Cartão/Compromissos/Simular)", `${MOBILE_PRIMARY_ITEMS.length}`);
check(
  MOBILE_MORE_ITEMS.length === 4 && MOBILE_MORE_ITEMS.map((i) => i.key).join(",") === "projecao,historico,metas,dados",
  "Fase 6.0: Projeção/Histórico/Metas/Dados dentro de 'Mais'",
  MOBILE_MORE_ITEMS.map((i) => i.key).join(",")
);
check(
  MOBILE_PRIMARY_ITEMS.map((i) => i.key).join(",") === "home,cartoes,compromissos,simulador",
  "ordem da bottom nav é Hoje→Cartão→Compromissos→Simular"
);

check(isNavItemActive({ href: "/" }, "/"), "'/' ativo em '/'");
check(!isNavItemActive({ href: "/" }, "/cartoes"), "'/' NÃO ativo em '/cartoes' (nunca match por startsWith na home)");
check(isNavItemActive({ href: "/cartoes" }, "/cartoes"), "'/cartoes' ativo em '/cartoes'");
check(isNavItemActive({ href: "/cartoes" }, "/cartoes/algumacoisa"), "'/cartoes' ativo em sub-rota (startsWith)");
check(!isNavItemActive({ href: "/cartoes" }, "/contas-a-pagar"), "'/cartoes' NÃO ativo em outra rota");

// ==========================================================================
// 2) Presença dos tokens semânticos (globals.css) — não duplicado, não
//    apagado por engano.
// ==========================================================================
const css = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
const REQUIRED_TOKENS = [
  "--color-surface-1", "--color-surface-3", "--color-border-subtle",
  "--color-text-primary", "--color-text-secondary", "--color-text-muted",
  "--color-accent", "--color-accent-hover", "--color-accent-foreground",
  "--color-danger", "--color-restricted", "--color-hypothetical", "--color-focus-ring",
  "--radius-control", "--radius-card", "--radius-pill",
];
for (const token of REQUIRED_TOKENS) {
  check(css.includes(`${token}:`), `token semântico presente: ${token}`);
}
// Fase 6.0 (Design Freeze) — SUBSTITUI a checagem "token legado inalterado"
// da 5.4B. Esta fase é DELIBERADAMENTE um big-bang de identidade visual
// (aprovado no ZIP) — o princípio de "zero mudança de cor pra componente
// existente" da 5.4B foi conscientemente superado, não violado por engano.
// O que agora precisamos garantir é o INVERSO: os valores da identidade
// FINAL aprovada estão nos tokens certos (nunca hardcoded por 100
// componentes — item 7 do pedido geral) e não regridem de volta pro tema
// escuro antigo por acidente.
const FROZEN_PALETTE = [
  ["--color-bg", "#eff0f2"],
  ["--color-surface", "#ffffff"],
  ["--color-ink", "#0b0b0c"],
  ["--color-accent", "#c9ff29"],
  ["--color-text-primary", "#0b0b0c"],
  ["--color-text-secondary", "#565c63"],
  ["--color-text-muted", "#6e747b"],
];
for (const [token, value] of FROZEN_PALETTE) {
  check(css.includes(`${token}: ${value};`), `token da identidade final (Fase 6.0): ${token} = ${value}`);
}
check(!css.includes("color-scheme: dark"), "NUNCA regride pro dark mode antigo (color-scheme: light, single-theme)");
check(css.includes(".focus-ring") && css.includes(":focus-visible"), "sistema de foco (.focus-ring + :focus-visible) presente");
check(css.includes("prefers-reduced-motion"), "regra prefers-reduced-motion presente");
check(css.includes("env(safe-area-inset-bottom"), "safe-area-inset-bottom tratado (mobile nav)");

// ==========================================================================
// 3) Contraste WCAG — medido de verdade (não "parece legível").
// ==========================================================================
function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance([r, g, b]) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}
function contrast(hex1, hex2) {
  const l1 = luminance(hexToRgb(hex1));
  const l2 = luminance(hexToRgb(hex2));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}
const WCAG_AA_NORMAL = 4.5;
// Fase 6.0 (Design Freeze) — pares da identidade final aprovada (canvas
// off-white, ink quase-preto, lime accent). Medido de verdade, não "parece
// legível" — ver docs/design-tokens.md pro racional de cada par.
const CONTRAST_PAIRS = [
  ["text-primary/bg", "#0b0b0c", "#eff0f2"],
  ["text-primary/surface", "#0b0b0c", "#ffffff"],
  ["text-secondary/surface", "#565c63", "#ffffff"],
  ["text-muted/surface", "#6e747b", "#ffffff"],
  ["accent-foreground/accent", "#0b0b0c", "#c9ff29"],
  ["danger-text/danger-bg", "#5e3d0c", "#f6eee2"],
  ["restricted/surface", "#565c63", "#ffffff"],
  ["positive/surface", "#2e6f4e", "#ffffff"],
  ["white/ink", "#ffffff", "#0b0b0c"],
];
for (const [label, a, b] of CONTRAST_PAIRS) {
  const ratio = contrast(a, b);
  check(ratio >= WCAG_AA_NORMAL, `contraste WCAG AA (>=4.5:1): ${label}`, `${ratio.toFixed(2)}:1`);
}

// ==========================================================================
// 4/5) NO_NEW_V1_CONSUMERS + ONE_TRUTH_ONE_NAME — Fase 6.0 (Design Freeze)
// tocou praticamente toda `app/**` (retheme completo) — em vez de manter
// uma lista fixa de arquivos (que fica stale a cada fase e não pega os
// arquivos NOVOS de hoje: SpendableTodayCard/MoneyBridgeCard/Dados/etc),
// varre TODO `app/**/*.jsx` + os `lib/*.js` de apresentação/navegação de
// verdade. Mais forte que a versão anterior: garante o invariante pro app
// inteiro, não só pro recorte de uma fase específica.
// ==========================================================================
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx|js)$/.test(entry.name)) out.push(full);
  }
}
const jsxFiles = [];
walk(path.join(ROOT, "app"), jsxFiles);
jsxFiles.push(path.join(ROOT, "lib/navConfig.js"), path.join(ROOT, "lib/homePresentation.js"));

const V1_IMPORT_RE = /lib\/(indicators|cashFlowProjection|intelligence|alerts)(\.js)?["']/;
// Remove comentários antes de checar vocabulário — código legitimamente CITA
// "Caixa livre"/"Patrimônio disponível" em comentários explicando por que NÃO
// usar esses nomes (ver app/metas/page.js); só copy renderizada de verdade
// importa aqui (mesmo critério de test-home-presentation.mjs).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
let v1ImportViolations = 0;
let v1VocabViolations = 0;
for (const file of jsxFiles) {
  const content = fs.readFileSync(file, "utf8");
  const code = stripComments(content);
  if (V1_IMPORT_RE.test(content)) {
    v1ImportViolations++;
    console.error(`   ↳ importa lib V1: ${path.relative(ROOT, file)}`);
  }
  if (code.includes("Patrimônio disponível") || code.includes("Caixa livre")) {
    v1VocabViolations++;
    console.error(`   ↳ usa vocabulário V1: ${path.relative(ROOT, file)}`);
  }
}
check(v1ImportViolations === 0, `NO_NEW_V1_CONSUMERS: nenhum dos ${jsxFiles.length} arquivos de app/** importa lib V1`);
check(v1VocabViolations === 0, `ONE_TRUTH_ONE_NAME: nenhum dos ${jsxFiles.length} arquivos de app/** usa vocabulário V1`);

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
