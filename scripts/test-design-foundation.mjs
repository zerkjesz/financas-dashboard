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
// Fase 5.4D, item 6 — NAV_ITEMS cresceu de 5 pra 7 rotas reais (Compromissos/
// Fluxo/Histórico), e "Mais" passou de 1 item (só Metas) pra 3 (Fluxo/
// Histórico/Metas) — mudança intencional e aprovada desta fase, não um
// achado stale. Asserções abaixo atualizadas pra refletir a nav real de
// agora (nunca reintroduzir a contagem antiga da 5.4B como se fosse bug).
check(NAV_ITEMS.length === 7, "NAV_ITEMS tem as 7 rotas reais de hoje (Fase 5.4D)", `${NAV_ITEMS.length}`);
check(NAV_ITEMS.every((i) => i.href && i.label && i.mobileLabel && i.icon), "todo NAV_ITEM tem href/label/mobileLabel/icon");
check(MOBILE_PRIMARY_ITEMS.length === 4, "item 24: exatamente 4 itens primários na bottom nav (Hoje/Cartão/Compromissos/Simular)", `${MOBILE_PRIMARY_ITEMS.length}`);
check(
  MOBILE_MORE_ITEMS.length === 3 && MOBILE_MORE_ITEMS.map((i) => i.key).join(",") === "fluxo,historico,metas",
  "Fase 5.4D: Fluxo/Histórico/Metas dentro de 'Mais'"
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
// Tokens LEGADOS preservados com o MESMO valor (item 33 — zero mudança de
// cor pra componente existente).
const LEGACY_UNCHANGED = [
  ["--color-bg", "#020617"],
  ["--color-surface", "#0f172a"],
  ["--color-surface-2", "#1e293b"],
  ["--color-border", "#1e293b"],
  ["--color-border-strong", "#334155"],
  ["--color-muted", "#94a3b8"],
  ["--color-positive", "#22c55e"],
  ["--color-negative", "#f87171"],
  ["--color-warning", "#fbbf24"],
  ["--color-info", "#38bdf8"],
];
for (const [token, value] of LEGACY_UNCHANGED) {
  check(css.includes(`${token}: ${value};`), `token legado INALTERADO: ${token} = ${value}`);
}
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
const CONTRAST_PAIRS = [
  ["text-primary/bg", "#f8fafc", "#020617"],
  ["text-secondary/surface-2", "#cbd5e1", "#1e293b"],
  ["text-muted/surface", "#94a3b8", "#0f172a"],
  ["accent-foreground/accent", "#1c1207", "#d99a3d"],
  ["danger/surface", "#f87171", "#0f172a"],
  ["warning/surface", "#fbbf24", "#0f172a"],
  ["restricted/surface", "#a78bda", "#0f172a"],
  ["positive/surface", "#22c55e", "#0f172a"],
];
for (const [label, a, b] of CONTRAST_PAIRS) {
  const ratio = contrast(a, b);
  check(ratio >= WCAG_AA_NORMAL, `contraste WCAG AA (>=4.5:1): ${label}`, `${ratio.toFixed(2)}:1`);
}

// ==========================================================================
// 4) NO_NEW_V1_CONSUMERS (item 4) — nenhum arquivo NOVO desta fase importa
//    lib/indicators.js ou lib/cashFlowProjection.js.
// ==========================================================================
const NEW_FILES_THIS_PHASE = [
  "lib/navConfig.js",
  "app/components/ui/Card.jsx",
  "app/components/ui/Button.jsx",
  "app/components/ui/Badge.jsx",
  "app/components/ui/Input.jsx",
  "app/components/ui/Select.jsx",
  "app/components/ui/PageContainer.jsx",
  "app/components/ui/index.js",
  "app/components/MobileNav.jsx",
  "app/components/NavBar.jsx",
  "app/layout.js",
  "app/login/page.js",
  "app/components/Skeleton.jsx",
];
for (const relPath of NEW_FILES_THIS_PHASE) {
  const content = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  const importsV1 = /lib\/indicators(\.js)?["']|lib\/cashFlowProjection(\.js)?["']/.test(content);
  check(!importsV1, `NO_NEW_V1_CONSUMERS: ${relPath} não importa nenhuma lib V1`);
}

// ==========================================================================
// 5) ONE TRUTH, ONE NAME — nenhum arquivo novo reintroduz vocabulário V1
//    ("Caixa livre"/"Patrimônio disponível") como copy de unrestrictedCash.
// ==========================================================================
for (const relPath of NEW_FILES_THIS_PHASE) {
  const content = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  check(!content.includes("Patrimônio disponível") && !content.includes("Caixa livre"), `ONE_TRUTH_ONE_NAME: ${relPath} não usa vocabulário V1`);
}

console.log(`\n${passed}/${passed + failed} teste(s) passaram.`);
if (failed > 0) process.exit(1);
