"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { NAV_ITEMS, MOBILE_PRIMARY_ITEMS, MOBILE_MORE_ITEMS, isNavItemActive } from "@/lib/navConfig";

// Fase 5.4B, itens 23/28 — NavBar agora é DESKTOP-ONLY (`hidden md:block`);
// mobile usa MobileNav.jsx (bottom nav + "Mais"), que resolve o achado
// crítico da Fase 5.4A (itens cortados sem affordance de overflow). Nenhuma
// mudança de arquitetura financeira — mesmas 5 rotas de sempre, só
// centralizadas em lib/navConfig.js em vez de um array local duplicado.
function navLinkClass(active) {
  return `focus-ring whitespace-nowrap rounded-control px-3 py-1.5 text-sm transition-colors cursor-pointer ${
    // Fase 5.4B, item 42 — estado ativo nunca só por cor: peso de fonte muda junto.
    active ? "bg-surface-2 text-text-primary font-semibold" : "text-text-muted font-medium hover:text-text-primary hover:bg-surface-1"
  }`;
}

// Fase 5.4D, item 6 — o nav ganhou 2 rotas novas (Compromissos/Fluxo/
// Histórico) desde a 5.4C.2; o mesmo aperto de espaçamento que resolveu o
// overflow de 768px com 5 itens não sobra o suficiente com 7. Em vez de
// espremer o espaçamento até ficar ilegível de novo, reaproveita a MESMA
// priorização já definida em lib/navConfig.js pro bottom nav mobile
// (MOBILE_PRIMARY_ITEMS/MOBILE_MORE_ITEMS) — na faixa estreita (768-1023,
// "md" mas não "lg") mostra só os 4 primários + um dropdown "Mais"; a partir
// de `lg` (1024px+, já verificado sem overflow) mostra os 7 completos numa
// linha só. Uma arquitetura de informação, duas apresentações.
function MoreDropdown({ pathname }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const buttonRef = useRef(null);
  const active = MOBILE_MORE_ITEMS.some((item) => isNavItemActive(item, pathname));

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onClickOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onClickOutside);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`${navLinkClass(active)} inline-flex items-center gap-1`}
      >
        Mais
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 min-w-[180px] rounded-control border border-border-subtle bg-surface-2 p-1 shadow-lg">
          {MOBILE_MORE_ITEMS.map((item) => {
            const itemActive = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                role="menuitem"
                aria-current={itemActive ? "page" : undefined}
                className={`focus-ring block rounded-control px-3 py-2 text-sm transition-colors ${
                  itemActive ? "bg-surface-3 text-text-primary font-semibold" : "text-text-secondary font-medium hover:bg-surface-3"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3 lg:gap-6">
        <Link href="/" className="focus-ring flex items-center gap-2 shrink-0 cursor-pointer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="10" width="4" height="11" rx="1" fill="#22c55e" />
            <rect x="10" y="5" width="4" height="16" rx="1" fill="#38bdf8" />
            <rect x="17" y="13" width="4" height="8" rx="1" fill="#f8fafc" fillOpacity="0.6" />
          </svg>
          <span className="text-card-title text-text-primary">Finanças</span>
        </Link>

        {/* 768-1023 ("md" sem "lg"): só os 4 primários + Mais. */}
        <nav className="flex lg:hidden items-center gap-0.5" aria-label="Navegação principal">
          {MOBILE_PRIMARY_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} aria-current={isNavItemActive(item, pathname) ? "page" : undefined} className={navLinkClass(isNavItemActive(item, pathname))}>
              {item.label}
            </Link>
          ))}
          <MoreDropdown pathname={pathname} />
        </nav>

        {/* 1024px+ ("lg"): os 7 itens completos numa linha só (verificado sem overflow). */}
        <nav className="hidden lg:flex items-center gap-1" aria-label="Navegação principal">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} aria-current={isNavItemActive(item, pathname) ? "page" : undefined} className={navLinkClass(isNavItemActive(item, pathname))}>
              {item.label}
            </Link>
          ))}
        </nav>

        <button onClick={handleLogout} className="focus-ring ml-auto shrink-0 rounded-control px-2 py-1 text-sm text-text-muted hover:text-text-primary transition-colors cursor-pointer">
          Sair
        </button>
      </div>
    </header>
  );
}
