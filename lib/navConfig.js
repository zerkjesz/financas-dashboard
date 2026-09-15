import { Home, CreditCard, ListChecks, SlidersHorizontal, TrendingUp, History, Target, Database } from "lucide-react";

// ============================================================================
// Fase 6.0 (Design Freeze) — navegação CENTRALIZADA, consumida pelo NavBar
// (sidebar desktop) e pelo MobileNav (dock + "Mais"). Puramente estrutural —
// nunca cálculo financeiro aqui.
//
// Ordem e rótulos vêm do ZIP aprovado (Norte-standalone-src.html, navDefs):
// Hoje / Cartão / Compromissos / Simulador / Projeção / Histórico / Metas /
// Dados. "Fluxo" foi renomeado pra "Projeção" (nome final do design
// aprovado). "Dados" é a nova área (Fase 6.0). "Estados" (showcase de
// design-system do protótipo) e o atalho de Login dentro do app NÃO são
// portados — são ferramentas internas do Claude Design, não superfície de
// produto.
//
// Mobile dock (bottom nav) usa só os 4 primeiros + "Mais" (label/ícone
// próprios no MobileNav) — igual à Fase 5.4D, agora com Dados dentro de
// "Mais" também. Rótulos mobile do dock diferem levemente do desktop
// (ZIP: "A pagar"/"Simular" no dock vs. "Compromissos"/"Simulador" na
// sidebar) — normalizado aqui como mobileLabel dedicado, igual já era.
// ============================================================================
export const NAV_ITEMS = [
  { key: "home", label: "Hoje", mobileLabel: "Hoje", href: "/", icon: Home, mobilePriority: true },
  { key: "cartoes", label: "Cartão", mobileLabel: "Cartão", href: "/cartoes", icon: CreditCard, mobilePriority: true },
  { key: "compromissos", label: "Compromissos", mobileLabel: "A pagar", href: "/compromissos", icon: ListChecks, mobilePriority: true },
  { key: "simulador", label: "Simulador", mobileLabel: "Simular", href: "/simulador", icon: SlidersHorizontal, mobilePriority: true },
  { key: "projecao", label: "Projeção", mobileLabel: "Projeção", href: "/projecao", icon: TrendingUp, mobilePriority: false, sheetDescription: "Os próximos 30, 60 e 90 dias" },
  { key: "historico", label: "Histórico", mobileLabel: "Histórico", href: "/historico", icon: History, mobilePriority: false, sheetDescription: "Tudo que já passou" },
  { key: "metas", label: "Metas", mobileLabel: "Metas", href: "/metas", icon: Target, mobilePriority: false, sheetDescription: "Para onde o dinheiro está indo" },
  { key: "dados", label: "Dados", mobileLabel: "Dados", href: "/dados", icon: Database, mobilePriority: false, sheetDescription: "Exportar e importar planilhas" },
];

export const MOBILE_PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.mobilePriority);
export const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => !item.mobilePriority);

// isActive: "/" exige match exato, o resto usa startsWith (uma sub-rota
// continua marcando o item pai como ativo).
export function isNavItemActive(item, pathname) {
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
