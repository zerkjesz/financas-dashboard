import "./globals.css";
import NavBar from "./components/NavBar.jsx";
import MobileNav from "./components/MobileNav.jsx";

export const metadata = {
  title: "Finanças",
  description: "Gestor financeiro pessoal",
};

// Fase 5.4B, item 27 — viewport-fit=cover é o que ativa env(safe-area-inset-*)
// em dispositivos com home indicator; sem isso, o MobileNav fixo poderia
// ficar colado na borda física da tela.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className="bg-bg text-[#f8fafc] min-h-screen">
        <NavBar />
        {children}
        <MobileNav />
      </body>
    </html>
  );
}
