"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, LogOut } from "lucide-react";
import { MOBILE_PRIMARY_ITEMS, MOBILE_MORE_ITEMS, isNavItemActive } from "@/lib/navConfig";

// Fase 5.4B, itens 24/25/26 — MOBILE PRIMARY NAV = bottom nav + "Mais".
// Decisão final do pedido (não horizontal-scroll, não hamburger sozinho):
// discoverability alta (5 alvos sempre visíveis, nenhum cortado — resolve o
// achado crítico da Fase 5.4A), sem esconder toda a navegação atrás de um
// menu só. "Mais" abre uma folha compacta com os itens secundários (hoje só
// Metas) + Sair — nunca um app de configurações em tela cheia (item 25).
export default function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef(null);
  const moreButtonRef = useRef(null);

  useEffect(() => {
    if (!moreOpen) return;
    function onKeyDown(e) {
      if (e.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    // Foco entra na folha ao abrir (item 39 — teclado/acessibilidade).
    sheetRef.current?.querySelector("a,button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

  // Fecha a folha automaticamente ao navegar (evita ficar aberta sobre a
  // página seguinte).
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  if (pathname === "/login") return null;

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const moreActive = MOBILE_MORE_ITEMS.some((item) => isNavItemActive(item, pathname));

  return (
    <>
      {moreOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMoreOpen(false)}
          aria-hidden="true"
        />
      )}

      {moreOpen && (
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label="Mais opções"
          className="md:hidden fixed bottom-16 left-0 right-0 z-40 mx-3 mb-2 rounded-card border border-border-subtle bg-surface-2 p-2 safe-area-bottom shadow-lg"
        >
          {MOBILE_MORE_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`focus-ring flex items-center gap-3 rounded-control px-3 py-2.5 text-sm transition-colors ${
                  active ? "bg-surface-3 text-text-primary font-semibold" : "text-text-secondary font-medium hover:bg-surface-3"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={handleLogout}
            className="focus-ring flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm font-medium text-text-secondary hover:bg-surface-3 transition-colors cursor-pointer"
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
            Sair
          </button>
        </div>
      )}

      <nav
        aria-label="Navegação principal"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 border-t border-border-subtle bg-surface-1/95 backdrop-blur supports-[backdrop-filter]:bg-surface-1/80 safe-area-bottom"
      >
        <div className="grid h-16 grid-cols-5">
          {MOBILE_PRIMARY_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`focus-ring flex flex-col items-center justify-center gap-1 text-[11px] transition-colors ${
                  active ? "text-accent font-semibold" : "text-text-muted font-medium"
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {item.mobileLabel}
              </Link>
            );
          })}
          <button
            ref={moreButtonRef}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            className={`focus-ring flex flex-col items-center justify-center gap-1 text-[11px] transition-colors cursor-pointer ${
              moreOpen || moreActive ? "text-accent font-semibold" : "text-text-muted font-medium"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            Mais
          </button>
        </div>
      </nav>
    </>
  );
}
