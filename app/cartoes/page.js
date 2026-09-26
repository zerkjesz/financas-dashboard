import PageContainer from "../components/ui/PageContainer.jsx";
import CartoesV5 from "../components/v5/CartoesV5.jsx";

// Fase 10 — Cartões v5 (protótipo aprovado): Itaú + Caju. Dados reais via /api/cartoes (somente leitura).
export const metadata = { title: "Cartões · Norte" };
export default function CartoesPage() {
  return (
    <PageContainer>
      <CartoesV5 />
    </PageContainer>
  );
}
