import ContasAPagarView from "./ContasAPagarView.jsx";
import FluxoCaixaView from "../fluxo-caixa/FluxoCaixaView.jsx";

export default function Page() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-10">
      <ContasAPagarView />
      <FluxoCaixaView />
    </div>
  );
}
