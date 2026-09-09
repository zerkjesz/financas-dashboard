"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NAV_ITEMS, isNavItemActive } from "@/lib/navConfig";

// Fase 5.4B, itens 23/28 — NavBar agora é DESKTOP-ONLY (`hidden md:block`);
// mobile usa MobileNav.jsx (bottom nav + "Mais"), que resolve o achado
// crítico da Fase 5.4A (itens cortados sem affordance de overflow). Nenhuma
// mudança de arquitetura financeira — mesmas 5 rotas de sempre, só
// centralizadas em lib/navConfig.js em vez de um array local duplicado.
export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  // Fase 5.3C, item 21 — logout mínimo, sem redesign. Não mostrado na própria
  // tela de login (não faz sentido "sair" de onde já não se está logado).
  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (pathname === "/login") return null;

  return (
    <header className="hidden md:block sticky top-0 z-20 border-b border-border-subtle bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
        <Link href="/" className="focus-ring flex items-center gap-2 shrink-0 cursor-pointer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="10" width="4" height="11" rx="1" fill="#22c55e" />
            <rect x="10" y="5" width="4" height="16" rx="1" fill="#38bdf8" />
            <rect x="17" y="13" width="4" height="8" rx="1" fill="#f8fafc" fillOpacity="0.6" />
          </svg>
          <span className="text-card-title text-text-primary">Finanças</span>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => {
            const active = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`focus-ring whitespace-nowrap rounded-control px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  // Fase 5.4B, item 42 — estado ativo nunca só por cor: peso de
                  // fonte muda junto (font-semibold vs font-medium).
                  active ? "bg-surface-2 text-text-primary font-semibold" : "text-text-muted font-medium hover:text-text-primary hover:bg-surface-1"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <button onClick={handleLogout} className="focus-ring ml-auto shrink-0 rounded-control px-2 py-1 text-sm text-text-muted hover:text-text-primary transition-colors cursor-pointer">
          Sair
        </button>
      </div>
    </header>
  );
}
