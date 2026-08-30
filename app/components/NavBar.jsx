"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Início" },
  { href: "/cartoes", label: "Cartões & Parcelas" },
  { href: "/contas-a-pagar", label: "Contas & Fluxo" },
  { href: "/metas", label: "Metas & Indicadores" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0 cursor-pointer">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="10" width="4" height="11" rx="1" fill="#22c55e" />
            <rect x="10" y="5" width="4" height="16" rx="1" fill="#38bdf8" />
            <rect x="17" y="13" width="4" height="8" rx="1" fill="#f8fafc" fillOpacity="0.6" />
          </svg>
          <span className="font-semibold tracking-tight text-[15px]">Finanças</span>
        </Link>

        <nav className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  active ? "bg-surface-2 text-white" : "text-muted hover:text-white hover:bg-surface"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
