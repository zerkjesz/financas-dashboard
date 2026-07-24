import "./globals.css";

export const metadata = {
  title: "Finanças",
  description: "Dashboard de gastos e receitas pessoais",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
