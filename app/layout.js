import "./globals.css";

export const metadata = {
  title: "Finanças",
  description: "Dashboard de gastos e receitas pessoais",
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
        {children}
      </body>
    </html>
  );
}
