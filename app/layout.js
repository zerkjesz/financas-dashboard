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
        <div className="aurora-bg" aria-hidden="true">
          <span className="aurora-blob aurora-blob--emerald" />
          <span className="aurora-blob aurora-blob--sky" />
          <span className="aurora-blob aurora-blob--violet" />
        </div>
        <NavBar />
        {children}
      </body>
    </html>
  );
}
