import "./globals.css";
import NavBar from "./components/NavBar.jsx";

export const metadata = {
  title: "Finanças",
  description: "Gestor financeiro pessoal",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
