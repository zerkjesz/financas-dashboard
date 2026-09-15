// Fase 6.0 (Design Freeze) — page container. `content` (nova, 1120px — a
// largura da coluna de conteúdo na referência aprovada, ao lado da sidebar
// de 224px) é o default agora; `4xl`/`6xl` preservados pra quem ainda usa
// (ex: Simulador, mais estreito de propósito).
const MAX_WIDTH = {
  "4xl": "max-w-4xl",
  "6xl": "max-w-6xl",
  content: "max-w-[70rem]",
};

export default function PageContainer({ maxWidth = "content", spaced = false, className = "", children, ...rest }) {
  // pb-safe-bottom-nav: em <md o MobileNav fixo cobriria o fim da página sem
  // esse respiro; em md+ (sidebar, sem bottom nav) volta ao pb-8 normal.
  return (
    <div className={`${MAX_WIDTH[maxWidth]} mx-auto px-4 sm:px-6 md:pl-2 md:pr-6 pt-8 pb-safe-bottom-nav md:pb-10 ${spaced ? "space-y-10" : ""} ${className}`} {...rest}>
      {children}
    </div>
  );
}
