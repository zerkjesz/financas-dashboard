import CartoesView from "./CartoesView.jsx";
import ParcelasView from "../parcelas/ParcelasView.jsx";

export default function Page() {
  return (
    <>
      <CartoesView />
      <hr className="border-white/10 max-w-5xl mx-auto" />
      <ParcelasView />
    </>
  );
}
