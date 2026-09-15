"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { NAV_ITEMS, isNavItemActive } from "@/lib/navConfig";

// Fase 6.0 (Design Freeze) — NavBar deixa de ser uma barra horizontal no
// topo e passa a ser a SIDEBAR fixa da referência aprovada (ZIP): 224px de
// largura, marca no topo, nav vertical, usuário/sair no rodapé. Desktop-only
// (`hidden md:flex`) — mobile usa MobileNav.jsx (dock + "Mais"), inalterado
// na responsabilidade, só no visual.
//
// Sem o "Ver no celular"/"Ver no desktop" do protótipo: aquilo era um toggle
// de PREVIEW do Claude Design (troca de árvore de markup, não breakpoint de
// verdade — ver auditoria do ZIP). O Norte real é responsivo de verdade via
// CSS — não existe um "modo mobile" pra alternar manualmente.
export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (pathname === "/login") return null;

  return (
    <aside className="hidden md:flex md:w-56 md:shrink-0 md:flex-col md:h-screen md:sticky md:top-0 gap-8 py-7 pl-6 pr-4">
      {/* Brand lockup — quadrado escuro com notch lime rotacionado 45°. */}
      <Link href="/" className="focus-ring flex items-center gap-2.5 shrink-0 cursor-pointer">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-ink" aria-hidden="true">
          <span className="h-2 w-2 rotate-45 bg-accent" />
        </span>
        <span className="text-[1.1875rem] font-semibold tracking-tight text-ink">Norte</span>
      </Link>

      <nav aria-label="Navegação principal" className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isNavItemActive(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`focus-ring flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-ink text-white font-semibold shadow-nav-active cursor-default"
                  : "text-text-secondary font-medium hover:bg-ink/[0.055] hover:text-ink cursor-pointer"
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${active ? "text-accent" : ""}`} aria-hidden="true" strokeWidth={1.8} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Usuário + sair — empurrado pro rodapé (mt-auto). */}
      <div className="mt-auto flex items-center gap-2.5 px-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-accent" aria-hidden="true">
          N
        </span>
        <span className="flex-1 truncate text-sm text-text-secondary">Norte</span>
        <button
          onClick={handleLogout}
          className="focus-ring shrink-0 rounded-control p-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors cursor-pointer"
          aria-label="Sair"
          title="Sair"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
}
