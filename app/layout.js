import "./globals.css";
import NavBar from "./components/NavBar.jsx";

export const metadata = {
  title: "Finanças",
  description: "Gestor financeiro pessoal",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className="bg-bg text-[#f8fafc] min-h-screen">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
