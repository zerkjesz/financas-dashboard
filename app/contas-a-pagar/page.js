import ContasAPagarView from "./ContasAPagarView.jsx";
import FluxoCaixaView from "../fluxo-caixa/FluxoCaixaView.jsx";

export default function Page() {
  return (
    <>
      <ContasAPagarView />
      <hr className="border-white/10 max-w-5xl mx-auto" />
      <FluxoCaixaView />
    </>
  );
}
