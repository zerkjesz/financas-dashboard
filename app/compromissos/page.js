import PageContainer from "../components/ui/PageContainer.jsx";
import CompromissosV4 from "../components/v4/CompromissosV4.jsx";

// Fase 9.1 — Compromissos v4 (protótipo aprovado). Dados reais via /api/compromissos (somente leitura).
export const metadata = { title: "Compromissos · Norte" };
export default function CompromissosPage() {
  return (
    <PageContainer>
      <CompromissosV4 />
    </PageContainer>
  );
}
