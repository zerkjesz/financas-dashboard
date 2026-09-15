import "./globals.css";
import NavBar from "./components/NavBar.jsx";
import MobileNav from "./components/MobileNav.jsx";

export const metadata = {
  title: "Norte",
  description: "Gestor financeiro pessoal",
};

// viewport-fit=cover ativa env(safe-area-inset-*) em dispositivos com home
// indicator — sem isso, o MobileNav fixo poderia ficar colado na borda
// física da tela.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Fase 6.0 (Design Freeze) — shell da referência aprovada: sidebar fixa
// (224px, desktop) + coluna de conteúdo. `<main>` centraliza o conteúdo até
// 1120px dentro do espaço restante (ver PageContainer.jsx) — a própria
// sidebar não empurra o conteúdo com margin, ela é uma coluna flex irmã.
export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className="flex min-h-screen bg-bg text-text-primary">
        <NavBar />
        <main className="min-w-0 flex-1">{children}</main>
        <MobileNav />
      </body>
    </html>
  );
}
