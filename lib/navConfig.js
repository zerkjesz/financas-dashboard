import { Home, CreditCard, ListChecks, Sparkles, TrendingUp, History, Target } from "lucide-react";

// ============================================================================
// Fase 5.4B, itens 28/24 — configuração de navegação CENTRALIZADA, consumida
// tanto pelo NavBar (desktop) quanto pelo MobileNav (bottom nav + "Mais").
// Puramente estrutural — NUNCA cálculo financeiro aqui (item 28, explícito).
//
// Fase 5.4D, item 6 — arquitetura de página real: "Contas & Fluxo" (uma rota
// que fazia CRUD de contas E projeção de caixa no mesmo lugar) se divide em
// duas tarefas distintas — Compromissos (o que devo, quando, com que certeza
// — CRUD de Bill continua aqui) e Fluxo (só exploração/projeção, não
// gerencia nada). Histórico ganha rota própria (a tabela que saiu da Home na
// 5.4C finalmente tem dono). Bottom nav continua em NO MÁXIMO 5 slots (item
// 6, explícito: "não enfiar 7 itens") — target conceitual Hoje/Cartão/
// Compromissos/Simular/Mais, com Fluxo/Histórico/Metas dentro de "Mais".
// Metas sai do bottom nav primário (só cabiam 4 + Mais) — não é remoção,
// é realocação: continua 1 clique de distância, só que dentro do menu.
// ============================================================================
export const NAV_ITEMS = [
  { key: "home", label: "Início", mobileLabel: "Hoje", href: "/", icon: Home, mobilePriority: true },
  { key: "cartoes", label: "Cartão", mobileLabel: "Cartão", href: "/cartoes", icon: CreditCard, mobilePriority: true },
  { key: "compromissos", label: "Compromissos", mobileLabel: "A pagar", href: "/compromissos", icon: ListChecks, mobilePriority: true },
  { key: "simulador", label: "Simulador", mobileLabel: "Simular", href: "/simulador", icon: Sparkles, mobilePriority: true },
  { key: "fluxo", label: "Fluxo", mobileLabel: "Fluxo", href: "/fluxo", icon: TrendingUp, mobilePriority: false },
  { key: "historico", label: "Histórico", mobileLabel: "Histórico", href: "/historico", icon: History, mobilePriority: false },
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
