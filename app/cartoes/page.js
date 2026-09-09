import CartoesView from "./CartoesView.jsx";
import ParcelasView from "../parcelas/ParcelasView.jsx";
import PageContainer from "../components/ui/PageContainer.jsx";

export default function Page() {
  return (
    <PageContainer spaced>
      <CartoesView />
      <ParcelasView />
    </PageContainer>
  );
}
