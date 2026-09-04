import MetasView from "./MetasView.jsx";
import IndicadoresView from "../indicadores/IndicadoresView.jsx";

export default function Page() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-10">
      <MetasView />
      <IndicadoresView />
    </div>
  );
}
