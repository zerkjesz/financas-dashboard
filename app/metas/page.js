import MetasView from "./MetasView.jsx";
import IndicadoresView from "../indicadores/IndicadoresView.jsx";
import PageContainer from "../components/ui/PageContainer.jsx";

export default function Page() {
  return (
    <PageContainer spaced>
      <MetasView />
      <IndicadoresView />
    </PageContainer>
  );
}
