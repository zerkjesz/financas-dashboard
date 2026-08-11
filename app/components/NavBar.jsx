"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/contas-a-pagar", label: "Contas a Pagar" },
  { href: "/cartoes", label: "Cartões" },
  { href: "/parcelas", label: "Parcelas" },
  { href: "/fluxo-caixa", label: "Fluxo de Caixa" },
  { href: "/vale-alimentacao", label: "Vale Alimentação" },
  { href: "/metas", label: "Metas" },
  { href: "/indicadores", label: "Indicadores" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-white/10 bg-white/[0.02]">
      <div className="max-w-5xl mx-auto px-4 flex items-center gap-1 overflow-x-auto">
        {LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap px-3 py-3 text-sm border-b-2 transition-colors ${
                active
                  ? "border-emerald-500 text-white"
                  : "border-transparent text-white/50 hover:text-white/80"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
