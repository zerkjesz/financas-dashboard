// Fase 5.4B, itens 29/30 — page container compartilhado. Extraído
// MECANICAMENTE das classes que já existiam repetidas em 4 das 5 páginas
// (Home/Cartões/Contas/Metas usavam literalmente "max-w-6xl mx-auto px-4
// sm:px-6 py-6 sm:py-8"; Simulador já era a exceção com max-w-4xl, seção 22
// da 5.4A) — ZERO mudança de classe resultante, só elimina a duplicação.
// Não decide nada de information architecture; isso é 5.4C/5.4D.
const MAX_WIDTH = {
  "4xl": "max-w-4xl",
  "6xl": "max-w-6xl",
};

export default function PageContainer({ maxWidth = "6xl", spaced = false, className = "", children, ...rest }) {
  // pt-6/sm:pt-8 == o antigo "py-6 sm:py-8" na borda de cima (sem mudança).
  // pb-* é NOVO (item 27): em telas <md o MobileNav fixo cobriria o fim da
  // página sem esse respiro extra; em md+ (sem bottom nav) volta ao mesmo
  // pb-8 de sempre — zero mudança visual em desktop. `...rest` repassa
  // aria-*/data-* de quem usa (ex: DashboardSkeleton's aria-busy).
  return (
    <div className={`${MAX_WIDTH[maxWidth]} mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-safe-bottom-nav md:pb-8 ${spaced ? "space-y-10" : ""} ${className}`} {...rest}>
      {children}
    </div>
  );
}
