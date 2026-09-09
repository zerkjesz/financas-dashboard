import { Home, CreditCard, Wallet, Sparkles, Target } from "lucide-react";

// ============================================================================
// Fase 5.4B, itens 28/24 — configuração de navegação CENTRALIZADA, consumida
// tanto pelo NavBar (desktop) quanto pelo MobileNav (bottom nav + "Mais").
// Puramente estrutural — NUNCA cálculo financeiro aqui (item 28, explícito).
// `href` sempre aponta pra uma rota que já existe hoje; nenhuma rota nova
// (Compromissos/Fluxo/Histórico da 5.4D) é antecipada nesta fase.
//
// `mobilePriority: true` = aparece direto na bottom nav (item 24, decisão
// final: Hoje/Cartão/Contas/Simulador). `false` = vive dentro de "Mais".
// ============================================================================
export const NAV_ITEMS = [
  { key: "home", label: "Início", mobileLabel: "Hoje", href: "/", icon: Home, mobilePriority: true },
  { key: "cartoes", label: "Cartões & Parcelas", mobileLabel: "Cartão", href: "/cartoes", icon: CreditCard, mobilePriority: true },
  { key: "contas", label: "Contas & Fluxo", mobileLabel: "Contas", href: "/contas-a-pagar", icon: Wallet, mobilePriority: true },
  { key: "simulador", label: "Simulador", mobileLabel: "Simular", href: "/simulador", icon: Sparkles, mobilePriority: true },
  { key: "metas", label: "Metas & Indicadores", mobileLabel: "Metas", href: "/metas", icon: Target, mobilePriority: false },
];

export const MOBILE_PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.mobilePriority);
export const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => !item.mobilePriority);

// isActive: mesma regra usada hoje no NavBar — "/" exige match exato, o
// resto usa startsWith (uma sub-rota de /cartoes continua marcando Cartão
// como ativo).
export function isNavItemActive(item, pathname) {
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
