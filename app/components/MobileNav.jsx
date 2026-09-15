"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, LogOut, ChevronRight, X } from "lucide-react";
import { MOBILE_PRIMARY_ITEMS, MOBILE_MORE_ITEMS, isNavItemActive } from "@/lib/navConfig";

// Fase 6.0 (Design Freeze) — dock inferior + folha "Mais do Norte", visual
// da referência aprovada (pill escura no item ativo, folha com drag-handle
// e descrição por item). Lógica de foco/teclado/logout preservada
// integralmente da fundação anterior (5.4B) — só a apresentação mudou.
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
    sheetRef.current?.querySelector("a,button")?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

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
          className="md:hidden fixed inset-0 z-40 bg-ink/45 animate-scrim"
          onClick={() => setMoreOpen(false)}
          aria-hidden="true"
        />
      )}

      {moreOpen && (
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label="Mais do Norte"
          className="md:hidden fixed inset-x-0 bottom-0 z-40 animate-sheet-up rounded-t-[28px] bg-surface shadow-sheet"
          style={{ borderBottomLeftRadius: "48px", borderBottomRightRadius: "48px" }}
        >
          <div className="flex flex-col items-center pt-3 pb-1">
            <span className="h-1 w-10 rounded-pill bg-gray-2" aria-hidden="true" />
          </div>
          <div className="flex items-center justify-between px-5 pt-2 pb-3">
            <h2 className="text-card-title text-text-primary">Mais do Norte</h2>
            <button
              onClick={() => setMoreOpen(false)}
              className="focus-ring flex items-center gap-1 rounded-control px-2 py-1 text-sm text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            >
              Fechar
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="px-3 pb-3 safe-area-bottom">
            {MOBILE_MORE_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = isNavItemActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`focus-ring flex items-center gap-3 rounded-control px-3 py-3 text-sm transition-colors pointer-coarse:min-h-11 ${
                    active ? "bg-ink text-white" : "text-text-primary hover:bg-chip-bg"
                  }`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile ${active ? "bg-accent/16 text-accent" : "bg-chip-bg text-text-secondary"}`}>
                    <Icon className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-semibold">{item.label}</span>
                    {item.sheetDescription && (
                      <span className={`block truncate text-xs font-normal ${active ? "text-white/66" : "text-text-muted"}`}>{item.sheetDescription}</span>
                    )}
                  </span>
                  <ChevronRight className={`h-4 w-4 shrink-0 ${active ? "text-white/50" : "text-text-muted"}`} aria-hidden="true" />
                </Link>
              );
            })}
            <button
              onClick={handleLogout}
              className="focus-ring mt-1 flex w-full items-center gap-3 rounded-control px-3 py-3 text-left text-sm font-medium text-text-secondary hover:bg-chip-bg transition-colors cursor-pointer pointer-coarse:min-h-11"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-chip-bg text-text-secondary">
                <LogOut className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
              </span>
              Sair
            </button>
          </div>
        </div>
      )}

      <nav
        aria-label="Navegação principal"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-border-subtle bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 safe-area-bottom"
      >
        <div className="grid grid-cols-5 gap-1 px-2 py-2">
          {MOBILE_PRIMARY_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className="focus-ring flex flex-col items-center justify-center gap-1 py-1"
              >
                <span className={`flex h-[26px] w-[38px] items-center justify-center rounded-pill transition-colors ${active ? "bg-ink" : ""}`}>
                  <Icon className={`h-[18px] w-[18px] ${active ? "text-accent" : "text-text-muted"}`} aria-hidden="true" strokeWidth={1.8} />
                </span>
                <span className={`text-[10.5px] ${active ? "font-semibold text-text-primary" : "font-medium text-text-muted"}`}>{item.mobileLabel}</span>
              </Link>
            );
          })}
          <button
            ref={moreButtonRef}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            className="focus-ring flex flex-col items-center justify-center gap-1 py-1 cursor-pointer"
          >
            <span className={`flex h-[26px] w-[38px] items-center justify-center rounded-pill transition-colors ${moreOpen || moreActive ? "bg-ink" : ""}`}>
              <MoreHorizontal className={`h-[18px] w-[18px] ${moreOpen || moreActive ? "text-accent" : "text-text-muted"}`} aria-hidden="true" strokeWidth={1.8} />
            </span>
            <span className={`text-[10.5px] ${moreOpen || moreActive ? "font-semibold text-text-primary" : "font-medium text-text-muted"}`}>Mais</span>
          </button>
        </div>
      </nav>
    </>
  );
}
