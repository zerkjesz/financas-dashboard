import PageContainer from "./components/ui/PageContainer.jsx";
import HomeV4 from "./components/v4/HomeV4.jsx";

// Fase 9.1 — Home v4 (protótipo aprovado). Dados reais via /api/home (somente leitura).
export const metadata = { title: "Hoje · Norte" };
export default function Page() {
  return (
    <PageContainer>
      <HomeV4 />
    </PageContainer>
  );
}
