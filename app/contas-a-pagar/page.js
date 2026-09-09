import ContasAPagarView from "./ContasAPagarView.jsx";
import FluxoCaixaView from "../fluxo-caixa/FluxoCaixaView.jsx";
import PageContainer from "../components/ui/PageContainer.jsx";

export default function Page() {
  return (
    <PageContainer spaced>
      <ContasAPagarView />
      <FluxoCaixaView />
    </PageContainer>
  );
}
